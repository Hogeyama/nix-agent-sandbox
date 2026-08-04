import { afterAll, beforeAll, expect, test } from "bun:test";

/**
 * Integration tests: Pkl 設定の --project-dir 評価テスト
 *
 * pkl コマンドが必要。環境にない場合はスキップされる。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { generateAnthropicV1Fixture } from "../../scripts/gen_resolved_review_rules_fixture.ts";
import { resolveAsset } from "../lib/asset.ts";
import { resolveReviewRules } from "../network/review_rules.ts";
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

/**
 * `NAS_ASSET_DIR` をリポジトリの `src/config/Schema.pkl` を持つ一時ツリーに
 * 差し替える。
 *
 * `loadConfig` は評価前に `.nas/Schema.pkl` をアセットから上書きするので、
 * `NAS_ASSET_DIR` が**インストール済みの** nas を指していると (nas セッション
 * の中で nas を開発しているときは常にそう)、リポジトリの Schema.pkl が一切
 * 検証されないまま緑になる。ファイルスコープで固定して hermetic にする。
 */
let assetDir: string | undefined;
let previousAssetDir: string | undefined;

beforeAll(async () => {
  assetDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-assets-"));
  await mkdir(path.join(assetDir, "config"), { recursive: true });
  await writeFile(
    path.join(assetDir, "config", "Schema.pkl"),
    await readFile(new URL("./Schema.pkl", import.meta.url), "utf8"),
  );
  previousAssetDir = process.env.NAS_ASSET_DIR;
  process.env.NAS_ASSET_DIR = assetDir;
});

