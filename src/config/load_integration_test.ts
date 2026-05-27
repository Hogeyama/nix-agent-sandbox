import { expect, spyOn, test } from "bun:test";

/**
 * 設定ファイルの読み込み・検索の統合テスト
 *
 * .nas/config.pkl + PklProject + Schema.pkl をセットアップし
 * loadConfig / resolveProfile を検証する。
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveAsset } from "../lib/asset.ts";
import { loadConfig, resolveProfile } from "./load.ts";
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

/** バンドルされた Schema.pkl のテキストを読み込む */
async function readBundledSchema(): Promise<string> {
  const schemaSrc = resolveAsset(
    "config/Schema.pkl",
    import.meta.url,
    "./Schema.pkl",
  );
  return readFile(schemaSrc, "utf8");
}

/**
 * 一時ディレクトリに .nas/ 構造をセットアップしてテストを実行するヘルパー。
 *
 * @param configPkl - .nas/config.pkl に書き込む内容
 * @param fn - テスト本体（dir は .nas/ の親ディレクトリ）
 * @param opts.pklProjectOverride - PklProject の内容を上書きする場合に指定
 * @param opts.globalDir - グローバル設定ディレクトリのパス（PklProject の modulePath に含まれる）
 */
async function withNasConfig(
  configPkl: string,
  fn: (dir: string, nasDir: string) => Promise<void>,
  opts?: { pklProjectOverride?: string; globalDir?: string },
): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-test-"));
  const nasDir = path.join(tmpDir, ".nas");
  await mkdir(nasDir, { recursive: true });

  // Schema.pkl
  const schemaText = await readBundledSchema();
  await writeFile(path.join(nasDir, "Schema.pkl"), schemaText);

  // PklProject
  if (opts?.pklProjectOverride) {
    await writeFile(path.join(nasDir, "PklProject"), opts.pklProjectOverride);
  } else if (opts?.globalDir) {
    // PklProject that includes both local and global in modulePath
    const pklProject = `amends "pkl:Project"

evaluatorSettings {
  modulePath {
    "."
    "${opts.globalDir}"
  }
}
`;
    await writeFile(path.join(nasDir, "PklProject"), pklProject);
  } else {
    // PklProject with only local modulePath
    const pklProject = `amends "pkl:Project"

evaluatorSettings {
  modulePath {
    "."
  }
}
`;
    await writeFile(path.join(nasDir, "PklProject"), pklProject);
  }

  // config.pkl
  await writeFile(path.join(nasDir, "config.pkl"), configPkl);

  try {
    await fn(tmpDir, nasDir);
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

/** .nas/ 構造を指定ディレクトリにセットアップする */
async function setupNasDir(
  parentDir: string,
  configPkl: string,
  opts?: { globalDir?: string },
): Promise<string> {
  const nasDir = path.join(parentDir, ".nas");
  await mkdir(nasDir, { recursive: true });

  const schemaText = await readBundledSchema();
  await writeFile(path.join(nasDir, "Schema.pkl"), schemaText);

  if (opts?.globalDir) {
    const pklProject = `amends "pkl:Project"

evaluatorSettings {
  modulePath {
    "."
    "${opts.globalDir}"
  }
}
`;
    await writeFile(path.join(nasDir, "PklProject"), pklProject);
  } else {
    const pklProject = `amends "pkl:Project"

evaluatorSettings {
  modulePath {
    "."
  }
}
`;
    await writeFile(path.join(nasDir, "PklProject"), pklProject);
  }

  await writeFile(path.join(nasDir, "config.pkl"), configPkl);
  return nasDir;
}

// --- loadConfig: ファイルシステムからの読み込み ---

test.skipIf(!hasPkl)(
  "loadConfig: loads minimal .nas/config.pkl from directory",
  async () => {
    const configPkl = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
  }
}
`;
    await withNasConfig(configPkl, async (dir) => {
      const config = await loadConfig({ startDir: dir });
      expect(config.profiles.dev.agent).toEqual("claude");
      expect(config.profiles.dev.nix.enable).toEqual("auto");
      expect(config.profiles.dev.docker.enable).toEqual(false);
      expect(config.profiles.dev.env).toEqual([]);
      expect(config.profiles.dev.extraMounts).toEqual([]);
    });
  },
);

test.skipIf(!hasPkl)(
  "loadConfig: searches upward for .nas/config.pkl",
  async () => {
    await withNestedDirs(async (rootDir, _childDir, grandchildDir) => {
      await setupNasDir(
        rootDir,
        `amends "Schema.pkl"

profiles {
  ["test"] {
    agent = "claude"
  }
}
`,
      );
      const config = await loadConfig({ startDir: grandchildDir });
      expect(config.profiles.test.agent).toEqual("claude");
    });
  },
);

test.skipIf(!hasPkl)(
  "loadConfig: nearest .nas/config.pkl wins over parent",
  async () => {
    await withNestedDirs(async (rootDir, childDir, grandchildDir) => {
      await setupNasDir(
        rootDir,
        `amends "Schema.pkl"

profiles {
  ["parent-profile"] {
    agent = "copilot"
  }
}
`,
      );
      await setupNasDir(
        childDir,
        `amends "Schema.pkl"

profiles {
  ["child-profile"] {
    agent = "claude"
  }
}
`,
      );
      const config = await loadConfig({ startDir: grandchildDir });
      expect("child-profile" in config.profiles).toEqual(true);
      expect("parent-profile" in config.profiles).toEqual(false);
    });
  },
);

import * as nodeFs from "node:fs/promises";

test("loadConfig: propagates config discovery stat errors", async () => {
  await withNestedDirs(async (rootDir, childDir, grandchildDir) => {
    await setupNasDir(
      rootDir,
      `amends "Schema.pkl"

profiles {
  ["parent-profile"] {
    agent = "claude"
  }
}
`,
    );

    const blockedPath = path.join(childDir, ".nas", "config.pkl");
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
      await expect(loadConfig({ startDir: grandchildDir })).rejects.toThrow(
        "blocked child config",
      );
    } finally {
      statSpy.mockRestore();
    }
  });
});

test.skipIf(!hasPkl)(
  "loadConfig: auto-inits when no config file found",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-empty-"));
    // XDG_CONFIG_HOME を一時ディレクトリに向けてグローバル設定の隔離
    const xdgDir = path.join(tmpDir, "xdg-config");
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgDir;
    try {
      const config = await loadConfig({ startDir: tmpDir });

      // .nas/ ディレクトリが自動生成されていること
      const nasDir = path.join(tmpDir, ".nas");
      const nasStat = await stat(nasDir);
      expect(nasStat.isDirectory()).toBe(true);

      // デフォルトプロファイルが返されること（テンプレートに "default" プロファイルがある）
      expect("default" in config.profiles).toBe(true);
      expect(config.profiles.default.agent).toBe("claude");

      // グローバル設定も XDG_CONFIG_HOME 配下に生成されていること
      const globalNasDir = path.join(xdgDir, "nas");
      const globalStat = await stat(globalNasDir);
      expect(globalStat.isDirectory()).toBe(true);
    } finally {
      if (origXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = origXdg;
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test("loadConfig: NAS_NO_AUTO_INIT=1 skips auto-init and throws", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-noinit-"));
  const origVal = process.env.NAS_NO_AUTO_INIT;
  process.env.NAS_NO_AUTO_INIT = "1";
  try {
    await expect(loadConfig({ startDir: tmpDir })).rejects.toThrow(
      "Run `nas config init` to create it",
    );
    // .nas/ ディレクトリが作成されていないこと
    await expect(stat(path.join(tmpDir, ".nas"))).rejects.toThrow();
  } finally {
    if (origVal === undefined) {
      delete process.env.NAS_NO_AUTO_INIT;
    } else {
      process.env.NAS_NO_AUTO_INIT = origVal;
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test.skipIf(!hasPkl)(
  "loadConfig: auto-init prints stderr message with directory path",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-stderr-"));
    const xdgDir = path.join(tmpDir, "xdg-config");
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgDir;
    // NAS_NO_AUTO_INIT が未設定であることを保証
    const origNoInit = process.env.NAS_NO_AUTO_INIT;
    delete process.env.NAS_NO_AUTO_INIT;

    const stderrSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await loadConfig({ startDir: tmpDir });

      // stderr にディレクトリパスを含むメッセージが出力されること
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const msg = stderrSpy.mock.calls[0][0] as string;
      expect(msg).toContain("Auto-initializing .nas/");
      expect(msg).toContain(tmpDir);
      expect(msg).toContain("nas config init");
    } finally {
      stderrSpy.mockRestore();
      if (origXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = origXdg;
      }
      if (origNoInit === undefined) {
        delete process.env.NAS_NO_AUTO_INIT;
      } else {
        process.env.NAS_NO_AUTO_INIT = origNoInit;
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)("loadConfig: throws for empty profiles", async () => {
  const configPkl = `amends "Schema.pkl"

profiles {}
`;
  await withNasConfig(configPkl, async (dir) => {
    await expect(loadConfig({ startDir: dir })).rejects.toThrow(
      "at least one entry",
    );
  });
});

test("loadConfig: pkl CLI not available shows helpful error", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-pkl-nocli-"));
  const nasDir = path.join(tmpDir, ".nas");
  await mkdir(nasDir, { recursive: true });
  const schemaText = await readBundledSchema();
  await writeFile(path.join(nasDir, "Schema.pkl"), schemaText);
  await writeFile(
    path.join(nasDir, "PklProject"),
    `amends "pkl:Project"\nevaluatorSettings { modulePath { "." } }\n`,
  );
  await writeFile(
    path.join(nasDir, "config.pkl"),
    `amends "Schema.pkl"\nprofiles { ["dev"] { agent = "claude" } }\n`,
  );

  const origPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await expect(loadConfig({ startDir: tmpDir })).rejects.toThrow(
      "but 'pkl' command is not available on PATH",
    );
  } finally {
    process.env.PATH = origPath;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- グローバル設定の modulePath 経由解決 ---

test.skipIf(!hasPkl)(
  "loadConfig: config amending global.pkl via modulePath resolves correctly",
  async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-global-"));
    const origXdg = process.env.XDG_CONFIG_HOME;
    try {
      // Set up a global dir with Schema.pkl and global.pkl
      // evalPklConfig reads from getGlobalConfigDir() = $XDG_CONFIG_HOME/nas
      const xdgConfig = path.join(rootDir, "xdg-config");
      const globalDir = path.join(xdgConfig, "nas");
      process.env.XDG_CONFIG_HOME = xdgConfig;
      await mkdir(globalDir, { recursive: true });
      const schemaText = await readBundledSchema();
      await writeFile(path.join(globalDir, "Schema.pkl"), schemaText);
      await writeFile(
        path.join(globalDir, "global.pkl"),
        `amends "Schema.pkl"

profiles {
  ["from-global"] {
    agent = "copilot"
    network {
      allowlist = new Listing { "api.github.com" }
    }
  }
}
`,
      );

      // Local config amends global.pkl via modulepath
      const configPkl = `amends "modulepath:/global.pkl"

profiles {
  ["from-local"] {
    agent = "claude"
  }
}
`;
      await withNasConfig(configPkl, async (dir) => {
        const config = await loadConfig({ startDir: dir });
        expect("from-global" in config.profiles).toEqual(true);
        expect(config.profiles["from-global"].agent).toEqual("copilot");
        expect(config.profiles["from-global"].network.allowlist).toEqual([
          "api.github.com",
        ]);
        expect("from-local" in config.profiles).toEqual(true);
        expect(config.profiles["from-local"].agent).toEqual("claude");
      });
    } finally {
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "loadConfig: throws when global.pkl does not amend Schema.pkl (broken amends chain)",
  async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-broken-chain-"));
    const origXdg = process.env.XDG_CONFIG_HOME;
    try {
      // evalPklConfig reads from getGlobalConfigDir() = $XDG_CONFIG_HOME/nas
      const xdgConfig = path.join(rootDir, "xdg-config");
      const globalDir = path.join(xdgConfig, "nas");
      process.env.XDG_CONFIG_HOME = xdgConfig;
      await mkdir(globalDir, { recursive: true });
      const schemaText = await readBundledSchema();
      await writeFile(path.join(globalDir, "Schema.pkl"), schemaText);
      // global.pkl is plain text without amends — breaks the chain
      await writeFile(
        path.join(globalDir, "global.pkl"),
        `profiles {
  ["from-global"] {
    agent = "copilot"
  }
}
`,
      );

      // Local config amends global.pkl via modulepath
      const configPkl = `amends "modulepath:/global.pkl"

profiles {
  ["from-local"] {
    agent = "claude"
  }
}
`;
      await withNasConfig(configPkl, async (dir) => {
        await expect(loadConfig({ startDir: dir })).rejects.toThrow(
          /pkl eval exited with code/,
        );
      });
    } finally {
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
      await rm(rootDir, { recursive: true, force: true });
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

// --- エラーパス: PklProject 欠落・型不一致 ---

test.skipIf(!hasPkl)(
  "loadConfig: throws when PklProject is missing from .nas directory",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-cfg-no-pklproj-"));
    const nasDir = path.join(tmpDir, ".nas");
    await mkdir(nasDir, { recursive: true });

    // Schema.pkl と config.pkl は作成するが PklProject は省略
    const schemaText = await readBundledSchema();
    await writeFile(path.join(nasDir, "Schema.pkl"), schemaText);
    await writeFile(
      path.join(nasDir, "config.pkl"),
      `amends "Schema.pkl"\nprofiles { ["test"] { agent = "claude" } }\n`,
    );

    try {
      const err = expect(loadConfig({ startDir: tmpDir })).rejects;
      await err.toThrow("PklProject not found");
      await err.toThrow("nas config init");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "loadConfig: throws type error when config.pkl does not amend Schema.pkl",
  async () => {
    // config.pkl が amends を使わずフィールドを直接定義するケース。
    // eval.pkl の型注釈 `local validated: Schema = config` により
    // pkl の型エラーが発生する。
    const configPkl = `profiles {
  ["test"] {
    agent = "claude"
  }
}
`;
    await withNasConfig(configPkl, async (dir) => {
      await expect(loadConfig({ startDir: dir })).rejects.toThrow(
        /pkl eval exited with code/,
      );
    });
  },
);
