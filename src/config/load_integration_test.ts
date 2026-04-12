import { expect, spyOn, test } from "bun:test";

/**
 * 設定ファイルの読み込み・検索・マージの統合テスト
 *
 * 実際のファイルシステム上に YAML ファイルを配置して loadConfig / resolveProfile を検証する。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadConfig, loadGlobalConfig, resolveProfile } from "./load.ts";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
  type RawConfig,
} from "./types.ts";
import { validateConfig } from "./validate.ts";

/** 一時ディレクトリに設定ファイルを配置してテストを実行するヘルパー */
async function withTempConfig(
  yaml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-test-"));
  try {
    await writeFile(path.join(tmpDir, ".agent-sandbox.yml"), yaml);
    await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
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
  const rootDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-nested-"));
  const childDir = path.join(rootDir, "child");
  const grandchildDir = path.join(childDir, "grandchild");
  try {
    await mkdir(grandchildDir, { recursive: true });
    await fn(rootDir, childDir, grandchildDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

// Note: stat mocking is done via bun:test mock.module in tests that need it.
// The withMockedStat helper is kept for reference but stat from node:fs/promises
// cannot be easily monkey-patched. Tests using this pattern should use file-system
// based test fixtures instead.

// --- loadConfig: ファイルシステムからの読み込み ---

test("loadConfig: loads minimal YAML file from directory", async () => {
  const yaml = `
profiles:
  dev:
    agent: claude
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    expect(config.profiles.dev.agent).toEqual("claude");
    expect(config.profiles.dev.nix.enable).toEqual("auto");
    expect(config.profiles.dev.docker.enable).toEqual(false);
    expect(config.profiles.dev.env).toEqual([]);
    expect(config.profiles.dev.extraMounts).toEqual([]);
  });
});

test("loadConfig: loads minimal codex profile", async () => {
  const yaml = `
profiles:
  codex-dev:
    agent: codex
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    expect(config.profiles["codex-dev"].agent).toEqual("codex");
    expect(config.profiles["codex-dev"].agentArgs).toEqual([]);
  });
});

test("loadConfig: loads full YAML with all profile fields", async () => {
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
    expect(config.default).toEqual("full");
    expect(p.agent).toEqual("copilot");
    expect(p.agentArgs).toEqual(["--yolo", "--verbose"]);
    expect(p.worktree?.base).toEqual("origin/develop");
    expect(p.worktree?.onCreate).toEqual("npm ci");
    expect(p.nix.enable).toEqual(true);
    expect(p.nix.mountSocket).toEqual(true);
    expect(p.nix.extraPackages).toEqual(["nixpkgs#ripgrep", "nixpkgs#fd"]);
    expect(p.docker.enable).toEqual(true);
    expect(p.docker.shared).toEqual(false);
    expect(p.aws.mountConfig).toEqual(true);
    expect(p.gpg.forwardAgent).toEqual(true);
    expect(p.extraMounts.length).toEqual(1);
    expect(p.extraMounts[0]).toEqual({
      src: "/tmp",
      dst: "/mnt/host-tmp",
      mode: "rw",
    });
    expect(p.env[0]).toEqual({ key: "MY_VAR", val: "my_value", mode: "set" });
  });
});

test("loadConfig: multiple profiles in single file", async () => {
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
    expect(Object.keys(config.profiles).length).toEqual(4);
    expect(config.profiles["claude-dev"].agent).toEqual("claude");
    expect(config.profiles["copilot-dev"].agent).toEqual("copilot");
    expect(config.profiles["codex-dev"].agent).toEqual("codex");
    expect(config.profiles["copilot-dev"].agentArgs).toEqual(["--yolo"]);
    expect(config.profiles["claude-nix"].nix.enable).toEqual(true);
  });
});

