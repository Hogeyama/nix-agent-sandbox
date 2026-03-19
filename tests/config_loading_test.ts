/**
 * E2E tests: 設定ファイルの読み込み・検索・マージ
 *
 * 実際のファイルシステム上に YAML ファイルを配置して loadConfig / resolveProfile を検証する。
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as path from "@std/path";
import {
  loadConfig,
  mergeRawConfigs,
  mergeRawProfiles,
  resolveProfile,
} from "../src/config/load.ts";
import { validateConfig } from "../src/config/validate.ts";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  type RawConfig,
  type RawProfile,
} from "../src/config/types.ts";

/** 一時ディレクトリに設定ファイルを配置してテストを実行するヘルパー */
async function withTempConfig(
  yaml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cfg-test-" });
  try {
    await Deno.writeTextFile(
      path.join(tmpDir, ".agent-sandbox.yml"),
      yaml,
    );
    await fn(tmpDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

/** ネストされたディレクトリ構造を作成して設定ファイルの上位検索をテスト */
async function withNestedDirs(
  fn: (
    rootDir: string,
    childDir: string,
    grandchildDir: string,
  ) => Promise<void>,
): Promise<void> {
  const rootDir = await Deno.makeTempDir({ prefix: "nas-cfg-nested-" });
  const childDir = path.join(rootDir, "child");
  const grandchildDir = path.join(childDir, "grandchild");
  try {
    await Deno.mkdir(grandchildDir, { recursive: true });
    await fn(rootDir, childDir, grandchildDir);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
}

// --- loadConfig: ファイルシステムからの読み込み ---

Deno.test("loadConfig: loads minimal YAML file from directory", async () => {
  const yaml = `
profiles:
  dev:
    agent: claude
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    assertEquals(config.profiles.dev.agent, "claude");
    assertEquals(config.profiles.dev.nix.enable, "auto");
    assertEquals(config.profiles.dev.docker.enable, false);
    assertEquals(config.profiles.dev.env, []);
    assertEquals(config.profiles.dev.extraMounts, []);
  });
});

Deno.test("loadConfig: loads minimal codex profile", async () => {
  const yaml = `
profiles:
  codex-dev:
    agent: codex
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    assertEquals(config.profiles["codex-dev"].agent, "codex");
    assertEquals(config.profiles["codex-dev"].agentArgs, []);
  });
});

Deno.test("loadConfig: loads full YAML with all profile fields", async () => {
  const yaml = `
default: full
profiles:
  full:
    agent: copilot
    agent-args:
      - "--yolo"
      - "--verbose"
    worktree:
      base: origin/develop
      on-create: "npm ci"
    nix:
      enable: true
      mount-socket: true
      extra-packages:
        - nixpkgs#ripgrep
        - nixpkgs#fd
    docker:
      enable: true
    gcloud:
      mount-config: true
    aws:
      mount-config: true
    gpg:
      forward-agent: true
    extra-mounts:
      - src: /tmp
        dst: /mnt/host-tmp
        mode: rw
    env:
      - key: MY_VAR
        val: my_value
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    const p = config.profiles.full;
    assertEquals(config.default, "full");
    assertEquals(p.agent, "copilot");
    assertEquals(p.agentArgs, ["--yolo", "--verbose"]);
    assertEquals(p.worktree?.base, "origin/develop");
    assertEquals(p.worktree?.onCreate, "npm ci");
    assertEquals(p.nix.enable, true);
    assertEquals(p.nix.mountSocket, true);
    assertEquals(p.nix.extraPackages, ["nixpkgs#ripgrep", "nixpkgs#fd"]);
    assertEquals(p.docker.enable, true);
    assertEquals(p.docker.shared, false);
    assertEquals(p.aws.mountConfig, true);
    assertEquals(p.gpg.forwardAgent, true);
    assertEquals(p.extraMounts.length, 1);
    assertEquals(p.extraMounts[0], {
      src: "/tmp",
      dst: "/mnt/host-tmp",
      mode: "rw",
    });
    assertEquals(p.env[0], { key: "MY_VAR", val: "my_value" });
  });
});

Deno.test("loadConfig: multiple profiles in single file", async () => {
  const yaml = `
default: claude-dev
profiles:
  claude-dev:
    agent: claude
  copilot-dev:
    agent: copilot
    agent-args:
      - "--yolo"
  codex-dev:
    agent: codex
  claude-nix:
    agent: claude
    nix:
      enable: true
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    assertEquals(Object.keys(config.profiles).length, 4);
    assertEquals(config.profiles["claude-dev"].agent, "claude");
    assertEquals(config.profiles["copilot-dev"].agent, "copilot");
    assertEquals(config.profiles["codex-dev"].agent, "codex");
    assertEquals(config.profiles["copilot-dev"].agentArgs, ["--yolo"]);
    assertEquals(config.profiles["claude-nix"].nix.enable, true);
  });
});