afterAll(async () => {
  if (previousAssetDir === undefined) delete process.env.NAS_ASSET_DIR;
  else process.env.NAS_ASSET_DIR = previousAssetDir;
  if (assetDir !== undefined) {
    await rm(assetDir, { recursive: true, force: true });
  }
});

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
    const origXdg = process.env.XDG_CONFIG_HOME;
    try {
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
  ["dev"] {
    agent = "claude"
    network {
      reviewRules = new Listing { new ReviewRule { host = "api.github.com"; action = "allow" } }
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
      await setupNasDir(projectDir, configPkl);

      const config = await loadConfig({ startDir: projectDir });
      expect(config.profiles.dev.agent).toEqual("copilot");
      expect(config.profiles.dev.network.reviewRules).toEqual([
        { host: "api.github.com", action: "allow", audit: true },
      ]);
    } finally {
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
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

// reviewRules の要素型がプリセットとの union になったとき、Pkl は既定要素を
// 決められなくなり、型を書かない `new { ... }` が構築できなくなった。既存の
// 設定はほぼその書き方をしているので、union 化した時点で読めなくなっていた
// (実際にこのリポジトリ自身の .nas/config.pkl が評価できなくなっていた)。
// 既存テストがどれも `new ReviewRule { ... }` と型を明示していたため気付け
// なかった。型を省いた書き方をそのまま固定する。
test.skipIf(!hasPkl)(
  "pkl: review rules without an explicit element type still load",
  async () => {
    const configPkl = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    network {
      reviewRules {
        new { host = "api.github.com"; action = "allow" }
        new { method = "POST"; host = "httpbin.org"; action = "review" }
        new { action = "review" }
      }
    }
  }
}
`;
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-bare-rule-"));
    try {
      await setupNasDir(tmpDir, configPkl);
      const config = await loadConfig({ startDir: tmpDir });
      expect(config.profiles.dev.network.reviewRules).toEqual([
        { host: "api.github.com", action: "allow", audit: true },
        {
          method: "POST",
          host: "httpbin.org",
          action: "review",
          audit: true,
        },
        { action: "review", audit: true },
      ]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "pkl: request policy serializes bodyless handler and preserves ordinary rules",
  async () => {
    const configPkl = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    mask = new MaskConfig {
      proxy = true
    }
    network {
      reviewRules = new Listing {
        new ReviewRule {
          host = "api.github.com"
          action = "allow"
        }
        new ReviewRule {
          id = "bodyless.settings"
          method = "GET"
          host = "api.example.com"
          path = "/v1/settings"
          action = "review"
          requestPolicy = new BodylessRequestPolicy {}
        }
        new ReviewRule {
          id = "messages.create"
          method = "POST"
          host = "api.example.com"
          path = "/v1/messages"
          action = "allow"
          requestPolicy = new JsonRequestPolicy {
            taggedUnions {
              new TaggedUnionGuard {
                at = "/messages/*/content/*"
                discriminator = "type"
                allowedTags { "text"; "image" }
              }
            }
            encodedFields {
              new EncodedField {
                at = "/messages/*/content/*/source"
                whenField = "type"
                whenEquals = "base64"
                dataField = "data"
                encoding = "base64"
              }
            }
          }
        }
      }
    }
  }
}
`;
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-policy-"));
    try {
      await setupNasDir(tmpDir, configPkl);
      const config = await loadConfig({ startDir: tmpDir });
      expect(config.profiles.dev.network.reviewRules).toEqual([
        { host: "api.github.com", action: "allow", audit: true },
        {
          id: "bodyless.settings",
          method: "GET",
          host: "api.example.com",
          path: "/v1/settings",
          action: "review",
          audit: true,
          requestPolicy: { kind: "bodyless" },
        },
        {
          id: "messages.create",
          method: "POST",
          host: "api.example.com",
          path: "/v1/messages",
          action: "allow",
          audit: true,
          requestPolicy: {
            kind: "json",
            maxBodyBytes: 33554432,
            maxDepth: 64,
            maxNodes: 200000,
            maxDecodedBytes: 33554432,
            taggedUnions: [
              {
                at: "/messages/*/content/*",
                discriminator: "type",
                allowedTags: ["text", "image"],
              },
            ],
            encodedFields: [
              {
                at: "/messages/*/content/*/source",
                whenField: "type",
                whenEquals: "base64",
                dataField: "data",
                encoding: "base64",
              },
            ],
          },
        },
      ]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "pkl: anthropicV1 expands with a custom prefix, host, and filter",
  async () => {
    const configPkl = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    mask = new MaskConfig {
      proxy = true
    }
    network {
      reviewRules {
        // 追加ルールはプリセットの終端 deny より前に置く (first-match)。
        new ReviewRule {
          id = "gw.company-bootstrap"
          method = "GET"
          host = "gateway.example.com"
          path = "/company/bootstrap"
          action = "review"
          requestPolicy = new BodylessRequestPolicy {}
        }
        for (r in module.anthropicV1("gw", "gateway.example.com")
                    .filter((r) -> r.id != "gw.bodyless.settings")) { r }
      }
    }
  }
}
`;
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-preset-"));
    try {
      await setupNasDir(tmpDir, configPkl);
      const config = await loadConfig({ startDir: tmpDir });
      const resolved = resolveReviewRules(
        config.profiles.dev.network.reviewRules,
      );

      // filter で外したルールは消え、残りはすべて指定ホストに向く。
      expect(
        resolved.rules.some((rule) => rule.id === "gw.bodyless.settings"),
      ).toBe(false);
      expect(
        resolved.rules.every((rule) => rule.host === "gateway.example.com"),
      ).toBe(true);
      expect(
        resolved.rules.find((rule) => rule.id === "gw.messages.create"),
      ).toMatchObject({ method: "POST", path: "/v1/messages" });
      expect(resolved.rules[0]).toMatchObject({
        id: "gw.company-bootstrap",
        path: "/company/bootstrap",
        action: "review",
      });
      expect(resolved.rules.at(-1)).toMatchObject({
        id: "gw.default-deny",
        host: "gateway.example.com",
        action: "deny",
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

/**
 * fixture の権威は Schema.pkl の `anthropicV1()` にある。生成器と同じ経路
 * (pkl 評価 → loadConfig → resolveReviewRules) を通した結果がコミット済みの
 * fixture と一致することを固定し、pkl 側だけ変えて fixture を更新し忘れる
 * 乖離を落とす。ずれたら `bun run scripts/gen_resolved_review_rules_fixture.ts`。
 */
test.skipIf(!hasPkl)(
  "pkl: anthropicV1 matches the committed cross-language fixture",
  async () => {
    const generated = await generateAnthropicV1Fixture();
    const committed = JSON.parse(
      await readFile(
        new URL(
          "../network/fixtures/resolved_review_rules/anthropic-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    expect(generated).toEqual(committed);
  },
);

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