test("loadConfig: searches upward for config file", async () => {
  await withNestedDirs(async (rootDir, _childDir, grandchildDir) => {
    // rootDir にだけ設定ファイルを置く
    await writeFile(
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
    expect(config.profiles.test.agent).toEqual("claude");
  });
});

test("loadConfig: nearest config file wins over parent", async () => {
  await withNestedDirs(async (rootDir, childDir, grandchildDir) => {
    // rootDir に設定
    await writeFile(
      path.join(rootDir, ".agent-sandbox.yml"),
      `
profiles:
  parent-profile:
    agent: copilot
`,
    );
    // childDir にも設定
    await writeFile(
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
    expect("child-profile" in config.profiles).toEqual(true);
    expect("parent-profile" in config.profiles).toEqual(false);
  });
});

import * as nodeFs from "node:fs/promises";

test("loadConfig: propagates config discovery stat errors", async () => {
  await withNestedDirs(async (rootDir, childDir, grandchildDir) => {
    await writeFile(
      path.join(rootDir, ".agent-sandbox.yml"),
      `
profiles:
  parent-profile:
    agent: claude
`,
    );

    const blockedPath = path.join(childDir, ".agent-sandbox.yml");
    const originalStat = nodeFs.stat;
    const statSpy = spyOn(nodeFs, "stat");
    statSpy.mockImplementation((async (target: any, ...rest: any[]) => {
      const targetPath =
        target instanceof URL ? target.pathname : String(target);
      if (targetPath === blockedPath) {
        throw new Error("blocked child config");
      }
      return await originalStat(target, ...rest);
    }) as typeof nodeFs.stat);
    try {
      await expect(
        loadConfig({
          startDir: grandchildDir,
          globalConfigPath: null,
        }),
      ).rejects.toThrow("blocked child config");
    } finally {
      statSpy.mockRestore();
    }
  });
});

test("loadConfig: throws when no config file found", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-empty-"));
  try {
    await expect(
      loadConfig({ startDir: tmpDir, globalConfigPath: null }),
    ).rejects.toThrow("not found");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig: throws for empty profiles", async () => {
  const yaml = `
profiles: {}
`;
  await withTempConfig(yaml, async (dir) => {
    await expect(
      loadConfig({ startDir: dir, globalConfigPath: null }),
    ).rejects.toThrow("at least one entry");
  });
});

test("loadConfig: throws for invalid agent type in YAML", async () => {
  const yaml = `
profiles:
  test:
    agent: invalid_agent
`;
  await withTempConfig(yaml, async (dir) => {
    await expect(
      loadConfig({ startDir: dir, globalConfigPath: null }),
    ).rejects.toThrow("agent must be one of");
  });
});

test("loadConfig: throws for YAML with no agent field", async () => {
  const yaml = `
profiles:
  test:
    nix:
      enable: true
`;
  await withTempConfig(yaml, async (dir) => {
    await expect(
      loadConfig({ startDir: dir, globalConfigPath: null }),
    ).rejects.toThrow("agent must be one of");
  });
});

test("loadConfig: handles nix enable=false from YAML", async () => {
  const yaml = `
profiles:
  test:
    agent: claude
    nix:
      enable: false
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    expect(config.profiles.test.nix.enable).toEqual(false);
  });
});

test("loadConfig: handles nix enable=auto from YAML", async () => {
  const yaml = `
profiles:
  test:
    agent: claude
    nix:
      enable: auto
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    expect(config.profiles.test.nix.enable).toEqual("auto");
  });
});

test("loadConfig: env with command entries from YAML", async () => {
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
    expect(config.profiles.test.env.length).toEqual(2);
    expect(config.profiles.test.env[0]).toEqual({
      key: "STATIC",
      val: "hello",
      mode: "set",
    });
    expect(config.profiles.test.env[1]).toEqual({
      keyCmd: "printf DYNAMIC",
      valCmd: "printf world",
      mode: "set",
    });
  });
});

