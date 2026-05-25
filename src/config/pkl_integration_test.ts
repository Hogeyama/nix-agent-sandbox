import { expect, test } from "bun:test";

/**
 * Integration tests: Pkl ローカル設定の読み込みとグローバル設定の継承
 *
 * pkl コマンドが必要。環境にない場合はスキップされる。
 *
 * pkl CLI が未インストールの場合のエラーパス（"pkl command is not available"）は
 * src/config/load_integration_test.ts の "loadConfig: .pkl CLI not available" および
 * "loadGlobalConfig: .pkl CLI not available" テストでカバーされている。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadConfig } from "./load.ts";

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

/** 一時ディレクトリにグローバル(Pkl) + ローカル(Pkl) を配置してテスト */
async function withPklLocalConfig(
  globalPkl: string,
  localPkl: string,
  testBody: (localDir: string, globalPath: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-super-"));
  const localDir = path.join(tmpDir, "local");
  await mkdir(localDir, { recursive: true });
  try {
    const globalPath = path.join(tmpDir, "global.pkl");
    await writeFile(globalPath, globalPkl);
    await writeFile(path.join(localDir, ".agent-sandbox.pkl"), localPkl);
    await testBody(localDir, globalPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test.skipIf(!hasPkl)(
  "pkl: env entry accepts camelCase keyCmd/valCmd",
  async () => {
    const localPkl = `
profiles {
  ["dev"] {
    agent = "claude"
    env {
      new {
        keyCmd = "printf DYNAMIC_KEY"
        valCmd = "printf dynamic_value"
      }
    }
  }
}
`;
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-envcamel-"));
    try {
      await writeFile(path.join(tmpDir, ".agent-sandbox.pkl"), localPkl);
      const config = await loadConfig({
        startDir: tmpDir,
        globalConfigPath: null,
      });
      expect(config.profiles.dev.env).toEqual([
        {
          keyCmd: "printf DYNAMIC_KEY",
          valCmd: "printf dynamic_value",
          mode: "set",
        },
      ]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)("pkl: standalone .pkl file loads correctly", async () => {
  const localPkl = `
profiles {
  dev {
    agent = "claude"
  }
}
`;
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-standalone-"));
  try {
    await writeFile(path.join(tmpDir, ".agent-sandbox.pkl"), localPkl);
    const config = await loadConfig({
      startDir: tmpDir,
      globalConfigPath: null,
    });
    expect(config.profiles.dev.agent).toEqual("claude");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test.skipIf(!hasPkl)(
  "pkl: amends agent-sandbox.global.pkl inherits global config",
  async () => {
    const globalPkl = `
amends "modulepath:/Config.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    network {
      allowlist = new Listing { "api.github.com" }
    }
  }
}
`;
    // amends でグローバルを継承し、agent を上書き
    // profiles は Mapping<String, Profile> なのでエントリはブラケット構文必須。
    const localPkl = `
amends "modulepath:/agent-sandbox.global.pkl"

profiles {
  ["dev"] {
    agent = "copilot"
  }
}
`;
    await withPklLocalConfig(
      globalPkl,
      localPkl,
      async (localDir, globalPath) => {
        const config = await loadConfig({
          startDir: localDir,
          globalConfigPath: globalPath,
        });
        // agent はローカルで上書き
        expect(config.profiles.dev.agent).toEqual("copilot");
        // allowlist はグローバルから継承
        expect(config.profiles.dev.network.allowlist).toEqual([
          "api.github.com",
        ]);
      },
    );
  },
);

test.skipIf(!hasPkl)("pkl: works without global config", async () => {
  const localPkl = `
profiles {
  dev {
    agent = "claude"
  }
}
`;
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-noglobal-"));
  try {
    await writeFile(path.join(tmpDir, ".agent-sandbox.pkl"), localPkl);
    const config = await loadConfig({
      startDir: tmpDir,
      globalConfigPath: null,
    });
    expect(config.profiles.dev.agent).toEqual("claude");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test.skipIf(!hasPkl)(
  "pkl: handles config and temp paths with spaces",
  async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-space-"));
    try {
      const baseDir = path.join(rootDir, "dir with spaces");
      const localDir = path.join(baseDir, "local config");
      const tmpDirWithSpaces = path.join(baseDir, "tmp dir");
      await mkdir(localDir, { recursive: true });
      await mkdir(tmpDirWithSpaces, { recursive: true });

      const globalPath = path.join(baseDir, "global config.pkl");
      await writeFile(
        globalPath,
        `
amends "modulepath:/Config.pkl"

profiles {
  ["dev"] {
    agent = "claude"
  }
}
`,
      );
      await writeFile(
        path.join(localDir, ".agent-sandbox.pkl"),
        `
amends "modulepath:/agent-sandbox.global.pkl"

profiles {
  ["dev"] {
    agentArgs = new Listing {
      "--from-space-path"
    }
  }
}
`,
      );

      const previousTmpDir = process.env.TMPDIR;
      process.env.TMPDIR = tmpDirWithSpaces;
      try {
        const config = await loadConfig({
          startDir: localDir,
          globalConfigPath: globalPath,
        });
        expect(config.profiles.dev.agent).toEqual("claude");
        expect(config.profiles.dev.agentArgs).toEqual(["--from-space-path"]);
      } finally {
        if (previousTmpDir !== undefined) {
          process.env.TMPDIR = previousTmpDir;
        } else {
          delete process.env.TMPDIR;
        }
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)("pkl: invalid pkl expression produces error", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-invalid-"));
  try {
    await writeFile(
      path.join(tmpDir, ".agent-sandbox.pkl"),
      `
profiles {
  dev {
    agent =
  }
}
`,
    );
    await expect(
      loadConfig({
        startDir: tmpDir,
        globalConfigPath: null,
      }),
    ).rejects.toThrow(/Failed to evaluate.*pkl eval exited with code/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test.skipIf(!hasPkl)(
  "pkl: global-only .pkl via XDG_CONFIG_HOME resolves Config.pkl",
  async () => {
    // Project ディレクトリには設定なし、グローバルだけ .pkl で書く。
    // Config.pkl が tmp dir 経由で解決できるおかげで amends が成立する。
    const rootDir = await mkdtemp(path.join(tmpdir(), "pkl-global-only-"));
    try {
      const xdgConfigHome = path.join(rootDir, "config");
      const nasConfigDir = path.join(xdgConfigHome, "nas");
      const projectDir = path.join(rootDir, "project");
      await mkdir(nasConfigDir, { recursive: true });
      await mkdir(projectDir, { recursive: true });

      await writeFile(
        path.join(nasConfigDir, "agent-sandbox.pkl"),
        `
amends "modulepath:/Config.pkl"

profiles {
  ["dev"] {
    agent = "claude"
  }
}
`,
      );

      const previousXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = xdgConfigHome;
      try {
        const config = await loadConfig({ startDir: projectDir });
        expect(config.profiles.dev.agent).toEqual("claude");
      } finally {
        if (previousXdg !== undefined) {
          process.env.XDG_CONFIG_HOME = previousXdg;
        } else {
          delete process.env.XDG_CONFIG_HOME;
        }
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "pkl: explicit globalConfigPath .pkl loads via Config.pkl",
  async () => {
    // globalConfigPath で明示的に .pkl ファイルを指定するパス。
    // project には .pkl を置かないので、global の .pkl 単独で loadConfig が成立する。
    const rootDir = await mkdtemp(path.join(tmpdir(), "pkl-explicit-global-"));
    try {
      const projectDir = path.join(rootDir, "project");
      await mkdir(projectDir, { recursive: true });

      const globalPklPath = path.join(rootDir, "my-global.pkl");
      await writeFile(
        globalPklPath,
        `
amends "modulepath:/Config.pkl"

default = "dev"

profiles {
  ["dev"] {
    agent = "claude"
  }
}
`,
      );

      const config = await loadConfig({
        startDir: projectDir,
        globalConfigPath: globalPklPath,
      });
      expect(config.default).toEqual("dev");
      expect(config.profiles.dev.agent).toEqual("claude");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "pkl: amends agent-sandbox.global.pkl works even when global config is absent",
  async () => {
    // globalConfigPath: null でも tmp dir には空の agent-sandbox.global.pkl
    // (中身は Config.pkl への amends ヘッダのみ) が書き出されるので、
    // ユーザの amends "modulepath:/agent-sandbox.global.pkl" は解決できる。
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pkl-empty-global-"));
    try {
      await writeFile(
        path.join(tmpDir, ".agent-sandbox.pkl"),
        `
amends "modulepath:/agent-sandbox.global.pkl"

profiles {
  ["dev"] {
    agent = "claude"
  }
}
`,
      );

      const config = await loadConfig({
        startDir: tmpDir,
        globalConfigPath: null,
      });
      expect(config.profiles.dev.agent).toEqual("claude");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "pkl: invalid enum value rejected by Config.pkl schema",
  async () => {
    // display.sandbox は "none"|"xpra" のみ許容。それ以外を書くと pkl eval が失敗する。
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pkl-enum-violation-"));
    try {
      await writeFile(
        path.join(tmpDir, ".agent-sandbox.pkl"),
        `
amends "modulepath:/agent-sandbox.global.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    display {
      sandbox = "wrong-enum"
    }
  }
}
`,
      );
      await expect(
        loadConfig({
          startDir: tmpDir,
          globalConfigPath: null,
        }),
      ).rejects.toThrow(/pkl eval exited with code/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);
