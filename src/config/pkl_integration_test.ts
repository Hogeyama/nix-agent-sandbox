import { afterAll, beforeAll, expect, test } from "bun:test";

/**
 * Integration tests: Pkl 設定の --project-dir 評価テスト
 *
 * pkl コマンドが必要。環境にない場合はスキップされる。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveAsset } from "../lib/asset.ts";
import { resolveAuthzConfig } from "../network/authz/resolve.ts";
import { loadConfig } from "./load.ts";
import { useRepoSchemaAsset } from "./schema_asset_testing.ts";

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

let restoreSchemaAsset: (() => Promise<void>) | undefined;

beforeAll(async () => {
  restoreSchemaAsset = await useRepoSchemaAsset();
});

afterAll(async () => {
  await restoreSchemaAsset?.();
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
    expect(config.profiles.dev.mode).toEqual("terminal");
    expect(config.profiles.dev.network).toMatchObject({
      requestBodyAudit: {
        enable: false,
        retentionSeconds: 604_800,
        maxBodyBytes: 8_388_608,
        maxTotalBytes: 268_435_456,
      },
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test.skipIf(!hasPkl)(
  "pkl: accepts legacy, typed, and inferred port forward entries",
  async () => {
    const configPkl = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    network {
      proxy = new ProxyConfig { forwardPorts { 7000 } }
      localForwards {
        new PortForwardConfig { hostPort = 8080; containerPort = 3000 }
      }
      remoteForwards {
        new { hostPort = 9000; containerPort = 4000 }
      }
    }
  }
}
`;
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-forwards-"));
    try {
      await setupNasDir(tmpDir, configPkl);
      const config = await loadConfig({ startDir: tmpDir });
      expect(config.profiles.dev.network.localForwards).toEqual([
        { hostPort: 8080, containerPort: 3000 },
      ]);
      expect(config.profiles.dev.network.remoteForwards).toEqual([
        { hostPort: 9000, containerPort: 4000 },
        { hostPort: 7000, containerPort: 7000 },
      ]);
      expect(config.profiles.dev.network.proxy.forwardPorts).toEqual([7000]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

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
      remoteForwards {
        new { hostPort = 15432; containerPort = 5432 }
      }
      scopes {
        ["github"] {
          targets { "api.github.com" }
          fallback = "allow"
          webSocket = "allow"
        }
      }
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
      expect(config.profiles.dev.network.scopes).toEqual({
        github: {
          targets: ["api.github.com"],
          fallback: "allow",
          webSocket: "allow",
          inject: [],
          rules: {},
        },
      });
      expect(config.profiles.dev.network.remoteForwards).toEqual([
        { hostPort: 15432, containerPort: 5432 },
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

// スコープとルールは Mapping なので、キーへの amend で要素を書ける。要素の型を
// 書かなくても既定要素が決まることを固定する。型を明示した書き方しかテストして
// いないと、型を省いた実設定が読めなくなっても気付けない。
test.skipIf(!hasPkl)(
  "pkl: scopes and rules load without an explicit element type",
  async () => {
    const configPkl = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    network {
      fallback = "review"
      scopes {
        ["github"] { targets { "api.github.com" }; fallback = "allow" }
        ["httpbin"] {
          targets { "httpbin.org" }
          fallback = "allow"
          rules {
            ["post"] {
              match { methods { "POST" }; paths { "/**" } }
              onMatch = "review"
            }
          }
        }
      }
    }
  }
}
`;
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-bare-rule-"));
    try {
      await setupNasDir(tmpDir, configPkl);
      const config = await loadConfig({ startDir: tmpDir });
      const network = config.profiles.dev.network;
      expect(network.fallback).toEqual("review");
      expect(Object.keys(network.scopes)).toEqual(["github", "httpbin"]);
      expect(network.scopes.github?.webSocket).toBe("deny");
      expect(network.scopes.httpbin?.rules?.post).toEqual({
        match: { paths: ["/**"], methods: ["POST"], captures: {} },
        onMatch: "review",
        onIndeterminate: "deny",
        expect: [],
        inject: [],
        overrides: [],
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "pkl: acceptance conditions serialize with a discriminating kind",
  async () => {
    const configPkl = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    network {
      scopes {
        ["api"] {
          targets { "api.example.com" }
          fallback = "deny"
          rules {
            ["settings"] {
              match { methods { "GET" }; paths { "/v1/settings" } }
              onMatch = "review"
              expect { new EmptyBody {} }
            }
            ["messages"] {
              match {
                methods { "POST" }
                paths { "/v1/messages" }
                body { format = "json" }
              }
              onMatch = "allow"
              expect {
                new JsonRoot { rootType = "object" }
                new UnionShape {
                  at = "/messages/*/content/*"
                  exclude { "/tools/**" }
                  discriminator = "type"
                  allowed { "text"; "image" }
                  onViolation = "allow"
                }
              }
              audit = "always"
            }
          }
        }
      }
    }
  }
}
`;
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-expect-"));
    try {
      await setupNasDir(tmpDir, configPkl);
      const config = await loadConfig({ startDir: tmpDir });
      const rules = config.profiles.dev.network.scopes.api?.rules;
      // Pkl のサブクラスは JSON になると型を失うので、`kind` が受理条件の
      // 種別を運ぶ。これが欠けると addon は何を検査すべきか分からない。
      expect(rules?.settings?.expect).toEqual([
        { kind: "emptyBody", onViolation: "deny" },
      ]);
      expect(rules?.messages?.expect).toEqual([
        { kind: "jsonRoot", onViolation: "deny", rootType: "object" },
        {
          kind: "unionShape",
          onViolation: "allow",
          at: "/messages/*/content/*",
          exclude: ["/tools/**"],
          discriminator: "type",
          allowed: ["text", "image"],
        },
      ]);
      expect(rules?.messages?.match.body).toEqual({
        format: "json",
        equals: {},
        oneOf: {},
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "pkl: the anthropic preset amends into a scope without displacing its rules",
  async () => {
    const configPkl = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    network {
      scopes {
        // 比較の基準となる、手を加えていないプリセット。
        ["plain"] = module.presets.anthropic.v1
        // ゲートウェイ経由でも、ホストマッチングを緩めずに宛先だけ差し替える。
        ["gw"] = (module.presets.anthropic.v1) {
          targets = new Listing { "gateway.example.com" }
          rules {
            ["company-bootstrap"] {
              match { methods { "GET" }; paths { "/company/bootstrap" } }
              onMatch = "allow"
              expect { new EmptyBody {} }
            }
          }
        }
      }
    }
  }
}
`;
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-preset-"));
    try {
      await setupNasDir(tmpDir, configPkl);
      const config = await loadConfig({ startDir: tmpDir });
      const plain = config.profiles.dev.network.scopes.plain;
      const scope = config.profiles.dev.network.scopes.gw;

      expect(scope?.targets).toEqual(["gateway.example.com"]);
      // preset のルールは残り、追加したルールが末尾に来る。「プリセットより
      // 前に置く」という手順が要らないのは終端 deny が fallback になったため。
      // プリセットの中身には依存しないので、ルールを増減しても書き換えない。
      const presetRuleKeys = Object.keys(plain?.rules ?? {});
      expect(presetRuleKeys.length).toBeGreaterThan(0);
      expect(Object.keys(scope?.rules ?? {})).toEqual([
        ...presetRuleKeys,
        "company-bootstrap",
      ]);
      expect(scope?.fallback).toEqual("review");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
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
    network {
      scopes {
        ["api"] {
          targets { "api.example.com" }
          webSocket = "review"
        }
      }
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

for (const enabled of [false, true]) {
  test.skipIf(!hasPkl)(
    `pkl: direnv defaults off and can enable without Nix (${enabled})`,
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "nas-pkl-direnv-"));
      try {
        await setupNasDir(
          root,
          `amends "Schema.pkl"
profiles {
  ["dev"] {
    agent = "claude"
    nix { enable = false }
    ${enabled ? "direnv { enable = true }" : ""}
  }
}`,
        );
        const config = await loadConfig({ startDir: root });
        expect(config.profiles.dev.direnv).toEqual({ enable: enabled });
        expect(config.profiles.dev.nix.enable).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

/**
 * spec「設定管理者が書くもの」の Pkl 例を実際に評価し、解決済みドキュメントまで
 * 新しい語彙が欠けずに届くことを確かめる。
 *
 * Pkl → loadConfig → resolveAuthzConfig の 3 段のどこか 1 つが旧語彙のままだと
 * 制約は黙って落ちる。wire に載る JSON をここで固定するのは、addon がキーの
 * 過不足を検証する相手がこの JSON だからである。
 */