Deno.test("loadConfig: searches upward for config file", async () => {
  await withNestedDirs(async (rootDir, _childDir, grandchildDir) => {
    // rootDir にだけ設定ファイルを置く
    await Deno.writeTextFile(
      path.join(rootDir, ".agent-sandbox.yml"),
      `
profiles:
  test:
    agent: claude
`,
    );

    // grandchildDir から検索開始 → rootDir の設定を見つける
    const config = await loadConfig({
      startDir: grandchildDir,
      globalConfigPath: null,
    });
    assertEquals(config.profiles.test.agent, "claude");
  });
});

Deno.test("loadConfig: nearest config file wins over parent", async () => {
  await withNestedDirs(async (rootDir, childDir, grandchildDir) => {
    // rootDir に設定
    await Deno.writeTextFile(
      path.join(rootDir, ".agent-sandbox.yml"),
      `
profiles:
  parent-profile:
    agent: copilot
`,
    );
    // childDir にも設定
    await Deno.writeTextFile(
      path.join(childDir, ".agent-sandbox.yml"),
      `
profiles:
  child-profile:
    agent: claude
`,
    );

    // grandchildDir から検索 → childDir の設定を見つける
    const config = await loadConfig({
      startDir: grandchildDir,
      globalConfigPath: null,
    });
    assertEquals("child-profile" in config.profiles, true);
    assertEquals("parent-profile" in config.profiles, false);
  });
});

Deno.test("loadConfig: throws when no config file found", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cfg-empty-" });
  try {
    await assertRejects(
      () => loadConfig({ startDir: tmpDir, globalConfigPath: null }),
      Error,
      "not found",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("loadConfig: throws for empty profiles", async () => {
  const yaml = `
profiles: {}
`;
  await withTempConfig(yaml, async (dir) => {
    await assertRejects(
      () => loadConfig({ startDir: dir, globalConfigPath: null }),
      Error,
      "at least one entry",
    );
  });
});

Deno.test("loadConfig: throws for invalid agent type in YAML", async () => {
  const yaml = `
profiles:
  test:
    agent: invalid_agent
`;
  await withTempConfig(yaml, async (dir) => {
    await assertRejects(
      () => loadConfig({ startDir: dir, globalConfigPath: null }),
      Error,
      "agent must be one of",
    );
  });
});

Deno.test("loadConfig: throws for YAML with no agent field", async () => {
  const yaml = `
profiles:
  test:
    nix:
      enable: true
`;
  await withTempConfig(yaml, async (dir) => {
    await assertRejects(
      () => loadConfig({ startDir: dir, globalConfigPath: null }),
      Error,
      "agent must be one of",
    );
  });
});

Deno.test("loadConfig: handles nix enable=false from YAML", async () => {
  const yaml = `
profiles:
  test:
    agent: claude
    nix:
      enable: false
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    assertEquals(config.profiles.test.nix.enable, false);
  });
});

Deno.test("loadConfig: handles nix enable=auto from YAML", async () => {
  const yaml = `
profiles:
  test:
    agent: claude
    nix:
      enable: auto
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    assertEquals(config.profiles.test.nix.enable, "auto");
  });
});

Deno.test("loadConfig: env with command entries from YAML", async () => {
  const yaml = `
profiles:
  test:
    agent: claude
    env:
      - key: STATIC
        val: hello
      - key_cmd: "printf DYNAMIC"
        val_cmd: "printf world"
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    assertEquals(config.profiles.test.env.length, 2);
    assertEquals(config.profiles.test.env[0], { key: "STATIC", val: "hello" });
    assertEquals(config.profiles.test.env[1], {
      keyCmd: "printf DYNAMIC",
      valCmd: "printf world",
    });
  });
});

Deno.test("loadConfig: worktree with defaults from YAML", async () => {
  const yaml = `
profiles:
  test:
    agent: claude
    worktree: {}
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    assertEquals(config.profiles.test.worktree?.base, "origin/main");
    assertEquals(config.profiles.test.worktree?.onCreate, "");
  });
});

