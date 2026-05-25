import { expect, spyOn, test } from "bun:test";

/**
 * 設定ファイルの読み込み・検索・マージの統合テスト
 *
 * 実際のファイルシステム上に Pkl ファイルを配置して loadConfig / resolveProfile を検証する。
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
  DEFAULT_OBSERVABILITY_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "./types.ts";
import { validateConfig } from "./validate.ts";

/** pkl コマンドが利用可能か確認する */
async function pklAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pkl", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0;
  } catch (e) {
    if (
      e instanceof Error &&
      "code" in e &&
      (e as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw e;
  }
}

const hasPkl = await pklAvailable();

/** 一時ディレクトリに .pkl 設定ファイルを配置してテストを実行するヘルパー */
async function withTempConfig(
  pkl: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-test-"));
  try {
    await writeFile(path.join(tmpDir, ".agent-sandbox.pkl"), pkl);
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

// --- loadConfig: ファイルシステムからの読み込み ---

test.skipIf(!hasPkl)(
  "loadConfig: loads minimal Pkl file from directory",
  async () => {
    const pkl = `
profiles {
  dev {
    agent = "claude"
  }
}
`;
    await withTempConfig(pkl, async (dir) => {
      const config = await loadConfig({
        startDir: dir,
        globalConfigPath: null,
      });
      expect(config.profiles.dev.agent).toEqual("claude");
      expect(config.profiles.dev.nix.enable).toEqual("auto");
      expect(config.profiles.dev.docker.enable).toEqual(false);
      expect(config.profiles.dev.env).toEqual([]);
      expect(config.profiles.dev.extraMounts).toEqual([]);
    });
  },
);

test.skipIf(!hasPkl)(
  "loadConfig: searches upward for .pkl config file",
  async () => {
    await withNestedDirs(async (rootDir, _childDir, grandchildDir) => {
      await writeFile(
        path.join(rootDir, ".agent-sandbox.pkl"),
        `
profiles {
  ["test"] {
    agent = "claude"
  }
}
`,
      );
      const config = await loadConfig({
        startDir: grandchildDir,
        globalConfigPath: null,
      });
      expect(config.profiles.test.agent).toEqual("claude");
    });
  },
);

test.skipIf(!hasPkl)(
  "loadConfig: nearest .pkl config file wins over parent",
  async () => {
    await withNestedDirs(async (rootDir, childDir, grandchildDir) => {
      await writeFile(
        path.join(rootDir, ".agent-sandbox.pkl"),
        `
profiles {
  ["parent-profile"] {
    agent = "copilot"
  }
}
`,
      );
      await writeFile(
        path.join(childDir, ".agent-sandbox.pkl"),
        `
profiles {
  ["child-profile"] {
    agent = "claude"
  }
}
`,
      );
      const config = await loadConfig({
        startDir: grandchildDir,
        globalConfigPath: null,
      });
      expect("child-profile" in config.profiles).toEqual(true);
      expect("parent-profile" in config.profiles).toEqual(false);
    });
  },
);

import * as nodeFs from "node:fs/promises";

test("loadConfig: propagates config discovery stat errors", async () => {
  await withNestedDirs(async (rootDir, childDir, grandchildDir) => {
    await writeFile(
      path.join(rootDir, ".agent-sandbox.pkl"),
      `
profiles {
  ["parent-profile"] {
    agent = "claude"
  }
}
`,
    );

    const blockedPath = path.join(childDir, ".agent-sandbox.pkl");
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

test.skipIf(!hasPkl)("loadConfig: throws for empty profiles", async () => {
  const pkl = `
profiles {}
`;
  await withTempConfig(pkl, async (dir) => {
    await expect(
      loadConfig({ startDir: dir, globalConfigPath: null }),
    ).rejects.toThrow("at least one entry");
  });
});

test("loadConfig: .pkl CLI not available shows helpful error", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-pkl-nocli-"));
  const origPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await writeFile(path.join(tmpDir, ".agent-sandbox.pkl"), `// pkl content`);
    await expect(
      loadConfig({ startDir: tmpDir, globalConfigPath: null }),
    ).rejects.toThrow("but 'pkl' command is not available on PATH");
  } finally {
    process.env.PATH = origPath;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- global-only (ローカルなし) → loadConfig がグローバル設定を返す ---

test.skipIf(!hasPkl)(
  "loadConfig: global-only path returns global config when no local .pkl exists",
  async () => {
    // ローカルに .pkl が無いディレクトリ
    const localDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-no-local-"));
    // グローバル設定ファイルを一時ディレクトリに配置
    const globalDir = await mkdtemp(
      path.join(tmpdir(), "nas-cfg-global-only-"),
    );
    const globalPklPath = path.join(globalDir, "agent-sandbox.pkl");
    await writeFile(
      globalPklPath,
      `
amends "modulepath:/Config.pkl"

profiles {
  ["global-profile"] {
    agent = "copilot"
  }
}
`,
    );
    try {
      const config = await loadConfig({
        startDir: localDir,
        globalConfigPath: globalPklPath,
      });
      expect("global-profile" in config.profiles).toEqual(true);
      expect(config.profiles["global-profile"].agent).toEqual("copilot");
    } finally {
      await rm(localDir, { recursive: true, force: true });
      await rm(globalDir, { recursive: true, force: true });
    }
  },
);

// --- global .pkl + local .pkl (amends) → マージされる ---

test.skipIf(!hasPkl)(
  "loadConfig: local .pkl amending global .pkl merges correctly",
  async () => {
    // グローバル設定ファイルを一時ディレクトリに配置
    const globalDir = await mkdtemp(
      path.join(tmpdir(), "nas-cfg-global-merge-"),
    );
    const globalPklPath = path.join(globalDir, "agent-sandbox.pkl");
    await writeFile(
      globalPklPath,
      `
amends "modulepath:/Config.pkl"

profiles {
  ["from-global"] {
    agent = "copilot"
  }
}
`,
    );

    // ローカル .pkl は global を amend して追加プロファイルを定義
    const localDir = await mkdtemp(
      path.join(tmpdir(), "nas-cfg-local-amends-"),
    );
    await writeFile(
      path.join(localDir, ".agent-sandbox.pkl"),
      `
amends "modulepath:/agent-sandbox.global.pkl"

profiles {
  ["from-local"] {
    agent = "claude"
  }
}
`,
    );

    try {
      const config = await loadConfig({
        startDir: localDir,
        globalConfigPath: globalPklPath,
      });
      // ローカルが global を amend しているので、global のプロファイルも引き継ぐ
      expect("from-global" in config.profiles).toEqual(true);
      expect(config.profiles["from-global"].agent).toEqual("copilot");
      // ローカルで追加したプロファイルも存在する
      expect("from-local" in config.profiles).toEqual(true);
      expect(config.profiles["from-local"].agent).toEqual("claude");
    } finally {
      await rm(localDir, { recursive: true, force: true });
      await rm(globalDir, { recursive: true, force: true });
    }
  },
);

// --- .yml/.nix files are ignored ---

test.skipIf(!hasPkl)(
  "loadConfig: .yml file is ignored (only .pkl is recognized)",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-yml-ignored-"));
    try {
      await writeFile(
        path.join(tmpDir, ".agent-sandbox.yml"),
        `
profiles:
  from-yml:
    agent: claude
`,
      );
      // No .pkl file → should not find config
      await expect(
        loadConfig({ startDir: tmpDir, globalConfigPath: null }),
      ).rejects.toThrow("not found");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "loadConfig: .nix file is ignored (only .pkl is recognized)",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-nix-ignored-"));
    try {
      await writeFile(
        path.join(tmpDir, ".agent-sandbox.nix"),
        `
{
  profiles = {
    from-nix = {
      agent = "claude";
    };
  };
}
`,
      );
      // No .pkl file → should not find config
      await expect(
        loadConfig({ startDir: tmpDir, globalConfigPath: null }),
      ).rejects.toThrow("not found");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "loadConfig: .pkl is loaded even when .yml and .nix coexist",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-pkl-wins-"));
    try {
      await writeFile(
        path.join(tmpDir, ".agent-sandbox.yml"),
        `
profiles:
  from-yml:
    agent: copilot
`,
      );
      await writeFile(
        path.join(tmpDir, ".agent-sandbox.nix"),
        `
{
  profiles = {
    from-nix = { agent = "copilot"; };
  };
}
`,
      );
      await writeFile(
        path.join(tmpDir, ".agent-sandbox.pkl"),
        `
profiles {
  ["from-pkl"] {
    agent = "claude"
  }
}
`,
      );
      const config = await loadConfig({
        startDir: tmpDir,
        globalConfigPath: null,
      });
      expect("from-pkl" in config.profiles).toEqual(true);
      expect("from-yml" in config.profiles).toEqual(false);
      expect("from-nix" in config.profiles).toEqual(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

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
        session: DEFAULT_SESSION_CONFIG,
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
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
        session: DEFAULT_SESSION_CONFIG,
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
        hook: DEFAULT_HOOK_CONFIG,
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
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
        session: DEFAULT_SESSION_CONFIG,
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
        hook: DEFAULT_HOOK_CONFIG,
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
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
        session: DEFAULT_SESSION_CONFIG,
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
        hook: DEFAULT_HOOK_CONFIG,
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
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
        session: DEFAULT_SESSION_CONFIG,
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
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
        session: DEFAULT_SESSION_CONFIG,
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
        hook: DEFAULT_HOOK_CONFIG,
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
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
        session: DEFAULT_SESSION_CONFIG,
        network: structuredClone(DEFAULT_NETWORK_CONFIG),
        dbus: structuredClone(DEFAULT_DBUS_CONFIG),
        display: structuredClone(DEFAULT_DISPLAY_CONFIG),
        hook: DEFAULT_HOOK_CONFIG,
        extraMounts: [],
        env: [],
      },
    },
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
  };

  expect(() => resolveProfile(config, "nonexistent")).toThrow(
    'Profile "nonexistent" not found',
  );
});

// --- validateConfig: 追加のバリデーションテスト ---

test("validateConfig: multiple profiles each independently validated", () => {
  const raw = {
    profiles: {
      a: { agent: "claude" },
      b: { agent: "copilot", agentArgs: ["--flag"] },
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
  const raw = {
    profiles: {
      test: {
        agent: "claude",
        extraMounts: [
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
  const raw = {
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
  const raw = {
    profiles: {
      test: {
        agent: "claude",
        nix: {
          extraPackages: ["nixpkgs#gh", "nixpkgs#jq", "nixpkgs#ripgrep"],
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

test.skipIf(!hasPkl)(
  "loadGlobalConfig: uses XDG_CONFIG_HOME when set",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-xdg-test-"));
    try {
      const nasDir = path.join(tmpDir, "nas");
      await mkdir(nasDir);
      await writeFile(
        path.join(nasDir, "agent-sandbox.pkl"),
        `
amends "modulepath:/Config.pkl"

profiles {
  ["xdg-profile"] {
    agent = "claude"
  }
}
`,
      );
      await withXdgConfigHome(tmpDir, async () => {
        const result = await loadGlobalConfig();
        expect(result).not.toBeNull();
        expect(result!.pklPath).toEqual(path.join(nasDir, "agent-sandbox.pkl"));
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "loadGlobalConfig: falls back to HOME/.config/nas without XDG_CONFIG_HOME",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-home-test-"));
    try {
      const nasDir = path.join(tmpDir, ".config", "nas");
      await mkdir(nasDir, { recursive: true });
      await writeFile(
        path.join(nasDir, "agent-sandbox.pkl"),
        `
amends "modulepath:/Config.pkl"

profiles {
  ["home-profile"] {
    agent = "copilot"
  }
}
`,
      );
      const prevHome = process.env.HOME;
      const prevXdg = process.env.XDG_CONFIG_HOME;
      process.env.HOME = tmpDir;
      if (prevXdg !== undefined) delete process.env.XDG_CONFIG_HOME;
      try {
        const result = await loadGlobalConfig();
        expect(result).not.toBeNull();
        expect(result!.pklPath).toEqual(path.join(nasDir, "agent-sandbox.pkl"));
      } finally {
        if (prevHome !== undefined) process.env.HOME = prevHome;
        if (prevXdg !== undefined) process.env.XDG_CONFIG_HOME = prevXdg;
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

// --- 明示パスのエラー伝播 ---

test("loadGlobalConfig: returns pklPath for explicit path (existence checked later)", async () => {
  const result = await loadGlobalConfig("/nonexistent/nas/config.pkl");
  expect(result).toEqual({ pklPath: "/nonexistent/nas/config.pkl" });
});

// --- 自動検出グローバル設定のエラー伝播 ---

test("loadGlobalConfig: returns pklPath even when pkl CLI not available", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-xdg-pkl-nocli-"));
  const origPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const nasDir = path.join(tmpDir, "nas");
    await mkdir(nasDir);
    await writeFile(path.join(nasDir, "agent-sandbox.pkl"), `// pkl content`);
    await withXdgConfigHome(tmpDir, async () => {
      // loadGlobalConfig now only returns a path; pkl CLI errors surface in loadConfig
      const result = await loadGlobalConfig();
      expect(result).not.toBeNull();
      expect(result!.pklPath).toEqual(path.join(nasDir, "agent-sandbox.pkl"));
    });
  } finally {
    process.env.PATH = origPath;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadGlobalConfig: returns null when no global config file exists", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-xdg-empty-"));
  try {
    // nasDir 自体を作らない → stat で NotFound → null
    await withXdgConfigHome(tmpDir, async () => {
      const result = await loadGlobalConfig();
      expect(result).toEqual(null);
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test.skipIf(!hasPkl)(
  "loadGlobalConfig: ignores .yml in global config dir",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-xdg-yml-ignored-"));
    try {
      const nasDir = path.join(tmpDir, "nas");
      await mkdir(nasDir);
      await writeFile(
        path.join(nasDir, "agent-sandbox.yml"),
        `
profiles:
  test:
    agent: claude
`,
      );
      await withXdgConfigHome(tmpDir, async () => {
        const result = await loadGlobalConfig();
        expect(result).toEqual(null);
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);