test.skipIf(!hasPkl)(
  "pkl: GraphQL の経路条件が解決済みドキュメントまで欠けずに届く",
  async () => {
    const configPkl = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    network {
      scopes {
        ["github"] {
          targets { "api.github.com" }
          fallback = "review"
          rules {
            ["graphql.read"] {
              match {
                methods { "POST" }
                paths { "/graphql" }
                body { format = "json" }
              }
              onMatch = "allow"
              onIndeterminate = "review"
              expect {
                new BodyExpect {
                  graphql {
                    operations { "query" }
                    fieldPaths {
                      "/repository/nameWithOwner"
                      "/repository/issues/nodes/body"
                      "/repository/issues/nodes/comments/nodes/body"
                      "/repository/issues/pageInfo/endCursor"
                      "/repository/issues/pageInfo/hasNextPage"
                      "/repository/object/text"
                      "/organization/login"
                      "/organization/membersWithRole/nodes/login"
                    }
                    fieldArguments {
                      ["/repository"] { ["owner"] { "my-org" } }
                      ["/organization"] { ["login"] { "my-org" } }
                    }
                  }
                  onViolation = "review"
                }
              }
            }
          }
        }
      }
    }
  }
}
`;
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-graphql-"));
    try {
      await setupNasDir(tmpDir, configPkl);
      const profile = (await loadConfig({ startDir: tmpDir })).profiles.dev;
      const outcome = resolveAuthzConfig({
        secrets: profile.secrets,
        mask: profile.mask,
        network: profile.network,
      });
      expect(outcome.diagnostics).toEqual([]);
      const expects = outcome.document?.scopes[0]?.rules[0]?.expect;
      // JSON へ往復させる。ファイルに書いて addon が読む形そのものを見る。
      expect(JSON.parse(JSON.stringify(expects))).toEqual([
        {
          kind: "body",
          onViolation: "review",
          equals: {},
          oneOf: {},
          graphql: {
            at: "/query",
            operations: ["query"],
            fieldPaths: [
              "/repository/nameWithOwner",
              "/repository/issues/nodes/body",
              "/repository/issues/nodes/comments/nodes/body",
              "/repository/issues/pageInfo/endCursor",
              "/repository/issues/pageInfo/hasNextPage",
              "/repository/object/text",
              "/organization/login",
              "/organization/membersWithRole/nodes/login",
            ],
            fieldArguments: {
              "/repository": { owner: ["my-org"] },
              "/organization": { login: ["my-org"] },
            },
          },
        },
      ]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

/**
 * 旧語彙は Pkl の時点で止める。`rootFields` / 全域 `arguments` は
 * `GraphqlMatch` に存在しないので、Schema.pkl の型検査が読み替えも補完もせずに
 * 落とす。TypeScript の検査まで降りてこない層でも塞がっていることを見る。
 */
test.skipIf(!hasPkl)(
  "pkl: 旧 rootFields / 全域 arguments を Schema.pkl が拒む",
  async () => {
    for (const legacy of [
      'rootFields { "repository" }',
      'arguments { ["owner"] { "my-org" } }',
    ]) {
      const configPkl = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    network {
      scopes {
        ["github"] {
          targets { "api.github.com" }
          rules {
            ["graphql"] {
              match {
                methods { "POST" }
                paths { "/graphql" }
                body {
                  format = "json"
                  graphql {
                    operations { "query" }
                    fieldPaths { "/viewer/login" }
                    ${legacy}
                  }
                }
              }
              onMatch = "allow"
            }
          }
        }
      }
    }
  }
}
`;
      const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-pkl-graphql-old-"));
      try {
        await setupNasDir(tmpDir, configPkl);
        await expect(loadConfig({ startDir: tmpDir })).rejects.toThrow(
          /pkl eval exited with code/,
        );
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    }
  },
);
