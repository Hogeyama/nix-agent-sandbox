/**
 * 設定ファイルの読み込み・検索・マージの統合テスト
 *
 * 実際のファイルシステム上に YAML ファイルを配置して loadConfig / resolveProfile を検証する。
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as path from "@std/path";
import { loadConfig, loadGlobalConfig, resolveProfile } from "./load.ts";
import { validateConfig } from "./validate.ts";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
  type RawConfig,
} from "./types.ts";

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
    assertEquals(p.env[0], { key: "MY_VAR", val: "my_value", mode: "set" });
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
    assertEquals(config.profiles.test.env[0], {
      key: "STATIC",
      val: "hello",
      mode: "set",
    });
    assertEquals(config.profiles.test.env[1], {
      keyCmd: "printf DYNAMIC",
      valCmd: "printf world",
      mode: "set",
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
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
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
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
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
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
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
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
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
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
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
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
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
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
  };

  assertThrows(
    () => resolveProfile(config, "nonexistent"),
    Error,
    'Profile "nonexistent" not found',
  );
});

// --- validateConfig: 追加のバリデーションテスト ---

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

// --- loadConfig + resolveProfile 統合テスト (ファイル → プロファイル解決) ---

Deno.test("loadConfig + resolveProfile: load YAML and resolve default profile", async () => {
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

Deno.test("loadConfig + resolveProfile: load YAML and resolve explicit profile", async () => {
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

Deno.test("loadConfig + resolveProfile: load YAML with single profile auto-resolves", async () => {
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

Deno.test("loadConfig + resolveProfile: load YAML from nested directory and resolve", async () => {
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

Deno.test("loadConfig + resolveProfile: complex YAML with worktree, env, extra-mounts all together", async () => {
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
    assertEquals(p.env[0], { key: "MY_VAR", val: "my_value", mode: "set" });
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

// --- XDG_CONFIG_HOME サポート ---

/** XDG_CONFIG_HOME を一時的に差し替えてテストを実行するヘルパー */
async function withXdgConfigHome(
  xdgDir: string,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = Deno.env.get("XDG_CONFIG_HOME");
  Deno.env.set("XDG_CONFIG_HOME", xdgDir);
  try {
    await fn();
  } finally {
    if (prev !== undefined) {
      Deno.env.set("XDG_CONFIG_HOME", prev);
    } else {
      Deno.env.delete("XDG_CONFIG_HOME");
    }
  }
}

Deno.test(
  "loadGlobalConfig: uses XDG_CONFIG_HOME when set",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "nas-xdg-test-" });
    try {
      const nasDir = path.join(tmpDir, "nas");
      await Deno.mkdir(nasDir);
      await Deno.writeTextFile(
        path.join(nasDir, "agent-sandbox.yml"),
        `
profiles:
  xdg-profile:
    agent: claude
`,
      );
      await withXdgConfigHome(tmpDir, async () => {
        const result = await loadGlobalConfig();
        assertEquals(result?.profiles?.["xdg-profile"]?.agent, "claude");
      });
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "loadGlobalConfig: falls back to HOME/.config/nas without XDG_CONFIG_HOME",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "nas-home-test-" });
    try {
      const nasDir = path.join(tmpDir, ".config", "nas");
      await Deno.mkdir(nasDir, { recursive: true });
      await Deno.writeTextFile(
        path.join(nasDir, "agent-sandbox.yml"),
        `
profiles:
  home-profile:
    agent: copilot
`,
      );
      const prevHome = Deno.env.get("HOME");
      const prevXdg = Deno.env.get("XDG_CONFIG_HOME");
      Deno.env.set("HOME", tmpDir);
      if (prevXdg !== undefined) Deno.env.delete("XDG_CONFIG_HOME");
      try {
        const result = await loadGlobalConfig();
        assertEquals(result?.profiles?.["home-profile"]?.agent, "copilot");
      } finally {
        if (prevHome !== undefined) Deno.env.set("HOME", prevHome);
        if (prevXdg !== undefined) Deno.env.set("XDG_CONFIG_HOME", prevXdg);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

// --- 明示パスのエラー伝播 ---

Deno.test(
  "loadGlobalConfig: throws for explicit path with malformed YAML",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "nas-cfg-err-" });
    try {
      const cfgPath = path.join(tmpDir, "bad.yml");
      await Deno.writeTextFile(cfgPath, "{{{{ : invalid yaml : }}}}");
      await assertRejects(
        () => loadGlobalConfig(cfgPath),
        Error,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "loadGlobalConfig: throws for explicit path that does not exist",
  async () => {
    await assertRejects(
      () => loadGlobalConfig("/nonexistent/nas/config.yml"),
      Deno.errors.NotFound,
    );
  },
);

// --- 自動検出グローバル設定のエラー伝播 ---

Deno.test(
  "loadGlobalConfig: throws for malformed YAML in discovered global config",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "nas-xdg-err-" });
    try {
      const nasDir = path.join(tmpDir, "nas");
      await Deno.mkdir(nasDir);
      await Deno.writeTextFile(
        path.join(nasDir, "agent-sandbox.yml"),
        "{{{{ : invalid yaml : }}}}",
      );
      await withXdgConfigHome(tmpDir, async () => {
        await assertRejects(
          () => loadGlobalConfig(),
          Error,
        );
      });
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "loadGlobalConfig: returns null when no global config file exists",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "nas-xdg-empty-" });
    try {
      // nasDir 自体を作らない → stat で NotFound → fall through → null
      await withXdgConfigHome(tmpDir, async () => {
        const result = await loadGlobalConfig();
        assertEquals(result, null);
      });
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);