Deno.test("loadConfig: extra-mounts mode defaults to ro from YAML", async () => {
  const yaml = `
profiles:
  test:
    agent: claude
    extra-mounts:
      - src: /tmp
        dst: /mnt/tmp
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    assertEquals(config.profiles.test.extraMounts[0].mode, "ro");
  });
});

// --- resolveProfile ---

Deno.test("resolveProfile: resolves by explicit name", () => {
  const config: Config = {
    default: "default-profile",
    profiles: {
      "default-profile": {
        agent: "claude",
        agentArgs: [],
        nix: { enable: "auto", mountSocket: true, extraPackages: [] },
        docker: { enable: false, shared: false },
        gcloud: { mountConfig: false },
        aws: { mountConfig: false },
        gpg: { forwardAgent: false },
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        extraMounts: [],
        env: [],
      },
      "other-profile": {
        agent: "copilot",
        agentArgs: ["--yolo"],
        nix: { enable: false, mountSocket: false, extraPackages: [] },
        docker: { enable: false, shared: false },
        gcloud: { mountConfig: false },
        aws: { mountConfig: false },
        gpg: { forwardAgent: false },
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        extraMounts: [],
        env: [],
      },
    },
  };

  const { name, profile } = resolveProfile(config, "other-profile");
  assertEquals(name, "other-profile");
  assertEquals(profile.agent, "copilot");
  assertEquals(profile.agentArgs, ["--yolo"]);
});

Deno.test("resolveProfile: falls back to default profile", () => {
  const config: Config = {
    default: "my-default",
    profiles: {
      "my-default": {
        agent: "claude",
        agentArgs: [],
        nix: { enable: "auto", mountSocket: true, extraPackages: [] },
        docker: { enable: false, shared: false },
        gcloud: { mountConfig: false },
        aws: { mountConfig: false },
        gpg: { forwardAgent: false },
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        extraMounts: [],
        env: [],
      },
    },
  };

  const { name, profile } = resolveProfile(config);
  assertEquals(name, "my-default");
  assertEquals(profile.agent, "claude");
});

Deno.test("resolveProfile: auto-selects when only one profile and no default", () => {
  const config: Config = {
    profiles: {
      "only-one": {
        agent: "copilot",
        agentArgs: [],
        nix: { enable: false, mountSocket: false, extraPackages: [] },
        docker: { enable: false, shared: false },
        gcloud: { mountConfig: false },
        aws: { mountConfig: false },
        gpg: { forwardAgent: false },
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        extraMounts: [],
        env: [],
      },
    },
  };

  const { name, profile } = resolveProfile(config);
  assertEquals(name, "only-one");
  assertEquals(profile.agent, "copilot");
});

Deno.test("resolveProfile: throws when multiple profiles and no default", () => {
  const config: Config = {
    profiles: {
      "a": {
        agent: "claude",
        agentArgs: [],
        nix: { enable: "auto", mountSocket: true, extraPackages: [] },
        docker: { enable: false, shared: false },
        gcloud: { mountConfig: false },
        aws: { mountConfig: false },
        gpg: { forwardAgent: false },
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        extraMounts: [],
        env: [],
      },
      "b": {
        agent: "copilot",
        agentArgs: [],
        nix: { enable: false, mountSocket: false, extraPackages: [] },
        docker: { enable: false, shared: false },
        gcloud: { mountConfig: false },
        aws: { mountConfig: false },
        gpg: { forwardAgent: false },
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        extraMounts: [],
        env: [],
      },
    },
  };

  assertThrows(
    () => resolveProfile(config),
    Error,
    "No profile specified and no default set",
  );
});

Deno.test("resolveProfile: throws for nonexistent profile name", () => {
  const config: Config = {
    profiles: {
      "exists": {
        agent: "claude",
        agentArgs: [],
        nix: { enable: "auto", mountSocket: true, extraPackages: [] },
        docker: { enable: false, shared: false },
        gcloud: { mountConfig: false },
        aws: { mountConfig: false },
        gpg: { forwardAgent: false },
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        extraMounts: [],
        env: [],
      },
    },
  };

  assertThrows(
    () => resolveProfile(config, "nonexistent"),
    Error,
    'Profile "nonexistent" not found',
  );
});

// --- mergeRawConfigs ---

Deno.test("mergeRawConfigs: global only", () => {
  const global: RawConfig = {
    default: "g",
    profiles: { g: { agent: "claude" } },
  };
  const merged = mergeRawConfigs(global, null);
  assertEquals(merged.default, "g");
  assertEquals(merged.profiles!.g.agent, "claude");
});

Deno.test("mergeRawConfigs: local only", () => {
  const local: RawConfig = {
    default: "l",
    profiles: { l: { agent: "copilot" } },
  };
  const merged = mergeRawConfigs(null, local);
  assertEquals(merged.default, "l");
  assertEquals(merged.profiles!.l.agent, "copilot");
});

Deno.test("mergeRawConfigs: local default overrides global", () => {
  const global: RawConfig = {
    default: "global-default",
    profiles: { g: { agent: "claude" } },
  };
  const local: RawConfig = {
    default: "local-default",
    profiles: { l: { agent: "copilot" } },
  };
  const merged = mergeRawConfigs(global, local);
  assertEquals(merged.default, "local-default");
});

Deno.test("mergeRawConfigs: profiles from both sources are included", () => {
  const global: RawConfig = {
    profiles: {
      "global-only": { agent: "claude" },
      "shared": { agent: "claude", "agent-args": ["--global"] },
    },
  };
  const local: RawConfig = {
    profiles: {
      "local-only": { agent: "copilot" },
      "shared": { agent: "copilot" },
    },
  };
  const merged = mergeRawConfigs(global, local);
  assertEquals("global-only" in merged.profiles!, true);
  assertEquals("local-only" in merged.profiles!, true);
  assertEquals("shared" in merged.profiles!, true);
  // shared profile: local agent wins
  assertEquals(merged.profiles!.shared.agent, "copilot");
});

// --- mergeRawProfiles ---

Deno.test("mergeRawProfiles: local agent overrides global", () => {
  const global: RawProfile = { agent: "claude" };
  const local: RawProfile = { agent: "copilot" };
  const merged = mergeRawProfiles(global, local);
  assertEquals(merged.agent, "copilot");
});

Deno.test("mergeRawProfiles: local inherits global agent when not set", () => {
  const global: RawProfile = { agent: "claude" };
  const local: RawProfile = { "agent-args": ["--verbose"] };
  const merged = mergeRawProfiles(global, local);
  assertEquals(merged.agent, "claude");
  assertEquals(merged["agent-args"], ["--verbose"]);
});

Deno.test("mergeRawProfiles: nix config is shallow merged", () => {
  const global: RawProfile = {
    agent: "claude",
    nix: { enable: true, "mount-socket": false },
  };
  const local: RawProfile = {
    nix: { "mount-socket": true },
  };
  const merged = mergeRawProfiles(global, local);
  assertEquals(merged.nix?.enable, true); // from global
  assertEquals(merged.nix?.["mount-socket"], true); // from local
});

Deno.test("mergeRawProfiles: docker config is shallow merged", () => {
  const global: RawProfile = {
    agent: "claude",
    docker: { enable: false, shared: false },
  };
  const local: RawProfile = {
    docker: { enable: true, shared: false },
  };
  const merged = mergeRawProfiles(global, local);
  assertEquals(merged.docker?.enable, true);
});

Deno.test("mergeRawProfiles: env is replaced (not merged)", () => {
  const global: RawProfile = {
    agent: "claude",
    env: [{ key: "A", val: "1" }],
  };
  const local: RawProfile = {
    env: [{ key: "B", val: "2" }],
  };
  const merged = mergeRawProfiles(global, local);
  assertEquals(merged.env?.length, 1);
  assertEquals(merged.env?.[0].key, "B");
});

Deno.test("mergeRawProfiles: agent-args is replaced (not merged)", () => {
  const global: RawProfile = {
    agent: "claude",
    "agent-args": ["--global-arg"],
  };
  const local: RawProfile = {
    "agent-args": ["--local-arg"],
  };
  const merged = mergeRawProfiles(global, local);
  assertEquals(merged["agent-args"], ["--local-arg"]);
});

Deno.test("mergeRawProfiles: worktree is shallow merged", () => {
  const global: RawProfile = {
    agent: "claude",
    worktree: { base: "origin/main", "on-create": "make build" },
  };
  const local: RawProfile = {
    worktree: { base: "origin/develop" },
  };
  const merged = mergeRawProfiles(global, local);
  assertEquals(merged.worktree?.base, "origin/develop");
  assertEquals(merged.worktree?.["on-create"], "make build"); // global preserved
});

Deno.test("mergeRawProfiles: gcloud config is shallow merged", () => {
  const global: RawProfile = {
    agent: "claude",
    gcloud: { "mount-config": false },
  };
  const local: RawProfile = {
    gcloud: { "mount-config": true },
  };
  const merged = mergeRawProfiles(global, local);
  assertEquals(merged.gcloud?.["mount-config"], true);
});

Deno.test("mergeRawProfiles: aws config is shallow merged", () => {
  const global: RawProfile = {
    agent: "claude",
    aws: { "mount-config": false },
  };
  const local: RawProfile = {
    aws: { "mount-config": true },
  };
  const merged = mergeRawProfiles(global, local);
  assertEquals(merged.aws?.["mount-config"], true);
});

Deno.test("mergeRawProfiles: gpg config is shallow merged", () => {
  const global: RawProfile = {
    agent: "claude",
    gpg: { "forward-agent": false },
  };
  const local: RawProfile = {
    gpg: { "forward-agent": true },
  };
  const merged = mergeRawProfiles(global, local);
  assertEquals(merged.gpg?.["forward-agent"], true);
});

Deno.test("mergeRawProfiles: dbus config is shallow merged", () => {
  const global: RawProfile = {
    agent: "claude",
    dbus: {
      session: {
        enable: true,
        see: ["org.freedesktop.secrets"],
      },
    },
  };
  const local: RawProfile = {
    dbus: {
      session: {
        talk: ["org.freedesktop.secrets"],
      },
    },
  };
  const merged = mergeRawProfiles(global, local);
  assertEquals(merged.dbus?.session?.enable, true);
  assertEquals(merged.dbus?.session?.see, ["org.freedesktop.secrets"]);
  assertEquals(merged.dbus?.session?.talk, ["org.freedesktop.secrets"]);
});

Deno.test("mergeRawProfiles: hostexec secrets are shallow merged", () => {
  const global: RawProfile = {
    agent: "claude",
    hostexec: {
      secrets: {
        github_token: {
          from: "env:GITHUB_TOKEN",
          required: true,
        },
      },
    },
  };
  const local: RawProfile = {
    hostexec: {
      secrets: {
        github_token: {
          from: "env:OVERRIDE_GITHUB_TOKEN",
          required: false,
        },
      },
    },
  };
  const merged = mergeRawProfiles(global, local);
  assertEquals(merged.hostexec?.secrets, {
    github_token: {
      from: "env:OVERRIDE_GITHUB_TOKEN",
      required: false,
    },
  });
});

// --- validateConfig: 追加のバリデーション E2E テスト ---

Deno.test("validateConfig: multiple profiles each independently validated", () => {
  const raw: RawConfig = {
    profiles: {
      a: { agent: "claude" },
      b: { agent: "copilot", "agent-args": ["--flag"] },
      c: {
        agent: "claude",
        nix: { enable: true },
        docker: { enable: true, shared: false },
      },
    },
  };
  const config = validateConfig(raw);
  assertEquals(config.profiles.a.agent, "claude");
  assertEquals(config.profiles.b.agent, "copilot");
  assertEquals(config.profiles.b.agentArgs, ["--flag"]);
  assertEquals(config.profiles.c.nix.enable, true);
  assertEquals(config.profiles.c.docker.enable, true);
});

Deno.test("validateConfig: extra-mounts with all modes", () => {
  const raw: RawConfig = {
    profiles: {
      test: {
        agent: "claude",
        "extra-mounts": [
          { src: "/a", dst: "/b", mode: "ro" },
          { src: "/c", dst: "/d", mode: "rw" },
          { src: "/e", dst: "/f" }, // defaults to ro
        ],
      },
    },
  };
  const config = validateConfig(raw);
  assertEquals(config.profiles.test.extraMounts[0].mode, "ro");
  assertEquals(config.profiles.test.extraMounts[1].mode, "rw");
  assertEquals(config.profiles.test.extraMounts[2].mode, "ro");
});

Deno.test("validateConfig: empty env list is valid", () => {
  const raw: RawConfig = {
    profiles: {
      test: {
        agent: "claude",
        env: [],
      },
    },
  };
  const config = validateConfig(raw);
  assertEquals(config.profiles.test.env, []);
});

Deno.test("validateConfig: nix.extra-packages preserved", () => {
  const raw: RawConfig = {
    profiles: {
      test: {
        agent: "claude",
        nix: {
          "extra-packages": ["nixpkgs#gh", "nixpkgs#jq", "nixpkgs#ripgrep"],
        },
      },
    },
  };
  const config = validateConfig(raw);
  assertEquals(config.profiles.test.nix.extraPackages, [
    "nixpkgs#gh",
    "nixpkgs#jq",
    "nixpkgs#ripgrep",
  ]);
});

// --- loadConfig + resolveProfile E2E (ファイル → プロファイル解決) ---

Deno.test("E2E: load YAML and resolve default profile", async () => {
  const yaml = `
default: production
profiles:
  staging:
    agent: copilot
  production:
    agent: claude
    agent-args:
      - "--dangerously-skip-permissions"
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    const { name, profile } = resolveProfile(config);
    assertEquals(name, "production");
    assertEquals(profile.agent, "claude");
    assertEquals(profile.agentArgs, ["--dangerously-skip-permissions"]);
  });
});

