/**
 * エージェント設定関数のユニットテスト
 * configureClaude / configureCopilot / configureCodex
 */

import { assertEquals } from "@std/assert";
import { configureClaude, resolveClaudeProbes } from "./claude.ts";
import type { ClaudeProbes } from "./claude.ts";
import {
  configureCopilot,
  resolveCopilotProbes,
} from "./copilot.ts";
import type { CopilotProbes } from "./copilot.ts";
import { configureCodex, resolveCodexProbes } from "./codex.ts";
import type { CodexProbes } from "./codex.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import type { Config, Profile } from "../config/types.ts";

const baseProfile: Profile = {
  agent: "claude",
  agentArgs: [],
  nix: { enable: false, mountSocket: false, extraPackages: [] },
  docker: { enable: false, shared: false },
  gcloud: { mountConfig: false },
  aws: { mountConfig: false },
  gpg: { forwardAgent: false },
  display: structuredClone(DEFAULT_DISPLAY_CONFIG),
  network: structuredClone(DEFAULT_NETWORK_CONFIG),
  dbus: structuredClone(DEFAULT_DBUS_CONFIG),
  extraMounts: [],
  env: [],
};

const baseConfig: Config = {
  default: "test",
  profiles: { test: baseProfile },
  ui: DEFAULT_UI_CONFIG,
};

function getContainerHome(): string {
  const user = Deno.env.get("USER")?.trim();
  return `/home/${user || "nas"}`;
}

// ============================================================
// テスト用ヘルパー
// ============================================================

/** 一時的に HOME を差し替えてテストを実行する */
async function withTempHome(
  fn: (tmpHome: string) => Promise<void> | void,
): Promise<void> {
  const origHome = Deno.env.get("HOME");
  const tmpHome = await Deno.makeTempDir({ prefix: "nas-test-home-" });
  try {
    Deno.env.set("HOME", tmpHome);
    await fn(tmpHome);
  } finally {
    if (origHome !== undefined) Deno.env.set("HOME", origHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpHome, { recursive: true }).catch(() => {});
  }
}

