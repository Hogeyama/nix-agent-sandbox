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

/** 一時ディレクトリにグローバル(YAML) + ローカル(Pkl) を配置してテスト */
async function withPklLocalConfig(
  globalYaml: string,
  localPkl: string,
  testBody: (localDir: string, globalPath: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-super-"));
  const localDir = path.join(tmpDir, "local");
  await mkdir(localDir, { recursive: true });
  try {
    const globalPath = path.join(tmpDir, "global.yml");
    await writeFile(globalPath, globalYaml);
    await writeFile(path.join(localDir, ".agent-sandbox.pkl"), localPkl);
    await testBody(localDir, globalPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

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
    const globalYaml = `
profiles:
  dev:
    agent: claude
    network:
      allowlist:
        - "api.github.com"
`;
    // amends でグローバルを継承し、agent を上書き
    const localPkl = `
amends "modulepath:/agent-sandbox.global.pkl"

profiles {
  dev {
    agent = "copilot"
  }
}
`;
    await withPklLocalConfig(
      globalYaml,
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

      const globalPath = path.join(baseDir, "global config.yml");
      await writeFile(
        globalPath,
        `
profiles:
  dev:
    agent: claude
`,
      );
      await writeFile(
        path.join(localDir, ".agent-sandbox.pkl"),
        `
amends "modulepath:/agent-sandbox.global.pkl"

profiles {
  dev {
    ["agent-args"] = new Listing {
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
