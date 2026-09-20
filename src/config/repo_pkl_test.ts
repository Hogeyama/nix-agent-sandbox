import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveAsset } from "../lib/asset.ts";
import {
  REPO_GRAPHQL_CONDITION,
  repoGithubApiExample,
} from "../network/authz/examples_fixture.ts";
import { decide, resolveAuthzConfig } from "../network/authz/resolve.ts";
import { loadConfig } from "./load.ts";
import { useRepoSchemaAsset } from "./schema_asset_testing.ts";

let restoreSchemaAsset: (() => Promise<void>) | undefined;

beforeAll(async () => {
  restoreSchemaAsset = await useRepoSchemaAsset();
});

afterAll(async () => {
  await restoreSchemaAsset?.();
});

async function pklAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pkl", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
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
 * .nas/ 構造をセットアップする。
 */
async function setupNasDir(
  parentDir: string,
  configPkl: string,
): Promise<string> {
  const nasDir = path.join(parentDir, ".nas");
  await mkdir(nasDir, { recursive: true });

  const schemaText = await readBundledSchema();
  await writeFile(path.join(nasDir, "Schema.pkl"), schemaText);

  const pklProject = `amends "pkl:Project"

evaluatorSettings {
  modulePath {
    "."
  }
}
`;
  await writeFile(path.join(nasDir, "PklProject"), pklProject);
  await writeFile(path.join(nasDir, "config.pkl"), configPkl);
  return nasDir;
}

