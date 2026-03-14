/**
 * エージェント設定関数のユニットテスト
 * configureClaude / configureCopilot / configureCodex
 */

import { assertEquals } from "@std/assert";
import { configureClaude } from "../src/agents/claude.ts";
import { configureCopilot } from "../src/agents/copilot.ts";
import { configureCodex } from "../src/agents/codex.ts";
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

Deno.test("configureClaude: mounts ~/.claude if it exists", () => {
  const home = Deno.env.get("HOME") ?? "/root";
  const containerHome = getContainerHome();
  const claudeDir = `${home}/.claude`;
  const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
  const result = configureClaude(ctx);

  const dirExists = (() => {
    try {
      return Deno.statSync(claudeDir).isDirectory;
    } catch {
      return false;
    }
  })();

  const mountArg = `${claudeDir}:${containerHome}/.claude`;
  if (dirExists) {
    assertEquals(result.dockerArgs.includes(mountArg), true);
  } else {
    assertEquals(result.dockerArgs.includes(mountArg), false);
  }
});

Deno.test("configureClaude: mounts ~/.claude.json if it exists", () => {
  const home = Deno.env.get("HOME") ?? "/root";
  const containerHome = getContainerHome();
  const claudeJson = `${home}/.claude.json`;
  const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
  const result = configureClaude(ctx);

  const fileExists = (() => {
    try {
      Deno.statSync(claudeJson);
      return true;
    } catch {
      return false;
    }
  })();

  const mountArg = `${claudeJson}:${containerHome}/.claude.json`;
  if (fileExists) {
    assertEquals(result.dockerArgs.includes(mountArg), true);
  } else {
    assertEquals(result.dockerArgs.includes(mountArg), false);
  }
});

Deno.test("configureClaude: agentCommand depends on binary availability", () => {
  const ctx = createContext(baseConfig, baseProfile, "test", Deno.cwd());
  const result = configureClaude(ctx);

  // claude binary が見つかれば ["claude"]、見つからなければ curl install コマンド
  if (result.agentCommand[0] === "claude") {
    assertEquals(result.agentCommand, ["claude"]);
    // バイナリマウントも存在するはず
    const hasBinaryMount = result.dockerArgs.some((a) =>
      a.endsWith("/claude:ro")
    );
    assertEquals(hasBinaryMount, true);
  } else {
    assertEquals(result.agentCommand[0], "bash");
    assertEquals(result.agentCommand[1], "-c");
    assertEquals(result.agentCommand[2]?.includes("install.sh"), true);
  }
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

Deno.test("configureCopilot: agentCommand depends on binary availability", () => {
  const profile: Profile = { ...baseProfile, agent: "copilot" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = configureCopilot(ctx);

  if (result.agentCommand[0] === "copilot") {
    assertEquals(result.agentCommand, ["copilot"]);
    const hasBinaryMount = result.dockerArgs.some((a) =>
      a.includes("/copilot:ro")
    );
    assertEquals(hasBinaryMount, true);
  } else {
    assertEquals(result.agentCommand[0], "bash");
    assertEquals(
      result.agentCommand[2]?.includes("copilot binary not found"),
      true,
    );
  }
});

Deno.test("configureCopilot: uses NAS_HOME from envVars", () => {
  const profile: Profile = { ...baseProfile, agent: "copilot" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  ctx.envVars["NAS_HOME"] = "/home/custom";
  const result = configureCopilot(ctx);

  // XDG_CONFIG_HOME が未設定の場合、 ~/.copilot を /home/custom/.copilot にマウントする
  // (ディレクトリが存在する場合のみ)
  const home = Deno.env.get("HOME") ?? "/root";
  const hostCopilotDir = `${home}/.copilot`;
  const dirExists = (() => {
    try {
      Deno.statSync(hostCopilotDir);
      return true;
    } catch {
      return false;
    }
  })();

  if (dirExists) {
    const mountArg = result.dockerArgs.find((a) => a.includes(hostCopilotDir));
    assertEquals(mountArg !== undefined, true);
  }
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

Deno.test("configureCodex: agentCommand depends on binary availability", () => {
  const profile: Profile = { ...baseProfile, agent: "codex" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = configureCodex(ctx);

  if (result.agentCommand[0] === "codex") {
    assertEquals(result.agentCommand, ["codex"]);
    const hasBinaryMount = result.dockerArgs.some((a) =>
      a.includes("/codex:ro")
    );
    assertEquals(hasBinaryMount, true);
  } else {
    assertEquals(result.agentCommand[0], "bash");
    assertEquals(
      result.agentCommand[2]?.includes("codex binary not found"),
      true,
    );
  }
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

Deno.test("configureCodex: mounts ~/.codex when it exists", () => {
  const home = Deno.env.get("HOME") ?? "/root";
  const containerHome = getContainerHome();
  const codexDir = `${home}/.codex`;
  const ctx = createContext(
    baseConfig,
    { ...baseProfile, agent: "codex" },
    "test",
    Deno.cwd(),
  );
  const result = configureCodex(ctx);

  const dirExists = (() => {
    try {
      return Deno.statSync(codexDir).isDirectory;
    } catch {
      return false;
    }
  })();

  const mountArg = `${codexDir}:${containerHome}/.codex`;
  if (dirExists) {
    assertEquals(result.dockerArgs.includes(mountArg), true);
  } else {
    assertEquals(result.dockerArgs.includes(mountArg), false);
  }
});

Deno.test("configureCodex: uses NAS_HOME from envVars", () => {
  const profile: Profile = { ...baseProfile, agent: "codex" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  ctx.envVars["NAS_HOME"] = "/home/custom";

  const home = Deno.env.get("HOME") ?? "/root";
  const codexDir = `${home}/.codex`;
  const result = configureCodex(ctx);

  const dirExists = (() => {
    try {
      return Deno.statSync(codexDir).isDirectory;
    } catch {
      return false;
    }
  })();

  if (dirExists) {
    const mountArg = `${codexDir}:/home/custom/.codex`;
    assertEquals(result.dockerArgs.includes(mountArg), true);
  }
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
  const profile: Profile = { ...baseProfile, agent: "copilot" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);

  // agentCommand が設定されている
  assertEquals(result.agentCommand.length > 0, true);
});

Deno.test("MountStage: dispatches to configureCodex for agent=codex", async () => {
  const profile: Profile = { ...baseProfile, agent: "codex" };
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);

  // agentCommand が設定されている
  assertEquals(result.agentCommand.length > 0, true);
});