test("loadConfig: worktree with defaults from YAML", async () => {
  const yaml = `
profiles:
  test:
    agent: claude
    worktree: {}
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    expect(config.profiles.test.worktree?.base).toEqual("origin/main");
    expect(config.profiles.test.worktree?.onCreate).toEqual("");
  });
});

test("loadConfig: extra-mounts mode defaults to ro from YAML", async () => {
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
    expect(config.profiles.test.extraMounts[0].mode).toEqual("ro");
  });
});

// --- resolveProfile ---

test("resolveProfile: resolves by explicit name", () => {
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
        hook: DEFAULT_HOOK_CONFIG,
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
        hook: DEFAULT_HOOK_CONFIG,
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
  };

  const { name, profile } = resolveProfile(config, "other-profile");
  expect(name).toEqual("other-profile");
  expect(profile.agent).toEqual("copilot");
  expect(profile.agentArgs).toEqual(["--yolo"]);
});

test("resolveProfile: falls back to default profile", () => {
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
        hook: DEFAULT_HOOK_CONFIG,
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
  };

  const { name, profile } = resolveProfile(config);
  expect(name).toEqual("my-default");
  expect(profile.agent).toEqual("claude");
});

test("resolveProfile: auto-selects when only one profile and no default", () => {
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
        hook: DEFAULT_HOOK_CONFIG,
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
  };

  const { name, profile } = resolveProfile(config);
  expect(name).toEqual("only-one");
  expect(profile.agent).toEqual("copilot");
});

test("resolveProfile: throws when multiple profiles and no default", () => {
  const config: Config = {
    profiles: {
      a: {
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
        hook: DEFAULT_HOOK_CONFIG,
        extraMounts: [],
        env: [],
      },
      b: {
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
        hook: DEFAULT_HOOK_CONFIG,
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
  };

  expect(() => resolveProfile(config)).toThrow(
    "No profile specified and no default set",
  );
});

test("resolveProfile: throws for nonexistent profile name", () => {
  const config: Config = {
    profiles: {
      exists: {
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
        hook: DEFAULT_HOOK_CONFIG,
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
  };

  expect(() => resolveProfile(config, "nonexistent")).toThrow(
    'Profile "nonexistent" not found',
  );
});

// --- validateConfig: 追加のバリデーションテスト ---

test("validateConfig: multiple profiles each independently validated", () => {
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
  expect(config.profiles.a.agent).toEqual("claude");
  expect(config.profiles.b.agent).toEqual("copilot");
  expect(config.profiles.b.agentArgs).toEqual(["--flag"]);
  expect(config.profiles.c.nix.enable).toEqual(true);
  expect(config.profiles.c.docker.enable).toEqual(true);
});

test("validateConfig: extra-mounts with all modes", () => {
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
  expect(config.profiles.test.extraMounts[0].mode).toEqual("ro");
  expect(config.profiles.test.extraMounts[1].mode).toEqual("rw");
  expect(config.profiles.test.extraMounts[2].mode).toEqual("ro");
});

test("validateConfig: empty env list is valid", () => {
  const raw: RawConfig = {
    profiles: {
      test: {
        agent: "claude",
        env: [],
      },
    },
  };
  const config = validateConfig(raw);
  expect(config.profiles.test.env).toEqual([]);
});

test("validateConfig: nix.extra-packages preserved", () => {
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
  expect(config.profiles.test.nix.extraPackages).toEqual([
    "nixpkgs#gh",
    "nixpkgs#jq",
    "nixpkgs#ripgrep",
  ]);
});

// --- loadConfig + resolveProfile 統合テスト (ファイル → プロファイル解決) ---

test("loadConfig + resolveProfile: load YAML and resolve default profile", async () => {
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
    expect(name).toEqual("production");
    expect(profile.agent).toEqual("claude");
    expect(profile.agentArgs).toEqual(["--dangerously-skip-permissions"]);
  });
});

test("loadConfig + resolveProfile: load YAML and resolve explicit profile", async () => {
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
    expect(name).toEqual("staging");
    expect(profile.agent).toEqual("copilot");
    expect(profile.agentArgs).toEqual(["--yolo"]);
  });
});

test("loadConfig + resolveProfile: load YAML with single profile auto-resolves", async () => {
  const yaml = `
profiles:
  only:
    agent: claude
`;
  await withTempConfig(yaml, async (dir) => {
    const config = await loadConfig({ startDir: dir, globalConfigPath: null });
    const { name, profile } = resolveProfile(config);
    expect(name).toEqual("only");
    expect(profile.agent).toEqual("claude");
  });
});

test("loadConfig + resolveProfile: load YAML from nested directory and resolve", async () => {
  await withNestedDirs(async (rootDir, _childDir, grandchildDir) => {
    await writeFile(
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
    expect(name).toEqual("nested-test");
    expect(profile.agent).toEqual("copilot");
    expect(profile.nix.enable).toEqual(false);
  });
});

test("loadConfig + resolveProfile: complex YAML with worktree, env, extra-mounts all together", async () => {
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
    expect(profile.agent).toEqual("claude");
    expect(profile.agentArgs).toEqual(["--dangerously-skip-permissions"]);
    expect(profile.worktree?.base).toEqual("origin/main");
    expect(profile.worktree?.onCreate).toEqual("npm install && npm run build");
    expect(profile.nix.enable).toEqual(true);
    expect(profile.nix.extraPackages).toEqual(["nixpkgs#ripgrep"]);
    expect(profile.docker.enable).toEqual(true);
    expect(profile.gcloud.mountConfig).toEqual(true);
    expect(profile.aws.mountConfig).toEqual(true);
    expect(profile.gpg.forwardAgent).toEqual(true);
    expect(profile.extraMounts.length).toEqual(1);
    expect(profile.env.length).toEqual(2);
  });
});

// --- .agent-sandbox.nix support ---

/** 一時ディレクトリに .nix 設定ファイルを配置してテストを実行するヘルパー */
async function withTempNixConfig(
  nixExpr: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-nix-test-"));
  try {
    await writeFile(path.join(tmpDir, ".agent-sandbox.nix"), nixExpr);
    await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test("loadConfig: loads .agent-sandbox.nix when no .yml exists", async () => {
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
    expect(config.profiles.dev.agent).toEqual("claude");
    expect(config.profiles.dev.nix.enable).toEqual("auto");
  });
});

test("loadConfig: .yml takes priority over .nix", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-priority-"));
  try {
    await writeFile(
      path.join(tmpDir, ".agent-sandbox.yml"),
      `
profiles:
  from-yml:
    agent: claude
`,
    );
    await writeFile(
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
    expect("from-yml" in config.profiles).toEqual(true);
    expect("from-nix" in config.profiles).toEqual(false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig: .nix with full profile fields", async () => {
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
    expect(config.default).toEqual("full");
    expect(p.agent).toEqual("copilot");
    expect(p.agentArgs).toEqual(["--yolo", "--verbose"]);
    expect(p.nix.enable).toEqual(true);
    expect(p.nix.mountSocket).toEqual(true);
    expect(p.nix.extraPackages).toEqual(["nixpkgs#ripgrep"]);
    expect(p.docker.enable).toEqual(true);
    expect(p.extraMounts.length).toEqual(1);
    expect(p.extraMounts[0].mode).toEqual("rw");
    expect(p.env[0]).toEqual({ key: "MY_VAR", val: "my_value", mode: "set" });
  });
});

test("loadConfig: searches upward for .nix config file", async () => {
  await withNestedDirs(async (rootDir, _childDir, grandchildDir) => {
    await writeFile(
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
    expect(config.profiles.test.agent).toEqual("claude");
  });
});

test("loadConfig: throws for invalid nix expression", async () => {
  const nixExpr = `{ invalid syntax !!!`;
  await withTempNixConfig(nixExpr, async (dir) => {
    await expect(
      loadConfig({ startDir: dir, globalConfigPath: null }),
    ).rejects.toThrow("Failed to evaluate");
  });
});

// --- XDG_CONFIG_HOME サポート ---

/** XDG_CONFIG_HOME を一時的に差し替えてテストを実行するヘルパー */
async function withXdgConfigHome(
  xdgDir: string,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgDir;
  try {
    await fn();
  } finally {
    if (prev !== undefined) {
      process.env.XDG_CONFIG_HOME = prev;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
  }
}

test("loadGlobalConfig: uses XDG_CONFIG_HOME when set", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-xdg-test-"));
  try {
    const nasDir = path.join(tmpDir, "nas");
    await mkdir(nasDir);
    await writeFile(
      path.join(nasDir, "agent-sandbox.yml"),
      `
profiles:
  xdg-profile:
    agent: claude
`,
    );
    await withXdgConfigHome(tmpDir, async () => {
      const result = await loadGlobalConfig();
      expect(result?.profiles?.["xdg-profile"]?.agent).toEqual("claude");
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadGlobalConfig: falls back to HOME/.config/nas without XDG_CONFIG_HOME", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-home-test-"));
  try {
    const nasDir = path.join(tmpDir, ".config", "nas");
    await mkdir(nasDir, { recursive: true });
    await writeFile(
      path.join(nasDir, "agent-sandbox.yml"),
      `
profiles:
  home-profile:
    agent: copilot
`,
    );
    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = tmpDir;
    if (prevXdg !== undefined) delete process.env.XDG_CONFIG_HOME;
    try {
      const result = await loadGlobalConfig();
      expect(result?.profiles?.["home-profile"]?.agent).toEqual("copilot");
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      if (prevXdg !== undefined) process.env.XDG_CONFIG_HOME = prevXdg;
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- 明示パスのエラー伝播 ---

test("loadGlobalConfig: throws for explicit path with malformed YAML", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-err-"));
  try {
    const cfgPath = path.join(tmpDir, "bad.yml");
    await writeFile(cfgPath, "{{{{ : invalid yaml : }}}}");
    await expect(loadGlobalConfig(cfgPath)).rejects.toThrow();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadGlobalConfig: throws for explicit path that does not exist", async () => {
  await expect(
    loadGlobalConfig("/nonexistent/nas/config.yml"),
  ).rejects.toThrow();
});

// --- 自動検出グローバル設定のエラー伝播 ---

test("loadGlobalConfig: throws for malformed YAML in discovered global config", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-xdg-err-"));
  try {
    const nasDir = path.join(tmpDir, "nas");
    await mkdir(nasDir);
    await writeFile(
      path.join(nasDir, "agent-sandbox.yml"),
      "{{{{ : invalid yaml : }}}}",
    );
    await withXdgConfigHome(tmpDir, async () => {
      await expect(loadGlobalConfig()).rejects.toThrow();
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadGlobalConfig: returns null when no global config file exists", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-xdg-empty-"));
  try {
    // nasDir 自体を作らない → stat で NotFound → fall through → null
    await withXdgConfigHome(tmpDir, async () => {
      const result = await loadGlobalConfig();
      expect(result).toEqual(null);
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