Deno.test("E2E: load YAML and resolve explicit profile", async () => {
  const yaml = `
default: production
profiles:
  staging:
    agent: copilot
    agent-args:
      - "--yolo"
  production:
    agent: claude
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    const { name, profile } = resolveProfile(config, "staging");
    assertEquals(name, "staging");
    assertEquals(profile.agent, "copilot");
    assertEquals(profile.agentArgs, ["--yolo"]);
  });
});

Deno.test("E2E: load YAML with single profile auto-resolves", async () => {
  const yaml = `
profiles:
  only:
    agent: claude
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    const { name, profile } = resolveProfile(config);
    assertEquals(name, "only");
    assertEquals(profile.agent, "claude");
  });
});

Deno.test("E2E: load YAML from nested directory and resolve", async () => {
  await withNestedDirs(async (rootDir, _childDir, grandchildDir) => {
    await Deno.writeTextFile(
      path.join(rootDir, ".agent-sandbox.yml"),
      `
default: nested-test
profiles:
  nested-test:
    agent: copilot
    nix:
      enable: false
`,
    );

    const config = await loadConfig({
      startDir: grandchildDir,
      globalConfigPath: null,
    });
    const { name, profile } = resolveProfile(config);
    assertEquals(name, "nested-test");
    assertEquals(profile.agent, "copilot");
    assertEquals(profile.nix.enable, false);
  });
});

