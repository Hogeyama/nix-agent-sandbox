import { expect, test } from "bun:test";

/**
 * Integration tests: Pkl 設定の --project-dir 評価テスト
 *
 * pkl コマンドが必要。環境にない場合はスキップされる。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveAsset } from "../lib/asset.ts";
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
 * .nas/ 構造をセットアップするヘルパー。
 *
 * @param parentDir - .nas/ を作成する親ディレクトリ
 * @param configPkl - config.pkl の内容
 * @param opts.globalDir - PklProject の modulePath に追加するグローバルディレクトリ
 */
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

test.skipIf(!hasPkl)(
  "pkl: env entry accepts camelCase keyCmd/valCmd",
  async () => {
    const configPkl = `amends "Schema.pkl"

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
      await setupNasDir(tmpDir, configPkl);
      const config = await loadConfig({ startDir: tmpDir });
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
  const configPkl = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
  }
}
`;
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-standalone-"));
  try {
    await setupNasDir(tmpDir, configPkl);
    const config = await loadConfig({ startDir: tmpDir });
    expect(config.profiles.dev.agent).toEqual("claude");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test.skipIf(!hasPkl)(
  "pkl: amends global.pkl via modulePath inherits global config",
  async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-global-"));
    try {
      // Set up global config dir with Schema.pkl and global.pkl
      const globalDir = path.join(rootDir, "global-config");
      await mkdir(globalDir, { recursive: true });
      const schemaText = await readBundledSchema();
      await writeFile(path.join(globalDir, "Schema.pkl"), schemaText);
      await writeFile(
        path.join(globalDir, "global.pkl"),
        `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    network {
      allowlist = new Listing { "api.github.com" }
    }
  }
}
`,
      );

      const configPkl = `amends "modulepath:/global.pkl"

profiles {
  ["dev"] {
    agent = "copilot"
  }
}
`;
      const projectDir = path.join(rootDir, "project");
      await mkdir(projectDir, { recursive: true });
      await setupNasDir(projectDir, configPkl, { globalDir });

      const config = await loadConfig({ startDir: projectDir });
      // agent はローカルで上書き
      expect(config.profiles.dev.agent).toEqual("copilot");
      // allowlist はグローバルから継承
      expect(config.profiles.dev.network.allowlist).toEqual(["api.github.com"]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)("pkl: works without global config", async () => {
  const configPkl = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
  }
}
`;
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-noglobal-"));
  try {
    await setupNasDir(tmpDir, configPkl);
    const config = await loadConfig({ startDir: tmpDir });
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
      await mkdir(localDir, { recursive: true });

      await setupNasDir(
        localDir,
        `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    agentArgs = new Listing {
      "--from-space-path"
    }
  }
}
`,
      );

      const config = await loadConfig({ startDir: localDir });
      expect(config.profiles.dev.agent).toEqual("claude");
      expect(config.profiles.dev.agentArgs).toEqual(["--from-space-path"]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)("pkl: invalid pkl expression produces error", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-invalid-"));
  try {
    await setupNasDir(
      tmpDir,
      `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent =
  }
}
`,
    );
    await expect(loadConfig({ startDir: tmpDir })).rejects.toThrow(
      /Failed to evaluate.*pkl eval exited with code/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test.skipIf(!hasPkl)(
  "pkl: invalid enum value rejected by Schema.pkl",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "pkl-enum-violation-"));
    try {
      await setupNasDir(
        tmpDir,
        `amends "Schema.pkl"

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
      await expect(loadConfig({ startDir: tmpDir })).rejects.toThrow(
        /pkl eval exited with code/,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);
