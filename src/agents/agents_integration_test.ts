import { expect, test } from "bun:test";
import { statSync } from "node:fs";

/**
 * エージェント設定関数のユニットテスト
 * configureClaude / configureCopilot / configureCodex
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeProbes } from "./claude.ts";
import { configureClaude, resolveClaudeProbes } from "./claude.ts";
import type { CodexProbes } from "./codex.ts";
import { configureCodex, resolveCodexProbes } from "./codex.ts";
import type { CopilotProbes } from "./copilot.ts";
import { configureCopilot, resolveCopilotProbes } from "./copilot.ts";
import { configureAgent, resolveAgentProbes } from "./registry.ts";

// ============================================================
// テスト用ヘルパー
// ============================================================

/** 一時的に HOME を差し替えてテストを実行する */
async function withTempHome(
  fn: (tmpHome: string) => Promise<void> | void,
): Promise<void> {
  const origHome = process.env.HOME;
  const tmpHome = await mkdtemp(path.join(tmpdir(), "nas-test-home-"));
  try {
    process.env.HOME = tmpHome;
    await fn(tmpHome);
  } finally {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  }
}

/** 一時的に PATH 上にダミーバイナリを配置してテストを実行する */
async function withFakeBinary(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  const origPath = process.env.PATH;
  const tmpBinDir = await mkdtemp(path.join(tmpdir(), "nas-test-bin-"));
  try {
    await writeFile(`${tmpBinDir}/${name}`, "#!/bin/sh\nexit 0\n");
    await chmod(`${tmpBinDir}/${name}`, 0o755);
    process.env.PATH = `${tmpBinDir}:${origPath ?? ""}`;
    await fn();
  } finally {
    if (origPath !== undefined) process.env.PATH = origPath;
    else delete process.env.PATH;
    await rm(tmpBinDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** PATH から指定バイナリを除外してテストを実行する */
async function withoutBinary(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  const origPath = process.env.PATH;
  const filteredPath = (origPath ?? "")
    .split(":")
    .filter((dir) => {
      try {
        statSync(`${dir}/${name}`);
        return false;
      } catch {
        return true;
      }
    })
    .join(":");
  process.env.PATH = filteredPath;
  try {
    await fn();
  } finally {
    if (origPath !== undefined) process.env.PATH = origPath;
    else delete process.env.PATH;
  }
}

// ============================================================
// registry dispatch
// ============================================================

test("configureAgent: dispatches claude configuration", () => {
  const result = configureAgent({
    agent: "claude",
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes: {
      claudeDirExists: false,
      claudeJsonExists: false,
      claudeBinPath: "/usr/bin/claude",
    },
    priorDockerArgs: ["--existing"],
    priorEnvVars: {},
  });
  expect(result.agentCommand).toEqual(["claude"]);
  expect(result.dockerArgs[0]).toEqual("--existing");
});

test("configureAgent: dispatches copilot configuration", () => {
  const result = configureAgent({
    agent: "copilot",
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes: {
      copilotBinPath: "/usr/bin/copilot",
      copilotLegacyDirExists: false,
    },
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  expect(result.agentCommand).toEqual(["copilot"]);
});

test("configureAgent: dispatches codex configuration", () => {
  const result = configureAgent({
    agent: "codex",
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes: {
      codexDirExists: false,
      codexBinPath: "/usr/bin/codex",
    },
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  expect(result.agentCommand).toEqual(["codex"]);
});

test("resolveAgentProbes: dispatches claude probe resolver", async () => {
  await withTempHome(async (tmpHome) => {
    await mkdir(`${tmpHome}/.claude`);
    await writeFile(`${tmpHome}/.claude.json`, "{}");

    expect(resolveAgentProbes("claude", tmpHome)).toEqual(
      resolveClaudeProbes(tmpHome),
    );
  });
});

test("resolveAgentProbes: dispatches copilot probe resolver", async () => {
  await withTempHome(async (tmpHome) => {
    await mkdir(`${tmpHome}/.copilot`);

    expect(resolveAgentProbes("copilot", tmpHome)).toEqual(
      resolveCopilotProbes(tmpHome),
    );
  });
});

test("resolveAgentProbes: dispatches codex probe resolver", async () => {
  await withTempHome(async (tmpHome) => {
    await mkdir(`${tmpHome}/.codex`);

    expect(resolveAgentProbes("codex", tmpHome)).toEqual(
      resolveCodexProbes(tmpHome),
    );
  });
});

// ============================================================
// configureClaude (pure function tests)
// ============================================================

test("configureClaude: sets PATH with .local/bin prepended", () => {
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
  expect(
    result.envVars.PATH?.startsWith(`${containerHome}/.local/bin:`),
  ).toEqual(true);
});

test("configureClaude: mounts ~/.claude when directory exists", () => {
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
  expect(result.dockerArgs.includes(mountArg)).toEqual(true);
});

test("configureClaude: does not mount ~/.claude when directory is absent", () => {
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
  expect(hasClaudeMount).toEqual(false);
});

test("configureClaude: mounts ~/.claude.json when file exists", () => {
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
  expect(result.dockerArgs.includes(mountArg)).toEqual(true);
});

test("configureClaude: does not mount ~/.claude.json when file is absent", () => {
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
  expect(hasMount).toEqual(false);
});

test("configureClaude: mounts binary and uses ['claude'] when binary found", () => {
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
  expect(result.agentCommand).toEqual(["claude"]);
  const hasBinaryMount = result.dockerArgs.some((a) =>
    a.endsWith("/claude:ro"),
  );
  expect(hasBinaryMount).toEqual(true);
});

test("configureClaude: uses install script when claude binary not found", () => {
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
  expect(result.agentCommand[0]).toEqual("bash");
  expect(result.agentCommand[1]).toEqual("-c");
  expect(result.agentCommand[2]?.includes("install.sh")).toEqual(true);
});

test("configureClaude: preserves existing dockerArgs", () => {
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
  expect(result.dockerArgs[0]).toEqual("--existing");
  expect(result.dockerArgs[1]).toEqual("arg");
});

test("configureClaude: preserves existing envVars", () => {
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
  expect(result.envVars.EXISTING).toEqual("value");
});

// ============================================================
// resolveClaudeProbes (integration with filesystem)
// ============================================================

test("resolveClaudeProbes: detects existing ~/.claude directory", async () => {
  await withTempHome(async (tmpHome) => {
    await mkdir(`${tmpHome}/.claude`, { recursive: true });
    const probes = resolveClaudeProbes(tmpHome);
    expect(probes.claudeDirExists).toEqual(true);
  });
});

test("resolveClaudeProbes: detects missing ~/.claude directory", async () => {
  await withTempHome((tmpHome) => {
    const probes = resolveClaudeProbes(tmpHome);
    expect(probes.claudeDirExists).toEqual(false);
  });
});

test("resolveClaudeProbes: detects existing ~/.claude.json", async () => {
  await withTempHome(async (tmpHome) => {
    await writeFile(`${tmpHome}/.claude.json`, "{}");
    const probes = resolveClaudeProbes(tmpHome);
    expect(probes.claudeJsonExists).toEqual(true);
  });
});

test("resolveClaudeProbes: finds claude binary on PATH", async () => {
  await withFakeBinary("claude", () => {
    const probes = resolveClaudeProbes("/tmp");
    expect(probes.claudeBinPath !== null).toEqual(true);
  });
});

test("resolveClaudeProbes: returns null when claude not on PATH", async () => {
  await withoutBinary("claude", () => {
    const probes = resolveClaudeProbes("/tmp");
    expect(probes.claudeBinPath).toEqual(null);
  });
});

// ============================================================
// configureCopilot (pure function tests)
// ============================================================

test("configureCopilot: uses ['copilot'] when binary found", () => {
  const probes: CopilotProbes = {
    copilotBinPath: "/usr/bin/copilot",
    copilotLegacyDirExists: false,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  expect(result.agentCommand).toEqual(["copilot"]);
  const hasBinaryMount = result.dockerArgs.some((a) =>
    a.includes("/copilot:ro"),
  );
  expect(hasBinaryMount).toEqual(true);
});

test("configureCopilot: uses error command when copilot binary not found", () => {
  const probes: CopilotProbes = {
    copilotBinPath: null,
    copilotLegacyDirExists: false,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  expect(result.agentCommand[0]).toEqual("bash");
  expect(result.agentCommand[2]?.includes("copilot binary not found")).toEqual(
    true,
  );
});

test("configureCopilot: does not mount copilot dir when absent", () => {
  const probes: CopilotProbes = {
    copilotBinPath: "/usr/bin/copilot",
    copilotLegacyDirExists: false,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  const hasCopilotDirMount = result.dockerArgs.some(
    (a) => a.includes(".copilot") && !a.endsWith("/copilot:ro"),
  );
  expect(hasCopilotDirMount).toEqual(false);
});

test("configureCopilot: mounts ~/.copilot when legacy dir exists", () => {
  const probes: CopilotProbes = {
    copilotBinPath: "/usr/bin/copilot",
    copilotLegacyDirExists: true,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  expect(result.dockerArgs).toContain(
    "/home/host/.copilot:/home/testuser/.copilot",
  );
});

test("configureCopilot: preserves existing dockerArgs and envVars", () => {
  const probes: CopilotProbes = {
    copilotBinPath: null,
    copilotLegacyDirExists: false,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: ["--pre-existing"],
    priorEnvVars: { KEEP_ME: "yes" },
  });
  expect(result.dockerArgs[0]).toEqual("--pre-existing");
  expect(result.envVars.KEEP_ME).toEqual("yes");
});

test("configureCopilot: does not leak XDG env vars", () => {
  const probes: CopilotProbes = {
    copilotBinPath: null,
    copilotLegacyDirExists: false,
  };
  const result = configureCopilot({
    containerHome: "/home/testuser",
    hostHome: "/home/host",
    probes,
    priorDockerArgs: [],
    priorEnvVars: {},
  });
  expect(result.envVars.XDG_CONFIG_HOME).toBeUndefined();
  expect(result.envVars.XDG_STATE_HOME).toBeUndefined();
});

// ============================================================
// resolveCopilotProbes (integration with filesystem)
// ============================================================

test("resolveCopilotProbes: finds copilot binary on PATH", async () => {
  await withFakeBinary("copilot", () => {
    const probes = resolveCopilotProbes("/tmp");
    expect(probes.copilotBinPath !== null).toEqual(true);
  });
});

test("resolveCopilotProbes: returns null when copilot not on PATH", async () => {
  await withoutBinary("copilot", () => {
    const probes = resolveCopilotProbes("/tmp");
    expect(probes.copilotBinPath).toEqual(null);
  });
});

test("resolveCopilotProbes: detects existing ~/.copilot", async () => {
  await withTempHome(async (tmpHome) => {
    await mkdir(`${tmpHome}/.copilot`, { recursive: true });
    const probes = resolveCopilotProbes(tmpHome);
    expect(probes.copilotLegacyDirExists).toEqual(true);
  });
});

test("resolveCopilotProbes: reports missing ~/.copilot", async () => {
  await withTempHome((tmpHome) => {
    const probes = resolveCopilotProbes(tmpHome);
    expect(probes.copilotLegacyDirExists).toEqual(false);
  });
});

// ============================================================
// configureCodex (pure function tests)
// ============================================================

test("configureCodex: uses ['codex'] when binary found", () => {
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
  expect(result.agentCommand).toEqual(["codex"]);
  const hasBinaryMount = result.dockerArgs.some((a) => a.includes("/codex:ro"));
  expect(hasBinaryMount).toEqual(true);
});

test("configureCodex: uses error command when codex binary not found", () => {
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
  expect(result.agentCommand[0]).toEqual("bash");
  expect(result.agentCommand[2]?.includes("codex binary not found")).toEqual(
    true,
  );
});

test("configureCodex: mounts ~/.codex when directory exists", () => {
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
  expect(result.dockerArgs.includes(mountArg)).toEqual(true);
});

test("configureCodex: does not mount ~/.codex when directory is absent", () => {
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
  expect(hasMount).toEqual(false);
});

test("configureCodex: uses containerHome for codex mount path", () => {
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
  expect(result.dockerArgs.includes(mountArg)).toEqual(true);
});

test("configureCodex: preserves existing dockerArgs and envVars", () => {
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
  expect(result.dockerArgs[0]).toEqual("--pre-existing");
  expect(result.envVars.KEEP_ME).toEqual("yes");
});

// ============================================================
// resolveCodexProbes (integration with filesystem)
// ============================================================

test("resolveCodexProbes: detects existing ~/.codex directory", async () => {
  await withTempHome(async (tmpHome) => {
    await mkdir(`${tmpHome}/.codex`, { recursive: true });
    const probes = resolveCodexProbes(tmpHome);
    expect(probes.codexDirExists).toEqual(true);
  });
});

test("resolveCodexProbes: detects missing ~/.codex directory", async () => {
  await withTempHome((tmpHome) => {
    const probes = resolveCodexProbes(tmpHome);
    expect(probes.codexDirExists).toEqual(false);
  });
});

test("resolveCodexProbes: finds codex binary on PATH", async () => {
  await withFakeBinary("codex", () => {
    const probes = resolveCodexProbes("/tmp");
    expect(probes.codexBinPath !== null).toEqual(true);
  });
});

test("resolveCodexProbes: returns null when codex not on PATH", async () => {
  await withoutBinary("codex", () => {
    const probes = resolveCodexProbes("/tmp");
    expect(probes.codexBinPath).toEqual(null);
  });
});
