/**
 * エージェント設定関数のユニットテスト
 * configureClaude / configureCopilot / configureCodex
 */

import { assertEquals } from "@std/assert";
import { configureClaude } from "../src/agents/claude.ts";
import { configureCopilot } from "../src/agents/copilot.ts";
import { configureCodex } from "../src/agents/codex.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/config/types.ts";
import { createContext } from "../src/pipeline/context.ts";
import type { Config, Profile } from "../src/config/types.ts";

const baseProfile: Profile = {
  agent: "claude",
  agentArgs: [],
  nix: { enable: false, mountSocket: false, extraPackages: [] },
  docker: { enable: false, shared: false },
  gcloud: { mountConfig: false },
  aws: { mountConfig: false },
  gpg: { forwardAgent: false },
  network: structuredClone(DEFAULT_NETWORK_CONFIG),
  extraMounts: [],
  env: [],
};

const baseConfig: Config = {
  default: "test",
  profiles: { test: baseProfile },
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
// configureClaude
// ============================================================

Deno.test("configureClaude: sets PATH with .local/bin prepended", () => {
  const containerHome = getContainerHome();
  const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
  const result = configureClaude(ctx);
  assertEquals(
    result.envVars["PATH"]?.startsWith(`${containerHome}/.local/bin:`),
    true,
    `PATH should start with ${containerHome}/.local/bin:`,
  );
});

Deno.test("configureClaude: uses NAS_HOME from envVars when set", () => {
  const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
  ctx.envVars["NAS_HOME"] = "/home/custom";
  const result = configureClaude(ctx);
  assertEquals(
    result.envVars["PATH"]?.startsWith("/home/custom/.local/bin:"),
    true,
  );
});

Deno.test("configureClaude: mounts ~/.claude when directory exists", async () => {
  await withTempHome(async (tmpHome) => {
    const containerHome = getContainerHome();
    await Deno.mkdir(`${tmpHome}/.claude`, { recursive: true });

    const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
    const result = configureClaude(ctx);
    const mountArg = `${tmpHome}/.claude:${containerHome}/.claude`;
    assertEquals(
      result.dockerArgs.includes(mountArg),
      true,
      `dockerArgs should contain ${mountArg}`,
    );
  });
});

Deno.test("configureClaude: does not mount ~/.claude when directory is absent", async () => {
  await withTempHome((tmpHome) => {
    const containerHome = getContainerHome();
    const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
    const result = configureClaude(ctx);
    const hasClaudeMount = result.dockerArgs.some((a) =>
      a === `${tmpHome}/.claude:${containerHome}/.claude`
    );
    assertEquals(hasClaudeMount, false);
  });
});

Deno.test("configureClaude: mounts ~/.claude.json when file exists", async () => {
  await withTempHome(async (tmpHome) => {
    const containerHome = getContainerHome();
    await Deno.writeTextFile(`${tmpHome}/.claude.json`, "{}");

    const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
    const result = configureClaude(ctx);
    const mountArg = `${tmpHome}/.claude.json:${containerHome}/.claude.json`;
    assertEquals(
      result.dockerArgs.includes(mountArg),
      true,
      `dockerArgs should contain ${mountArg}`,
    );
  });
});

Deno.test("configureClaude: does not mount ~/.claude.json when file is absent", async () => {
  await withTempHome((tmpHome) => {
    const containerHome = getContainerHome();
    const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
    const result = configureClaude(ctx);
    const hasMount = result.dockerArgs.some((a) =>
      a === `${tmpHome}/.claude.json:${containerHome}/.claude.json`
    );
    assertEquals(hasMount, false);
  });
});

Deno.test("configureClaude: mounts binary and uses ['claude'] when found on PATH", async () => {
  await withFakeBinary("claude", () => {
    const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
    const result = configureClaude(ctx);
    assertEquals(result.agentCommand, ["claude"]);
    const hasBinaryMount = result.dockerArgs.some((a) =>
      a.endsWith("/claude:ro")
    );
    assertEquals(hasBinaryMount, true, "should mount claude binary");
  });
});

Deno.test("configureClaude: uses install script when claude binary not found", async () => {
  await withoutBinary("claude", () => {
    const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
    const result = configureClaude(ctx);
    assertEquals(result.agentCommand[0], "bash");
    assertEquals(result.agentCommand[1], "-c");
    assertEquals(result.agentCommand[2]?.includes("install.sh"), true);
  });
});

Deno.test("configureClaude: preserves existing dockerArgs", () => {
  const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
  ctx.dockerArgs = ["--existing", "arg"];
  const result = configureClaude(ctx);
  assertEquals(result.dockerArgs[0], "--existing");
  assertEquals(result.dockerArgs[1], "arg");
});

Deno.test("configureClaude: preserves existing envVars", () => {
  const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
  ctx.envVars["EXISTING"] = "value";
  const result = configureClaude(ctx);
  assertEquals(result.envVars["EXISTING"], "value");
});

// ============================================================
// configureCopilot
// ============================================================

Deno.test("configureCopilot: uses ['copilot'] when found on PATH", async () => {
  await withFakeBinary("copilot", () => {
    const profile: Profile = { ...baseProfile, agent: "copilot" };
    const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
    const result = configureCopilot(ctx);
    assertEquals(result.agentCommand, ["copilot"]);
    const hasBinaryMount = result.dockerArgs.some((a) =>
      a.includes("/copilot:ro")
    );
    assertEquals(hasBinaryMount, true, "should mount copilot binary");
  });
});

Deno.test("configureCopilot: uses error command when copilot binary not found", async () => {
  await withoutBinary("copilot", () => {
    const profile: Profile = { ...baseProfile, agent: "copilot" };
    const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
    const result = configureCopilot(ctx);
    assertEquals(result.agentCommand[0], "bash");
    assertEquals(
      result.agentCommand[2]?.includes("copilot binary not found"),
      true,
    );
  });
});

Deno.test("configureCopilot: mounts copilot config dir with NAS_HOME", async () => {
  await withTempHome(async (tmpHome) => {
    await Deno.mkdir(`${tmpHome}/.copilot`, { recursive: true });

    const profile: Profile = { ...baseProfile, agent: "copilot" };
    const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
    ctx.envVars["NAS_HOME"] = "/home/custom";
    const result = configureCopilot(ctx);
    const mountArg = result.dockerArgs.find((a) =>
      a.includes(`${tmpHome}/.copilot`)
    );
    assertEquals(
      mountArg !== undefined,
      true,
      "should mount copilot config dir",
    );
    assertEquals(
      mountArg?.includes("/home/custom/"),
      true,
      "should use NAS_HOME for container path",
    );
  });
});

Deno.test("configureCopilot: does not mount copilot config when absent", async () => {
  await withTempHome(() => {
    const origXdg = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgState = Deno.env.get("XDG_STATE_HOME");
    try {
      Deno.env.delete("XDG_CONFIG_HOME");
      Deno.env.delete("XDG_STATE_HOME");
      const profile: Profile = { ...baseProfile, agent: "copilot" };
      const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
      const result = configureCopilot(ctx);
      const hasCopilotMount = result.dockerArgs.some((a) =>
        a.includes(".copilot")
      );
      assertEquals(hasCopilotMount, false);
    } finally {
      if (origXdg !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdg);
      if (origXdgState !== undefined) {
        Deno.env.set("XDG_STATE_HOME", origXdgState);
      }
    }
  });
});

Deno.test("configureCopilot: preserves existing dockerArgs and envVars", () => {
  const profile: Profile = { ...baseProfile, agent: "copilot" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  ctx.dockerArgs = ["--pre-existing"];
  ctx.envVars["KEEP_ME"] = "yes";
  const result = configureCopilot(ctx);
  assertEquals(result.dockerArgs[0], "--pre-existing");
  assertEquals(result.envVars["KEEP_ME"], "yes");
});

Deno.test("configureCopilot: passes XDG_CONFIG_HOME when set", () => {
  const profile: Profile = { ...baseProfile, agent: "copilot" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());

  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  try {
    Deno.env.set("XDG_CONFIG_HOME", "/tmp/nas-test-xdg-config");
    const result = configureCopilot(ctx);
    // XDG_CONFIG_HOME がコンテナ用にリマップされて設定されるはず
    assertEquals(result.envVars["XDG_CONFIG_HOME"] !== undefined, true);
  } finally {
    if (originalXdg !== undefined) {
      Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    } else {
      Deno.env.delete("XDG_CONFIG_HOME");
    }
  }
});

Deno.test("configureCopilot: passes XDG_STATE_HOME when set", () => {
  const profile: Profile = { ...baseProfile, agent: "copilot" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());

  const originalXdg = Deno.env.get("XDG_STATE_HOME");
  try {
    Deno.env.set("XDG_STATE_HOME", "/tmp/nas-test-xdg-state");
    const result = configureCopilot(ctx);
    assertEquals(result.envVars["XDG_STATE_HOME"] !== undefined, true);
  } finally {
    if (originalXdg !== undefined) {
      Deno.env.set("XDG_STATE_HOME", originalXdg);
    } else {
      Deno.env.delete("XDG_STATE_HOME");
    }
  }
});

Deno.test("configureCopilot: remaps XDG paths under HOME to containerHome", () => {
  const profile: Profile = { ...baseProfile, agent: "copilot" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  ctx.envVars["NAS_HOME"] = "/home/testuser";

  const home = Deno.env.get("HOME") ?? "/root";
  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  try {
    // HOME 配下のパスを XDG_CONFIG_HOME に設定
    Deno.env.set("XDG_CONFIG_HOME", `${home}/.config`);
    const result = configureCopilot(ctx);
    // リマップされて /home/testuser/.config になるはず
    assertEquals(result.envVars["XDG_CONFIG_HOME"], "/home/testuser/.config");
  } finally {
    if (originalXdg !== undefined) {
      Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    } else {
      Deno.env.delete("XDG_CONFIG_HOME");
    }
  }
});

Deno.test("configureCopilot: does not remap XDG paths outside HOME", () => {
  const profile: Profile = { ...baseProfile, agent: "copilot" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());

  const originalXdg = Deno.env.get("XDG_CONFIG_HOME");
  try {
    // HOME 外のパス
    Deno.env.set("XDG_CONFIG_HOME", "/opt/custom-config");
    const result = configureCopilot(ctx);
    assertEquals(result.envVars["XDG_CONFIG_HOME"], "/opt/custom-config");
  } finally {
    if (originalXdg !== undefined) {
      Deno.env.set("XDG_CONFIG_HOME", originalXdg);
    } else {
      Deno.env.delete("XDG_CONFIG_HOME");
    }
  }
});

Deno.test("configureCopilot: does not set XDG vars when not set on host", () => {
  const profile: Profile = { ...baseProfile, agent: "copilot" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());

  const origConfig = Deno.env.get("XDG_CONFIG_HOME");
  const origState = Deno.env.get("XDG_STATE_HOME");
  try {
    Deno.env.delete("XDG_CONFIG_HOME");
    Deno.env.delete("XDG_STATE_HOME");
    const result = configureCopilot(ctx);
    assertEquals(result.envVars["XDG_CONFIG_HOME"], undefined);
    assertEquals(result.envVars["XDG_STATE_HOME"], undefined);
  } finally {
    if (origConfig !== undefined) Deno.env.set("XDG_CONFIG_HOME", origConfig);
    if (origState !== undefined) Deno.env.set("XDG_STATE_HOME", origState);
  }
});

// ============================================================
// configureCodex
// ============================================================

Deno.test("configureCodex: uses ['codex'] when found on PATH", async () => {
  await withFakeBinary("codex", () => {
    const profile: Profile = { ...baseProfile, agent: "codex" };
    const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
    const result = configureCodex(ctx);
    assertEquals(result.agentCommand, ["codex"]);
    const hasBinaryMount = result.dockerArgs.some((a) =>
      a.includes("/codex:ro")
    );
    assertEquals(hasBinaryMount, true, "should mount codex binary");
  });
});

Deno.test("configureCodex: uses error command when codex binary not found", async () => {
  await withoutBinary("codex", () => {
    const profile: Profile = { ...baseProfile, agent: "codex" };
    const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
    const result = configureCodex(ctx);
    assertEquals(result.agentCommand[0], "bash");
    assertEquals(
      result.agentCommand[2]?.includes("codex binary not found"),
      true,
    );
  });
});

Deno.test("configureCodex: passes OPENAI_API_KEY when set", () => {
  const profile: Profile = { ...baseProfile, agent: "codex" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());

  const originalKey = Deno.env.get("OPENAI_API_KEY");
  try {
    Deno.env.set("OPENAI_API_KEY", "sk-test-key-12345");
    const result = configureCodex(ctx);
    assertEquals(result.envVars["OPENAI_API_KEY"], "sk-test-key-12345");
  } finally {
    if (originalKey !== undefined) {
      Deno.env.set("OPENAI_API_KEY", originalKey);
    } else {
      Deno.env.delete("OPENAI_API_KEY");
    }
  }
});

Deno.test("configureCodex: does not set OPENAI_API_KEY when not set", () => {
  const profile: Profile = { ...baseProfile, agent: "codex" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());

  const originalKey = Deno.env.get("OPENAI_API_KEY");
  try {
    Deno.env.delete("OPENAI_API_KEY");
    const result = configureCodex(ctx);
    assertEquals(result.envVars["OPENAI_API_KEY"], undefined);
  } finally {
    if (originalKey !== undefined) {
      Deno.env.set("OPENAI_API_KEY", originalKey);
    }
  }
});

Deno.test("configureCodex: mounts ~/.codex when directory exists", async () => {
  await withTempHome(async (tmpHome) => {
    const containerHome = getContainerHome();
    await Deno.mkdir(`${tmpHome}/.codex`, { recursive: true });

    const ctx = createContext(
      baseConfig,
      { ...baseProfile, agent: "codex" },
      "test",
      Deno.cwd(),
    );
    const result = configureCodex(ctx);
    const mountArg = `${tmpHome}/.codex:${containerHome}/.codex`;
    assertEquals(
      result.dockerArgs.includes(mountArg),
      true,
      `dockerArgs should contain ${mountArg}`,
    );
  });
});

Deno.test("configureCodex: does not mount ~/.codex when directory is absent", async () => {
  await withTempHome((tmpHome) => {
    const containerHome = getContainerHome();
    const ctx = createContext(
      baseConfig,
      { ...baseProfile, agent: "codex" },
      "test",
      Deno.cwd(),
    );
    const result = configureCodex(ctx);
    const hasMount = result.dockerArgs.some((a) =>
      a === `${tmpHome}/.codex:${containerHome}/.codex`
    );
    assertEquals(hasMount, false);
  });
});

Deno.test("configureCodex: uses NAS_HOME for codex mount path", async () => {
  await withTempHome(async (tmpHome) => {
    await Deno.mkdir(`${tmpHome}/.codex`, { recursive: true });

    const profile: Profile = { ...baseProfile, agent: "codex" };
    const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
    ctx.envVars["NAS_HOME"] = "/home/custom";
    const result = configureCodex(ctx);
    const mountArg = `${tmpHome}/.codex:/home/custom/.codex`;
    assertEquals(
      result.dockerArgs.includes(mountArg),
      true,
      `dockerArgs should contain ${mountArg}`,
    );
  });
});

Deno.test("configureCodex: preserves existing dockerArgs and envVars", () => {
  const profile: Profile = { ...baseProfile, agent: "codex" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  ctx.dockerArgs = ["--pre-existing"];
  ctx.envVars["KEEP_ME"] = "yes";
  const result = configureCodex(ctx);
  assertEquals(result.dockerArgs[0], "--pre-existing");
  assertEquals(result.envVars["KEEP_ME"], "yes");
});

// ============================================================
// MountStage 経由のエージェント選択テスト (統合)
// ============================================================

import { MountStage } from "../src/stages/mount.ts";

Deno.test("MountStage: dispatches to configureClaude for agent=claude", async () => {
  const profile: Profile = { ...baseProfile, agent: "claude" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);

  // Claude の特徴: PATH に .local/bin が入る
  const containerHome = getContainerHome();
  assertEquals(
    result.envVars["PATH"]?.includes(`${containerHome}/.local/bin`),
    true,
  );
});

Deno.test("MountStage: dispatches to configureCopilot for agent=copilot", async () => {
  await withFakeBinary("copilot", async () => {
    const profile: Profile = { ...baseProfile, agent: "copilot" };
    const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
    const result = await new MountStage().execute(ctx);
    assertEquals(result.agentCommand, ["copilot"]);
  });
});

Deno.test("MountStage: dispatches to configureCodex for agent=codex", async () => {
  await withFakeBinary("codex", async () => {
    const profile: Profile = { ...baseProfile, agent: "codex" };
    const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
    const result = await new MountStage().execute(ctx);
    assertEquals(result.agentCommand, ["codex"]);
  });
});
