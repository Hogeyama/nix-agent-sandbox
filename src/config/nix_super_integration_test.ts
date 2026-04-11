import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

/**
 * Integration tests: Nix ローカル設定が関数の場合に super でグローバル設定を受け取れる
 *
 * nix コマンドが必要。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadConfig } from "./load.ts";

/** 一時ディレクトリにグローバル(YAML) + ローカル(Nix) を配置してテスト */
async function withNixLocalConfig(
  globalYaml: string,
  localNix: string,
  fn: (localDir: string, globalPath: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-nix-super-"));
  const localDir = path.join(tmpDir, "local");
  await mkdir(localDir, { recursive: true });
  try {
    const globalPath = path.join(tmpDir, "global.yml");
    await writeFile(globalPath, globalYaml);
    await writeFile(path.join(localDir, ".agent-sandbox.nix"), localNix);
    await fn(localDir, globalPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test("nix super: function local config receives global as super", async () => {
  const globalYaml = `
profiles:
  dev:
    agent: claude
    network:
      allowlist:
        - "api.github.com"
`;
  // Nix 関数: super を受け取って allowlist に追加する
  const localNix = `
super: {
  profiles = super.profiles // {
    dev = super.profiles.dev // {
      network = super.profiles.dev.network // {
        allowlist = super.profiles.dev.network.allowlist ++ ["extra.example.com"];
      };
    };
  };
}
`;
  await withNixLocalConfig(
    globalYaml,
    localNix,
    async (localDir, globalPath) => {
      const config = await loadConfig({
        startDir: localDir,
        globalConfigPath: globalPath,
      });
      expect(config.profiles.dev.agent).toEqual("claude");
      expect(config.profiles.dev.network.allowlist).toEqual([
        "api.github.com",
        "extra.example.com",
      ]);
    },
  );
});

test("nix super: non-function local config uses normal merge", async () => {
  const globalYaml = `
profiles:
  dev:
    agent: claude
    network:
      allowlist:
        - "api.github.com"
`;
  // 通常の attrset（関数ではない）
  const localNix = `
{
  profiles = {
    dev = {
      network = {
        allowlist = ["only.local.com"];
      };
    };
  };
}
`;
  await withNixLocalConfig(
    globalYaml,
    localNix,
    async (localDir, globalPath) => {
      const config = await loadConfig({
        startDir: localDir,
        globalConfigPath: globalPath,
      });
      // 通常マージ: local の allowlist が global を置き換える
      expect(config.profiles.dev.agent).toEqual("claude"); // from global
      expect(config.profiles.dev.network.allowlist).toEqual(["only.local.com"]);
    },
  );
});

test("nix super: function can add new profiles while keeping global ones", async () => {
  const globalYaml = `
default: dev
profiles:
  dev:
    agent: claude
`;
  const localNix = `
super: {
  default = super.default;
  profiles = super.profiles // {
    local-only = {
      agent = "copilot";
    };
  };
}
`;
  await withNixLocalConfig(
    globalYaml,
    localNix,
    async (localDir, globalPath) => {
      const config = await loadConfig({
        startDir: localDir,
        globalConfigPath: globalPath,
      });
      expect(config.default).toEqual("dev");
      expect(config.profiles.dev.agent).toEqual("claude");
      expect(config.profiles["local-only"].agent).toEqual("copilot");
    },
  );
});

test("nix super: function with no global config gets empty attrset", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-nix-super-noglobal-"));
  try {
    // グローバル設定なし、ローカルのみ関数
    const localNix = `
super: {
  profiles = (super.profiles or {}) // {
    dev = {
      agent = "claude";
    };
  };
}
`;
    await writeFile(path.join(tmpDir, ".agent-sandbox.nix"), localNix);
    const config = await loadConfig({
      startDir: tmpDir,
      globalConfigPath: null,
    });
    expect(config.profiles.dev.agent).toEqual("claude");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("nix super: handles config and temp paths with spaces", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "nas-nix-super-space-"));
  try {
    const baseDir = path.join(rootDir, "dir with spaces");
    const localDir = path.join(baseDir, "local config");
    const tmpDir = path.join(baseDir, "tmp dir");
    await mkdir(localDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });

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
      path.join(localDir, ".agent-sandbox.nix"),
      `
super: {
  profiles = super.profiles // {
    dev = super.profiles.dev // {
      agent-args = ["--from-space-path"];
    };
  };
}
`,
    );

    const previousTmpDir = process.env["TMPDIR"];
    process.env["TMPDIR"] = tmpDir;
    try {
      const config = await loadConfig({
        startDir: localDir,
        globalConfigPath: globalPath,
      });
      expect(config.profiles.dev.agent).toEqual("claude");
      expect(config.profiles.dev.agentArgs).toEqual(["--from-space-path"]);
    } finally {
      if (previousTmpDir !== undefined) {
        process.env["TMPDIR"] = previousTmpDir;
      } else {
        delete process.env["TMPDIR"];
      }
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