Deno.test("E2E: complex YAML with worktree, env, extra-mounts all together", async () => {
  const yaml = `
default: full-stack
profiles:
  full-stack:
    agent: claude
    agent-args:
      - "--dangerously-skip-permissions"
    worktree:
      base: origin/main
      on-create: "npm install && npm run build"
    nix:
      enable: true
      mount-socket: true
      extra-packages:
        - nixpkgs#ripgrep
    docker:
      enable: true
    gcloud:
      mount-config: true
    aws:
      mount-config: true
    gpg:
      forward-agent: true
    extra-mounts:
      - src: /tmp/data
        dst: /data
        mode: rw
    env:
      - key: NODE_ENV
        val: development
      - key_cmd: "printf REGION"
        val_cmd: "printf us-east-1"
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    const { profile } = resolveProfile(config);
    assertEquals(profile.agent, "claude");
    assertEquals(profile.agentArgs, ["--dangerously-skip-permissions"]);
    assertEquals(profile.worktree?.base, "origin/main");
    assertEquals(profile.worktree?.onCreate, "npm install && npm run build");
    assertEquals(profile.nix.enable, true);
    assertEquals(profile.nix.extraPackages, ["nixpkgs#ripgrep"]);
    assertEquals(profile.docker.enable, true);
    assertEquals(profile.gcloud.mountConfig, true);
    assertEquals(profile.aws.mountConfig, true);
    assertEquals(profile.gpg.forwardAgent, true);
    assertEquals(profile.extraMounts.length, 1);
    assertEquals(profile.env.length, 2);
  });
});

// --- .agent-sandbox.nix support ---

/** 一時ディレクトリに .nix 設定ファイルを配置してテストを実行するヘルパー */
async function withTempNixConfig(
  nixExpr: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cfg-nix-test-" });
  try {
    await Deno.writeTextFile(
      path.join(tmpDir, ".agent-sandbox.nix"),
      nixExpr,
    );
    await fn(tmpDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("loadConfig: loads .agent-sandbox.nix when no .yml exists", async () => {
  const nixExpr = `
{
  profiles = {
    dev = {
      agent = "claude";
    };
  };
}
`;
  await withTempNixConfig(nixExpr, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    assertEquals(config.profiles.dev.agent, "claude");
    assertEquals(config.profiles.dev.nix.enable, "auto");
  });
});

Deno.test("loadConfig: .yml takes priority over .nix", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-cfg-priority-" });
  try {
    await Deno.writeTextFile(
      path.join(tmpDir, ".agent-sandbox.yml"),
      `
profiles:
  from-yml:
    agent: claude
`,
    );
    await Deno.writeTextFile(
      path.join(tmpDir, ".agent-sandbox.nix"),
      `
{
  profiles = {
    from-nix = {
      agent = "copilot";
    };
  };
}
`,
    );
    const config = await loadConfig({
      startDir: tmpDir,
      globalConfigPath: null,
    });
    assertEquals("from-yml" in config.profiles, true);
    assertEquals("from-nix" in config.profiles, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("loadConfig: .nix with full profile fields", async () => {
  const nixExpr = `
{
  default = "full";
  profiles = {
    full = {
      agent = "copilot";
      agent-args = [ "--yolo" "--verbose" ];
      nix = {
        enable = true;
        mount-socket = true;
        extra-packages = [ "nixpkgs#ripgrep" ];
      };
      docker = {
        enable = true;
      };
      extra-mounts = [
        { src = "/tmp"; dst = "/mnt/tmp"; mode = "rw"; }
      ];
      env = [
        { key = "MY_VAR"; val = "my_value"; }
      ];
    };
  };
}
`;
  await withTempNixConfig(nixExpr, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    const p = config.profiles.full;
    assertEquals(config.default, "full");
    assertEquals(p.agent, "copilot");
    assertEquals(p.agentArgs, ["--yolo", "--verbose"]);
    assertEquals(p.nix.enable, true);
    assertEquals(p.nix.mountSocket, true);
    assertEquals(p.nix.extraPackages, ["nixpkgs#ripgrep"]);
    assertEquals(p.docker.enable, true);
    assertEquals(p.extraMounts.length, 1);
    assertEquals(p.extraMounts[0].mode, "rw");
    assertEquals(p.env[0], { key: "MY_VAR", val: "my_value" });
  });
});

Deno.test("loadConfig: searches upward for .nix config file", async () => {
  await withNestedDirs(async (rootDir, _childDir, grandchildDir) => {
    await Deno.writeTextFile(
      path.join(rootDir, ".agent-sandbox.nix"),
      `
{
  profiles = {
    test = {
      agent = "claude";
    };
  };
}
`,
    );
    const config = await loadConfig({
      startDir: grandchildDir,
      globalConfigPath: null,
    });
    assertEquals(config.profiles.test.agent, "claude");
  });
});

Deno.test("loadConfig: throws for invalid nix expression", async () => {
  const nixExpr = `{ invalid syntax !!!`;
  await withTempNixConfig(nixExpr, async (dir) => {
    await assertRejects(
      () => loadConfig({ startDir: dir, globalConfigPath: null }),
      Error,
      "Failed to evaluate",
    );
  });
});