test.skipIf(!hasPkl)(
  "a retired name inside a string literal does not block startup",
  async () => {
    // 廃止したのは識別子であって語ではない。パスやホスト名にたまたま同じ綴りが
    // 現れる設定は、移行の対象ではないので動かなければならない。
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-repo-pkl-legacy-"));
    try {
      await setupNasDir(
        tmpDir,
        `amends "Schema.pkl"

profiles {
  ["claude"] {
    agent = "claude"
    network {
      scopes {
        ["vault"] {
          targets { "credentials.example.com" }
          rules {
            ["read"] {
              match { paths { "/v1/credentials/**" } }
              onMatch = "allow"
            }
          }
        }
      }
    }
  }
}
`,
      );

      const config = await loadConfig({ startDir: tmpDir });
      expect(Object.keys(config.profiles.claude.network.scopes)).toEqual([
        "vault",
      ]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "Schema.pkl loads with all profile features via .nas/ project-dir",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-repo-pkl-test-"));
    try {
      await setupNasDir(
        tmpDir,
        `amends "Schema.pkl"

local baseProfile: Profile = new {
  agent = "claude"
  session { multiplex = true }
  direnv { enable = true }
}

profiles {
  ["claude"] = (baseProfile) {}
  ["copilot"] = (baseProfile) { agent = "copilot" }
  ["codex"] = (baseProfile) { agent = "codex" }
  ["hostexec-demo"] = (baseProfile) {
    hostexec = new HostExecConfig {
      rules {
        new {
          id = "gh-cli"
          match { argv0 = "gh" }
        }
      }
    }
  }
}
`,
      );

      const config = await loadConfig({ startDir: tmpDir });
      expect(Object.keys(config.profiles)).toEqual(
        expect.arrayContaining(["claude", "copilot", "codex", "hostexec-demo"]),
      );
      expect(config.profiles.claude.agent).toBe("claude");
      expect(config.profiles["hostexec-demo"].agent).toBe("claude");
      expect(config.profiles["hostexec-demo"].nix.enable).toBe("auto");
      expect(config.profiles["hostexec-demo"].session.multiplex).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

/** このリポジトリが実際に使っている `.nas/config.pkl`。 */
const repoConfigPkl = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  ".nas",
  "config.pkl",
);

/** `github-api` スコープを共有する、日常的に使うプロファイル。 */
const SHARED_GITHUB_PROFILES = [
  "claude",
  "codex",
  "copilot",
  "anthropic-policy-demo",
] as const;

/**
 * A19: このリポジトリ自身の設定を pkl で評価し、共通の GraphQL ルールが
 * 仕様の初期許可表どおりに解決されることを見る。
 *
 * `.nas/` には Schema.pkl と PklProject が `.gitignore` されているので
 * (`nas` が置く生成物)、バンドル済みの Schema.pkl と最小の PklProject を
 * 一時ディレクトリに組み、**追跡している config.pkl そのもの**をそこへ置いて
 * 評価する。設定だけを新語彙にしても、`fieldArguments` の経路が許可末端の
 * 途中でなければ解決時に落ちるし、プロファイルの継承のどこかで条件が
 * 差し替わっていれば 4 つのうちどれかが食い違う。
 *
 * 期待値は `examples_fixture.ts` の {@link REPO_GRAPHQL_CONDITION} で、
 * `graphql_acceptance_test.ts` の A19 が同じ定数を addon に通す。設定と
 * 期待表が離れたらどちらかが落ちる。
 *
 * `graphql_acceptance_test.ts` の A19 が使う {@link repoGithubApiExample} は
 * GraphQL の条件だけでなく `owned.rest-read` ルール (`methods` / `paths` /
 * `captures`) とスコープの `fallback` も手で写している。その 2 つの探索
 * パス (`/users/Hogeyama/starred` と `/repos/other/repo/readme`) だけを見る
 * `decide` の呼び出しでは、その 2 経路に触れない変更 (新しい capture、狙って
 * いない範囲へのパスの拡張・縮小) を見逃す。なので `decide` の確認に加えて、
 * `repoGithubApiExample()` が返す `owned.rest-read` の生の設定とスコープの
 * `fallback` を、ここで pkl 評価した生の設定と直接突き合わせる。
 */
test.skipIf(!hasPkl)(
  "the repository's own config resolves the shared GraphQL rule to the spec's initial allow-list",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-repo-pkl-graphql-"));
    try {
      await setupNasDir(tmpDir, await readFile(repoConfigPkl, "utf8"));
      const config = await loadConfig({ startDir: tmpDir });

      for (const name of SHARED_GITHUB_PROFILES) {
        const profile = config.profiles[name];
        if (profile === undefined) throw new Error(`missing profile ${name}`);

        // `repoGithubApiExample()` は GraphQL 条件以外を手で写している。
        // `owned.rest-read` の match (methods/paths/captures) とスコープの
        // `fallback` を、解決前の生の設定同士で直接突き合わせる。2 本の
        // probe path だけを通す `decide` の確認では、その 2 経路に触れない
        // 差 (新しい capture、範囲外へのパスの変更) を見逃すため。
        const fixtureScope =
          repoGithubApiExample().network.scopes["github-api"];
        const realScope = profile.network.scopes["github-api"];
        if (realScope === undefined) {
          throw new Error(`missing scope github-api for ${name}`);
        }
        expect([name, realScope.fallback]).toEqual([
          name,
          fixtureScope.fallback,
        ]);
        const realRestRule = realScope.rules?.["owned.rest-read"];
        const fixtureRestRule = fixtureScope.rules?.["owned.rest-read"];
        if (realRestRule === undefined || fixtureRestRule === undefined) {
          throw new Error(`missing owned.rest-read rule for ${name}`);
        }
        expect([
          name,
          realRestRule.onMatch,
          realRestRule.match.methods,
          realRestRule.match.paths,
          realRestRule.match.captures,
        ]).toEqual([
          name,
          fixtureRestRule.onMatch,
          fixtureRestRule.match.methods,
          fixtureRestRule.match.paths,
          fixtureRestRule.match.captures,
        ]);

        const outcome = resolveAuthzConfig({
          secrets: profile.secrets,
          mask: profile.mask,
          network: profile.network,
        });
        expect([name, outcome.diagnostics]).toEqual([name, []]);
        const document = outcome.document;
        if (document === null) throw new Error(`unresolvable profile ${name}`);

        const scope = document.scopes.find((one) => one.name === "github-api");
        const rule = scope?.rules.find((one) => one.key === "graphql.read");
        // JSON へ往復させる。addon がキーの過不足を検証する相手はこの形である。
        expect([name, JSON.parse(JSON.stringify(rule?.expect))]).toEqual([
          name,
          [
            {
              kind: "body",
              onViolation: "review",
              equals: {},
              oneOf: {},
              graphql: {
                at: "/query",
                operations: ["query"],
                fieldPaths: REPO_GRAPHQL_CONDITION.fieldPaths,
                fieldArguments: REPO_GRAPHQL_CONDITION.fieldArguments,
              },
            },
          ],
        ]);
        expect([name, rule?.onMatch, rule?.onIndeterminate]).toEqual([
          name,
          "allow",
          "review",
        ]);

        // REST の境界は今回動かしていない。自 owner の starred 一覧は今まで
        // どおり自動許可で、第三者の README はスコープの fallback に落ちる。
        const address = { host: "api.github.com", port: 443 };
        const starred = decide(document, address, {
          method: "GET",
          path: "/users/Hogeyama/starred",
        });
        expect([name, starred.ruleId, starred.action, starred.reason]).toEqual([
          name,
          "github-api.owned.rest-read",
          "allow",
          "rule",
        ]);
        const readme = decide(document, address, {
          method: "GET",
          path: "/repos/other/repo/readme",
        });
        expect([name, readme.ruleId, readme.action, readme.reason]).toEqual([
          name,
          "github-api.$fallback",
          "review",
          "scope-fallback",
        ]);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);