/** 一時的に PATH 上にダミーバイナリを配置してテストを実行する */
async function withFakeBinary(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  const origPath = Deno.env.get("PATH");
  const tmpBinDir = await Deno.makeTempDir({ prefix: "nas-test-bin-" });
  try {
    await Deno.writeTextFile(`${tmpBinDir}/${name}`, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(`${tmpBinDir}/${name}`, 0o755);
    Deno.env.set("PATH", `${tmpBinDir}:${origPath ?? ""}`);
    await fn();
  } finally {
    if (origPath !== undefined) Deno.env.set("PATH", origPath);
    else Deno.env.delete("PATH");
    await Deno.remove(tmpBinDir, { recursive: true }).catch(() => {});
  }
}

/** PATH から指定バイナリを除外してテストを実行する */
async function withoutBinary(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  const origPath = Deno.env.get("PATH");
  const filteredPath = (origPath ?? "").split(":").filter((dir) => {
    try {
      Deno.statSync(`${dir}/${name}`);
      return false;
    } catch {
      return true;
    }
  }).join(":");
  Deno.env.set("PATH", filteredPath);
  try {
    await fn();
  } finally {
    if (origPath !== undefined) Deno.env.set("PATH", origPath);
    else Deno.env.delete("PATH");
  }
}

// ============================================================
// configureClaude (pure function tests)
// ============================================================

Deno.test("configureClaude: sets PATH with .local/bin prepended", () => {
  const containerHome = "/home/testuser";
  const probes: ClaudeProbes = {
    claudeDirExists: false,
    claudeJsonExists: false,
    claudeBinPath: null,
  };
  const result = configureClaude({
    containerHome,
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  assertEquals(
    result.envVars["PATH"]?.startsWith(`${containerHome}/.local/bin:`),
    true,
    `PATH should start with ${containerHome}/.local/bin:`,
  );
});

Deno.test("configureClaude: mounts ~/.claude when directory exists", () => {
  const containerHome = "/home/testuser";
  const hostHome = "/home/host";
  const probes: ClaudeProbes = {
    claudeDirExists: true,
    claudeJsonExists: false,
    claudeBinPath: null,
  };
  const result = configureClaude({
    containerHome,
    hostHome,
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  const mountArg = `${hostHome}/.claude:${containerHome}/.claude`;
  assertEquals(
    result.dockerArgs.includes(mountArg),
    true,
    `dockerArgs should contain ${mountArg}`,
  );
});

Deno.test("configureClaude: does not mount ~/.claude when directory is absent", () => {
  const containerHome = "/home/testuser";
  const probes: ClaudeProbes = {
    claudeDirExists: false,
    claudeJsonExists: false,
    claudeBinPath: null,
  };
  const result = configureClaude({
    containerHome,
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  const hasClaudeMount = result.dockerArgs.some((a) => a.includes("/.claude"));
  assertEquals(hasClaudeMount, false);
});

Deno.test("configureClaude: mounts ~/.claude.json when file exists", () => {
  const containerHome = "/home/testuser";
  const hostHome = "/home/host";
  const probes: ClaudeProbes = {
    claudeDirExists: false,
    claudeJsonExists: true,
    claudeBinPath: null,
  };
  const result = configureClaude({
    containerHome,
    hostHome,
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  const mountArg = `${hostHome}/.claude.json:${containerHome}/.claude.json`;
  assertEquals(
    result.dockerArgs.includes(mountArg),
    true,
    `dockerArgs should contain ${mountArg}`,
  );
});

Deno.test("configureClaude: does not mount ~/.claude.json when file is absent", () => {
  const containerHome = "/home/testuser";
  const probes: ClaudeProbes = {
    claudeDirExists: false,
    claudeJsonExists: false,
    claudeBinPath: null,
  };
  const result = configureClaude({
    containerHome,
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  const hasMount = result.dockerArgs.some((a) => a.includes(".claude.json"));
  assertEquals(hasMount, false);
});

Deno.test("configureClaude: mounts binary and uses ['claude'] when binary found", () => {
  const containerHome = "/home/testuser";
  const probes: ClaudeProbes = {
    claudeDirExists: false,
    claudeJsonExists: false,
    claudeBinPath: "/usr/bin/claude",
  };
  const result = configureClaude({
    containerHome,
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  assertEquals(result.agentCommand, ["claude"]);
  const hasBinaryMount = result.dockerArgs.some((a) =>
    a.endsWith("/claude:ro")
  );
  assertEquals(hasBinaryMount, true, "should mount claude binary");
});

Deno.test("configureClaude: uses install script when claude binary not found", () => {
  const probes: ClaudeProbes = {
    claudeDirExists: false,
    claudeJsonExists: false,
    claudeBinPath: null,
  };
  const result = configureClaude({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  assertEquals(result.agentCommand[0], "bash");
  assertEquals(result.agentCommand[1], "-c");
  assertEquals(result.agentCommand[2]?.includes("install.sh"), true);
});

Deno.test("configureClaude: preserves existing dockerArgs", () => {
  const probes: ClaudeProbes = {
    claudeDirExists: false,
    claudeJsonExists: false,
    claudeBinPath: null,
  };
  const result = configureClaude({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: ["--existing", "arg"],
    priorEnvVars: {},
  });
  assertEquals(result.dockerArgs[0], "--existing");
  assertEquals(result.dockerArgs[1], "arg");
});

Deno.test("configureClaude: preserves existing envVars", () => {
  const probes: ClaudeProbes = {
    claudeDirExists: false,
    claudeJsonExists: false,
    claudeBinPath: null,
  };
  const result = configureClaude({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: { EXISTING: "value" },
  });
  assertEquals(result.envVars["EXISTING"], "value");
});

// ============================================================
// resolveClaudeProbes (integration with filesystem)
// ============================================================

Deno.test("resolveClaudeProbes: detects existing ~/.claude directory", async () => {
  await withTempHome(async (tmpHome) => {
    await Deno.mkdir(`${tmpHome}/.claude`, { recursive: true });
    const probes = resolveClaudeProbes(tmpHome);
    assertEquals(probes.claudeDirExists, true);
  });
});

Deno.test("resolveClaudeProbes: detects missing ~/.claude directory", async () => {
  await withTempHome((tmpHome) => {
    const probes = resolveClaudeProbes(tmpHome);
    assertEquals(probes.claudeDirExists, false);
  });
});

Deno.test("resolveClaudeProbes: detects existing ~/.claude.json", async () => {
  await withTempHome(async (tmpHome) => {
    await Deno.writeTextFile(`${tmpHome}/.claude.json`, "{}");
    const probes = resolveClaudeProbes(tmpHome);
    assertEquals(probes.claudeJsonExists, true);
  });
});

Deno.test("resolveClaudeProbes: finds claude binary on PATH", async () => {
  await withFakeBinary("claude", () => {
    const probes = resolveClaudeProbes("/tmp");
    assertEquals(probes.claudeBinPath !== null, true);
  });
});

Deno.test("resolveClaudeProbes: returns null when claude not on PATH", async () => {
  await withoutBinary("claude", () => {
    const probes = resolveClaudeProbes("/tmp");
    assertEquals(probes.claudeBinPath, null);
  });
});

// ============================================================
// configureCopilot (pure function tests)
// ============================================================

Deno.test("configureCopilot: uses ['copilot'] when binary found", () => {
  const probes: CopilotProbes = {
    copilotBinPath: "/usr/bin/copilot",
    copilotConfigDirExists: false,
    copilotStateDirExists: false,
    copilotLegacyDirExists: false,
    xdgConfigHome: null,
    xdgStateHome: null,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  assertEquals(result.agentCommand, ["copilot"]);
  const hasBinaryMount = result.dockerArgs.some((a) =>
    a.includes("/copilot:ro")
  );
  assertEquals(hasBinaryMount, true, "should mount copilot binary");
});

Deno.test("configureCopilot: uses error command when copilot binary not found", () => {
  const probes: CopilotProbes = {
    copilotBinPath: null,
    copilotConfigDirExists: false,
    copilotStateDirExists: false,
    copilotLegacyDirExists: false,
    xdgConfigHome: null,
    xdgStateHome: null,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  assertEquals(result.agentCommand[0], "bash");
  assertEquals(
    result.agentCommand[2]?.includes("copilot binary not found"),
    true,
  );
});

Deno.test("configureCopilot: mounts copilot config dir with custom containerHome", () => {
  const probes: CopilotProbes = {
    copilotBinPath: null,
    copilotConfigDirExists: true,
    copilotStateDirExists: false,
    copilotLegacyDirExists: false,
    xdgConfigHome: null,
    xdgStateHome: null,
  };
  const result = configureCopilot({
    containerHome: "/home/custom",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  const mountArg = result.dockerArgs.find((a) => a.includes(".copilot"));
  assertEquals(
    mountArg !== undefined,
    true,
    "should mount copilot config dir",
  );
  assertEquals(
    mountArg?.includes("/home/custom/"),
    true,
    "should use containerHome for container path",
  );
});

Deno.test("configureCopilot: does not mount copilot config when absent", () => {
  const probes: CopilotProbes = {
    copilotBinPath: null,
    copilotConfigDirExists: false,
    copilotStateDirExists: false,
    copilotLegacyDirExists: false,
    xdgConfigHome: null,
    xdgStateHome: null,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  const hasCopilotMount = result.dockerArgs.some((a) => a.includes(".copilot"));
  assertEquals(hasCopilotMount, false);
});

Deno.test("configureCopilot: preserves existing dockerArgs and envVars", () => {
  const probes: CopilotProbes = {
    copilotBinPath: null,
    copilotConfigDirExists: false,
    copilotStateDirExists: false,
    copilotLegacyDirExists: false,
    xdgConfigHome: null,
    xdgStateHome: null,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: ["--pre-existing"],
    priorEnvVars: { KEEP_ME: "yes" },
  });
  assertEquals(result.dockerArgs[0], "--pre-existing");
  assertEquals(result.envVars["KEEP_ME"], "yes");
});

Deno.test("configureCopilot: passes XDG_CONFIG_HOME when set", () => {
  const probes: CopilotProbes = {
    copilotBinPath: null,
    copilotConfigDirExists: false,
    copilotStateDirExists: false,
    copilotLegacyDirExists: false,
    xdgConfigHome: "/tmp/nas-test-xdg-config",
    xdgStateHome: null,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  assertEquals(result.envVars["XDG_CONFIG_HOME"] !== undefined, true);
});

Deno.test("configureCopilot: passes XDG_STATE_HOME when set", () => {
  const probes: CopilotProbes = {
    copilotBinPath: null,
    copilotConfigDirExists: false,
    copilotStateDirExists: false,
    copilotLegacyDirExists: false,
    xdgConfigHome: null,
    xdgStateHome: "/tmp/nas-test-xdg-state",
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  assertEquals(result.envVars["XDG_STATE_HOME"] !== undefined, true);
});

Deno.test("configureCopilot: remaps XDG paths under HOME to containerHome", () => {
  const hostHome = "/home/host";
  const probes: CopilotProbes = {
    copilotBinPath: null,
    copilotConfigDirExists: false,
    copilotStateDirExists: false,
    copilotLegacyDirExists: false,
    xdgConfigHome: `${hostHome}/.config`,
    xdgStateHome: null,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome,
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  assertEquals(result.envVars["XDG_CONFIG_HOME"], "/home/testuser/.config");
});

Deno.test("configureCopilot: does not remap XDG paths outside HOME", () => {
  const probes: CopilotProbes = {
    copilotBinPath: null,
    copilotConfigDirExists: false,
    copilotStateDirExists: false,
    copilotLegacyDirExists: false,
    xdgConfigHome: "/opt/custom-config",
    xdgStateHome: null,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  assertEquals(result.envVars["XDG_CONFIG_HOME"], "/opt/custom-config");
});

Deno.test("configureCopilot: does not set XDG vars when not set on host", () => {
  const probes: CopilotProbes = {
    copilotBinPath: null,
    copilotConfigDirExists: false,
    copilotStateDirExists: false,
    copilotLegacyDirExists: false,
    xdgConfigHome: null,
    xdgStateHome: null,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  assertEquals(result.envVars["XDG_CONFIG_HOME"], undefined);
  assertEquals(result.envVars["XDG_STATE_HOME"], undefined);
});

// ============================================================
// resolveCopilotProbes (integration with filesystem)
// ============================================================

Deno.test("resolveCopilotProbes: detects existing config dir", async () => {
  await withTempHome(async (tmpHome) => {
    const origXdg = Deno.env.get("XDG_CONFIG_HOME");
    try {
      Deno.env.delete("XDG_CONFIG_HOME");
      await Deno.mkdir(`${tmpHome}/.copilot`, { recursive: true });
      const probes = resolveCopilotProbes(tmpHome);
      assertEquals(probes.copilotConfigDirExists, true);
    } finally {
      if (origXdg !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdg);
    }
  });
});

Deno.test("resolveCopilotProbes: detects missing config dir", async () => {
  await withTempHome((tmpHome) => {
    const origXdg = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgState = Deno.env.get("XDG_STATE_HOME");
    try {
      Deno.env.delete("XDG_CONFIG_HOME");
      Deno.env.delete("XDG_STATE_HOME");
      const probes = resolveCopilotProbes(tmpHome);
      assertEquals(probes.copilotConfigDirExists, false);
    } finally {
      if (origXdg !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdg);
      if (origXdgState !== undefined) {
        Deno.env.set("XDG_STATE_HOME", origXdgState);
      }
    }
  });
});

Deno.test("resolveCopilotProbes: finds copilot binary on PATH", async () => {
  await withFakeBinary("copilot", () => {
    const probes = resolveCopilotProbes("/tmp");
    assertEquals(probes.copilotBinPath !== null, true);
  });
});

Deno.test("resolveCopilotProbes: returns null when copilot not on PATH", async () => {
  await withoutBinary("copilot", () => {
    const probes = resolveCopilotProbes("/tmp");
    assertEquals(probes.copilotBinPath, null);
  });
});

Deno.test("resolveCopilotProbes: detects existing state dir", async () => {
  await withTempHome(async (tmpHome) => {
    const origXdg = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgState = Deno.env.get("XDG_STATE_HOME");
    try {
      Deno.env.delete("XDG_CONFIG_HOME");
      Deno.env.delete("XDG_STATE_HOME");
      // XDG 未設定時は state dir = config dir = $HOME/.copilot
      await Deno.mkdir(`${tmpHome}/.copilot`, { recursive: true });
      const probes = resolveCopilotProbes(tmpHome);
      assertEquals(probes.copilotStateDirExists, true);
    } finally {
      if (origXdg !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdg);
      if (origXdgState !== undefined) {
        Deno.env.set("XDG_STATE_HOME", origXdgState);
      }
    }
  });
});

Deno.test("resolveCopilotProbes: detects missing state dir", async () => {
  await withTempHome((tmpHome) => {
    const origXdg = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgState = Deno.env.get("XDG_STATE_HOME");
    try {
      Deno.env.delete("XDG_CONFIG_HOME");
      Deno.env.delete("XDG_STATE_HOME");
      const probes = resolveCopilotProbes(tmpHome);
      assertEquals(probes.copilotStateDirExists, false);
    } finally {
      if (origXdg !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdg);
      if (origXdgState !== undefined) {
        Deno.env.set("XDG_STATE_HOME", origXdgState);
      }
    }
  });
});

Deno.test("resolveCopilotProbes: detects existing legacy dir when XDG paths differ", async () => {
  await withTempHome(async (tmpHome) => {
    const origXdg = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgState = Deno.env.get("XDG_STATE_HOME");
    const xdgConfigDir = await Deno.makeTempDir({ prefix: "nas-test-xdg-" });
    const xdgStateDir = await Deno.makeTempDir({ prefix: "nas-test-xdg-" });
    try {
      Deno.env.set("XDG_CONFIG_HOME", xdgConfigDir);
      Deno.env.set("XDG_STATE_HOME", xdgStateDir);
      // legacy dir は $HOME/.copilot (XDG とは異なるパス)
      await Deno.mkdir(`${tmpHome}/.copilot`, { recursive: true });
      const probes = resolveCopilotProbes(tmpHome);
      assertEquals(probes.copilotLegacyDirExists, true);
    } finally {
      if (origXdg !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdg);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgState !== undefined) {
        Deno.env.set("XDG_STATE_HOME", origXdgState);
      } else Deno.env.delete("XDG_STATE_HOME");
      await Deno.remove(xdgConfigDir, { recursive: true }).catch(() => {});
      await Deno.remove(xdgStateDir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("resolveCopilotProbes: legacy dir is false when it does not exist", async () => {
  await withTempHome((_tmpHome) => {
    const origXdg = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgState = Deno.env.get("XDG_STATE_HOME");
    try {
      Deno.env.set("XDG_CONFIG_HOME", "/tmp/nas-nonexistent-xdg-config");
      Deno.env.set("XDG_STATE_HOME", "/tmp/nas-nonexistent-xdg-state");
      // $HOME/.copilot does not exist
      const probes = resolveCopilotProbes(_tmpHome);
      assertEquals(probes.copilotLegacyDirExists, false);
    } finally {
      if (origXdg !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdg);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgState !== undefined) {
        Deno.env.set("XDG_STATE_HOME", origXdgState);
      } else Deno.env.delete("XDG_STATE_HOME");
    }
  });
});

Deno.test("resolveCopilotProbes: legacy dir is false when XDG not set (same as config dir)", async () => {
  await withTempHome(async (tmpHome) => {
    const origXdg = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgState = Deno.env.get("XDG_STATE_HOME");
    try {
      Deno.env.delete("XDG_CONFIG_HOME");
      Deno.env.delete("XDG_STATE_HOME");
      // XDG 未設定時は legacy dir == config dir なので常に false
      await Deno.mkdir(`${tmpHome}/.copilot`, { recursive: true });
      const probes = resolveCopilotProbes(tmpHome);
      assertEquals(probes.copilotLegacyDirExists, false);
    } finally {
      if (origXdg !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdg);
      if (origXdgState !== undefined) {
        Deno.env.set("XDG_STATE_HOME", origXdgState);
      }
    }
  });
});

// ============================================================
// configureCodex (pure function tests)
// ============================================================

Deno.test("configureCodex: uses ['codex'] when binary found", () => {
  const probes: CodexProbes = {
    codexDirExists: false,
    codexBinPath: "/usr/bin/codex",
  };
  const result = configureCodex({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  assertEquals(result.agentCommand, ["codex"]);
  const hasBinaryMount = result.dockerArgs.some((a) => a.includes("/codex:ro"));
  assertEquals(hasBinaryMount, true, "should mount codex binary");
});

Deno.test("configureCodex: uses error command when codex binary not found", () => {
  const probes: CodexProbes = {
    codexDirExists: false,
    codexBinPath: null,
  };
  const result = configureCodex({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  assertEquals(result.agentCommand[0], "bash");
  assertEquals(
    result.agentCommand[2]?.includes("codex binary not found"),
    true,
  );
});

Deno.test("configureCodex: mounts ~/.codex when directory exists", () => {
  const containerHome = "/home/testuser";
  const hostHome = "/home/host";
  const probes: CodexProbes = {
    codexDirExists: true,
    codexBinPath: null,
  };
  const result = configureCodex({
    containerHome,
    hostHome,
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  const mountArg = `${hostHome}/.codex:${containerHome}/.codex`;
  assertEquals(
    result.dockerArgs.includes(mountArg),
    true,
    `dockerArgs should contain ${mountArg}`,
  );
});

Deno.test("configureCodex: does not mount ~/.codex when directory is absent", () => {
  const probes: CodexProbes = {
    codexDirExists: false,
    codexBinPath: null,
  };
  const result = configureCodex({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  const hasMount = result.dockerArgs.some((a) => a.includes(".codex"));
  assertEquals(hasMount, false);
});

Deno.test("configureCodex: uses containerHome for codex mount path", () => {
  const probes: CodexProbes = {
    codexDirExists: true,
    codexBinPath: null,
  };
  const result = configureCodex({
    containerHome: "/home/custom",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  const mountArg = `/home/host/.codex:/home/custom/.codex`;
  assertEquals(
    result.dockerArgs.includes(mountArg),
    true,
    `dockerArgs should contain ${mountArg}`,
  );
});

Deno.test("configureCodex: preserves existing dockerArgs and envVars", () => {
  const probes: CodexProbes = {
    codexDirExists: false,
    codexBinPath: null,
  };
  const result = configureCodex({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: ["--pre-existing"],
    priorEnvVars: { KEEP_ME: "yes" },
  });
  assertEquals(result.dockerArgs[0], "--pre-existing");
  assertEquals(result.envVars["KEEP_ME"], "yes");
});

// ============================================================
// resolveCodexProbes (integration with filesystem)
// ============================================================

Deno.test("resolveCodexProbes: detects existing ~/.codex directory", async () => {
  await withTempHome(async (tmpHome) => {
    await Deno.mkdir(`${tmpHome}/.codex`, { recursive: true });
    const probes = resolveCodexProbes(tmpHome);
    assertEquals(probes.codexDirExists, true);
  });
});

Deno.test("resolveCodexProbes: detects missing ~/.codex directory", async () => {
  await withTempHome((tmpHome) => {
    const probes = resolveCodexProbes(tmpHome);
    assertEquals(probes.codexDirExists, false);
  });
});

Deno.test("resolveCodexProbes: finds codex binary on PATH", async () => {
  await withFakeBinary("codex", () => {
    const probes = resolveCodexProbes("/tmp");
    assertEquals(probes.codexBinPath !== null, true);
  });
});

Deno.test("resolveCodexProbes: returns null when codex not on PATH", async () => {
  await withoutBinary("codex", () => {
    const probes = resolveCodexProbes("/tmp");
    assertEquals(probes.codexBinPath, null);
  });
});

// ============================================================
// MountStage 経由のエージェント選択テスト (統合)
// ============================================================

import { createMountStage, resolveMountProbes } from "../stages/mount.ts";
import type { MountProbes } from "../stages/mount.ts";
import type { PriorStageOutputs, StageInput } from "../pipeline/types.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";

async function buildMountTestInput(
  profile: Profile,
  workDir: string,
): Promise<{ input: StageInput; mountProbes: MountProbes }> {
  const hostEnv = buildHostEnv();
  const probes = await resolveProbes(hostEnv);
  const mountProbes = await resolveMountProbes(
    hostEnv,
    profile,
    workDir,
    probes.gpgAgentSocket,
  );

  const prior: PriorStageOutputs = {
    dockerArgs: [],
    envVars: { NAS_LOG_LEVEL: "info" },
    workDir,
    nixEnabled: false,
    imageName: "nas-sandbox",
    agentCommand: [],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
  };

  const input: StageInput = {
    config: baseConfig,
    profile,
    profileName: "test",
    sessionId: "sess_test",
    host: hostEnv,
    probes,
    prior,
  };

  return { input, mountProbes };
}

Deno.test("MountStage: dispatches to configureClaude for agent=claude", async () => {
  const profile: Profile = { ...baseProfile, agent: "claude" };
  const { input, mountProbes } = await buildMountTestInput(
    profile,
    Deno.cwd(),
  );
  const plan = createMountStage(mountProbes).plan(input)!;

  // Claude の特徴: PATH に .local/bin が入る
  const containerHome = getContainerHome();
  assertEquals(
    plan.envVars["PATH"]?.includes(`${containerHome}/.local/bin`),
    true,
  );
});

Deno.test("MountStage: dispatches to configureCopilot for agent=copilot", async () => {
  await withFakeBinary("copilot", async () => {
    const profile: Profile = { ...baseProfile, agent: "copilot" };
    const { input, mountProbes } = await buildMountTestInput(
      profile,
      Deno.cwd(),
    );
    const plan = createMountStage(mountProbes).plan(input)!;
    assertEquals(plan.outputOverrides.agentCommand, ["copilot"]);
  });
});

Deno.test("MountStage: dispatches to configureCodex for agent=codex", async () => {
  await withFakeBinary("codex", async () => {
    const profile: Profile = { ...baseProfile, agent: "codex" };
    const { input, mountProbes } = await buildMountTestInput(
      profile,
      Deno.cwd(),
    );
    const plan = createMountStage(mountProbes).plan(input)!;
    assertEquals(plan.outputOverrides.agentCommand, ["codex"]);
  });
});
