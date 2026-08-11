import { describe, expect, test } from "bun:test";
import {
  type AuthzConfig,
  FALLBACK_RULE_KEY,
  RULE_KEY_PATTERN,
} from "./config.ts";
import {
  anthropicExample,
  githubGraphqlExample,
  githubPathsExample,
} from "./examples_fixture.ts";
import {
  decide,
  type ResolvedDocument,
  resolveAuthzConfig,
  withoutInjectLiterals,
} from "./resolve.ts";
import type { AuthzRequest, RequestBody, TargetAddress } from "./types.ts";

function documentOf(config: AuthzConfig): ResolvedDocument {
  const outcome = resolveAuthzConfig(config);
  if (outcome.document === null) {
    throw new Error(
      `解決できない設定:\n${outcome.diagnostics.map((d) => d.message).join("\n")}`,
    );
  }
  return outcome.document;
}

function at(host: string, port = 443): TargetAddress {
  return { host, port };
}

function request(
  method: string,
  path: string,
  body: RequestBody = { kind: "absent" },
): AuthzRequest {
  return { method, path, body };
}

const JSON_BODY: RequestBody = { kind: "json", value: { a: 1 } };

describe("要件 1 の GraphQL スコープ", () => {
  const document = documentOf(githubGraphqlExample());
  const github = at("api.github.com");

  test("JSON ボディの POST /graphql は graphql ルールが許可する", () => {
    const decision = decide(
      document,
      github,
      request("POST", "/graphql", JSON_BODY),
    );
    expect(decision.action).toBe("allow");
    expect(decision.ruleId).toBe("github.graphql");
    expect(decision.reason).toBe("rule");
  });

  test("許可されたリクエストには Authorization を注入する", () => {
    const decision = decide(
      document,
      github,
      request("POST", "/graphql", JSON_BODY),
    );
    expect(decision.inject).toEqual([
      {
        name: "Authorization",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: template: の ${...} は Pkl の設定値の構文であり、TS のテンプレートリテラルではない
        value: "template:Bearer ${gh-token}",
      },
    ]);
  });

  test("受理条件は解決後も onViolation つきで残る", () => {
    const decision = decide(
      document,
      github,
      request("POST", "/graphql", JSON_BODY),
    );
    expect(decision.expect).toHaveLength(1);
    expect(decision.expect[0]?.onViolation).toBe("review");
  });

  test("JSON として解析できないボディは判定不能になり onIndeterminate が効く", () => {
    const decision = decide(
      document,
      github,
      request("POST", "/graphql", { kind: "binary" }),
    );
    expect(decision.action).toBe("review");
    expect(decision.reason).toBe("indeterminate");
    expect(decision.ruleId).toBe("github.graphql");
    // 解析できなかったボディに対して受理条件は何も言えない。
    expect(decision.expect).toEqual([]);
  });

  test("どのルールも引き受けないリクエストはスコープの fallback に落ちる", () => {
    const decision = decide(document, github, request("GET", "/users/me"));
    expect(decision.action).toBe("review");
    expect(decision.reason).toBe("scope-fallback");
    expect(decision.ruleId).toBe("github.$fallback");
  });

  test("どのスコープにも属さないターゲットは network.fallback に落ちる", () => {
    const decision = decide(
      document,
      at("evil.example.com"),
      request("GET", "/"),
    );
    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("network-fallback");
    expect(decision.ruleId).toBe("$fallback");
    // 属するスコープがないので注入する資格情報もない。
    expect(decision.inject).toEqual([]);
  });
});

describe("擬似ルール ID", () => {
  test("擬似 ID はユーザーが書けるキーの構文の外にある", () => {
    // 承認の同一性はルール ID を鍵にするので、擬似 ID と同じ実 ID を持つ
    // ルールを書けてしまうと、fallback への承認がそのルールに流用される。
    expect(RULE_KEY_PATTERN.test(FALLBACK_RULE_KEY)).toBe(false);
  });

  test("擬似 ID を名乗るキーは設定エラーになる", () => {
    const outcome = resolveAuthzConfig({
      network: {
        scopes: {
          github: {
            targets: ["api.github.com"],
            rules: {
              [FALLBACK_RULE_KEY]: {
                match: { paths: ["/**"] },
                onMatch: "allow",
              },
            },
          },
        },
      },
    });
    expect(outcome.document).toBeNull();
    expect(outcome.diagnostics.map((d) => d.message).join("\n")).toContain(
      JSON.stringify(FALLBACK_RULE_KEY),
    );
  });
});

describe("要件 2 と 3 のパスで絞るスコープ", () => {
  const document = documentOf(githubPathsExample());
  const github = at("api.github.com");

  test("captures で許した組織の読み取りは許可される", () => {
    const decision = decide(
      document,
      github,
      request("GET", "/repos/my-org/nas/issues"),
    );
    expect(decision.action).toBe("allow");
    expect(decision.ruleId).toBe("github.repos.read");
  });

  test("別の組織はどのルールにも一致せず fallback に落ちる", () => {
    const decision = decide(
      document,
      github,
      request("GET", "/repos/other-org/nas/issues"),
    );
    expect(decision.reason).toBe("scope-fallback");
    expect(decision.action).toBe("review");
  });

  test("issue の作成は issues.write が許可する", () => {
    const decision = decide(
      document,
      github,
      request("POST", "/repos/my-org/nas/issues", JSON_BODY),
    );
    expect(decision.ruleId).toBe("github.issues.write");
    expect(decision.action).toBe("allow");
  });

  test("削除は人間の確認に回る", () => {
    const decision = decide(
      document,
      github,
      request("DELETE", "/repos/my-org/nas"),
    );
    expect(decision.ruleId).toBe("github.repos.delete");
    expect(decision.action).toBe("review");
  });

  test("クエリ文字列は選択に参加しない", () => {
    const decision = decide(
      document,
      github,
      request("GET", "/repos/my-org/nas/issues?state=open"),
    );
    expect(decision.ruleId).toBe("github.repos.read");
  });
});

describe("要件 4 から 6 の Anthropic preset", () => {
  const document = documentOf(anthropicExample());
  const anthropic = at("api.anthropic.com");

  test("POST /v1/messages は許可され、content block の受理条件が付く", () => {
    const decision = decide(
      document,
      anthropic,
      request("POST", "/v1/messages", JSON_BODY),
    );
    expect(decision.action).toBe("allow");
    expect(decision.ruleId).toBe("anthropic.messages");
    expect(decision.expect.map((e) => e.kind)).toEqual([
      "unionShape",
      "unionShape",
      "jsonRoot",
    ]);
  });

  test("bootstrap 系の GET は EmptyBody を受理条件に持つ", () => {
    const decision = decide(
      document,
      anthropic,
      request("GET", "/api/claude_cli/bootstrap"),
    );
    expect(decision.action).toBe("allow");
    expect(decision.ruleId).toBe("anthropic.bootstrap");
    expect(decision.expect.map((e) => e.kind)).toEqual(["emptyBody"]);
    // 明示しなかった onViolation は deny に落ちる。
    expect(decision.expect[0]?.onViolation).toBe("deny");
  });

  test("宣言されていないエンドポイントは fallback で拒否される", () => {
    const decision = decide(
      document,
      anthropic,
      request("POST", "/v1/complete", JSON_BODY),
    );
    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("scope-fallback");
  });

  test("壊れたボディは messages ルールの onIndeterminate = deny で止まる", () => {
    const decision = decide(
      document,
      anthropic,
      request("POST", "/v1/messages", { kind: "binary" }),
    );
    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("indeterminate");
  });
});

describe("評価順", () => {
  function twoRules(): ResolvedDocument {
    return documentOf({
      network: {
        scopes: {
          api: {
            targets: ["api.example.com"],
            fallback: "deny",
            rules: {
              wide: {
                match: { methods: ["POST"], paths: ["/**"] },
                onMatch: "allow",
              },
              narrow: {
                match: {
                  methods: ["POST"],
                  paths: ["/v1/x"],
                  body: { format: "json" },
                },
                onMatch: "review",
                onIndeterminate: "deny",
              },
            },
          },
        },
      },
    });
  }

  test("特異度の高いルールが宣言順より先に評価される", () => {
    const decision = decide(
      twoRules(),
      at("api.example.com"),
      request("POST", "/v1/x", JSON_BODY),
    );
    expect(decision.ruleId).toBe("api.narrow");
  });

  test("判定不能に到達した時点で評価を打ち切る", () => {
    // 広い allow に黙って拾わせないための打ち切りである。
    const decision = decide(
      twoRules(),
      at("api.example.com"),
      request("POST", "/v1/x", { kind: "binary" }),
    );
    expect(decision.action).toBe("deny");
    expect(decision.ruleId).toBe("api.narrow");
  });

  test("条件が偽になった候補は何も主張せず、広い候補の帰結が適用される", () => {
    // ボディを持たないリクエストは format = "json" を偽にする。判定不能では
    // ないので打ち切らず、次の候補へ進む。
    const decision = decide(
      twoRules(),
      at("api.example.com"),
      request("POST", "/v1/x"),
    );
    expect(decision.ruleId).toBe("api.wide");
    expect(decision.action).toBe("allow");
  });

  test("注入した葉の真偽だけを使い、候補の順序と打ち切りは decide が保つ", () => {
    const evaluated: string[] = [];
    const decision = decide(
      twoRules(),
      at("api.example.com"),
      request("POST", "/v1/x", JSON_BODY),
      (rule) => {
        evaluated.push(rule.id);
        return rule.id === "api.narrow" ? "false" : "indeterminate";
      },
    );

    expect(evaluated).toEqual(["api.narrow", "api.wide"]);
    expect(decision.ruleId).toBe("api.wide");
    expect(decision.reason).toBe("indeterminate");
  });

  test("候補にならないルールは候補どうしの順序を変えない", () => {
    // ping.json と ping.none は受理集合が交わらず比較不能なので、宣言順で決着
    // する。ping.get は GET しか受理しないので POST の候補ではない。候補でない
    // ルールが宣言順のタイブレークに口を出すと、deny が allow に化ける。
    function pingDocument(withGet: boolean): ResolvedDocument {
      return documentOf({
        network: {
          scopes: {
            api: {
              targets: ["api.example.com"],
              rules: {
                "ping.json": {
                  match: { paths: ["/v1/ping"], body: { format: "json" } },
                  onMatch: "allow",
                  onIndeterminate: "deny",
                },
                "ping.none": {
                  match: { paths: ["/v1/ping"], body: { format: "none" } },
                  onMatch: "allow",
                },
                ...(withGet
                  ? {
                      "ping.get": {
                        match: {
                          methods: ["GET"],
                          paths: ["/v1/ping"],
                          body: { format: "json" },
                        },
                        onMatch: "allow" as const,
                      },
                    }
                  : {}),
              },
            },
          },
        },
      });
    }

    // 0 バイトのボディは format = "json" を解析できず判定不能になる。
    const post = request("POST", "/v1/ping", { kind: "empty" });
    const withGet = decide(pingDocument(true), at("api.example.com"), post);
    const without = decide(pingDocument(false), at("api.example.com"), post);

    expect(without.ruleId).toBe("api.ping.json");
    expect(without.action).toBe("deny");
    expect(withGet.ruleId).toBe(without.ruleId);
    expect(withGet.action).toBe(without.action);
  });

  test("overrides を書いた側が先に評価される", () => {
    const document = documentOf({
      network: {
        scopes: {
          api: {
            targets: ["api.example.com"],
            rules: {
              // 特異度では決着しない組。read は capture の制約で狭く、
              // pulls はメソッドとパスで狭い。
              read: {
                match: {
                  methods: ["GET", "HEAD"],
                  paths: ["/repos/{org}/{repo}/**"],
                  captures: { org: ["my-org"] },
                },
                onMatch: "allow",
              },
              pulls: {
                match: { methods: ["GET"], paths: ["/repos/*/*/pulls"] },
                onMatch: "review",
                overrides: ["read"],
              },
            },
          },
        },
      },
    });
    const decision = decide(
      document,
      at("api.example.com"),
      request("GET", "/repos/my-org/nas/pulls"),
    );
    expect(decision.ruleId).toBe("api.pulls");
  });
});

describe("ボディの値条件", () => {
  const document = documentOf({
    network: {
      scopes: {
        api: {
          targets: ["api.example.com"],
          fallback: "deny",
          rules: {
            fast: {
              match: {
                paths: ["/v1/run"],
                body: {
                  format: "json",
                  equals: { "/mode": "fast", "/checked": true },
                },
              },
              onMatch: "allow",
              onIndeterminate: "review",
            },
            safe: {
              match: {
                paths: ["/v1/run"],
                body: { format: "json", oneOf: { "/mode": ["safe"] } },
              },
              onMatch: "review",
            },
          },
        },
      },
    },
  });
  const address = at("api.example.com");
  const run = (value: RequestBody) =>
    decide(document, address, request("POST", "/v1/run", value));

  test("解決済み契約 v3 に equals と oneOf を保存する", () => {
    expect(document.contractVersion).toBe(3);
    expect(document.scopes[0]?.rules.map((rule) => rule.match)).toEqual([
      expect.objectContaining({
        equals: { "/mode": "fast", "/checked": true },
        oneOf: {},
      }),
      expect.objectContaining({
        equals: {},
        oneOf: { "/mode": ["safe"] },
      }),
    ]);
  });

  test("ボディの値によって宣言順の異なるルールを選ぶ", () => {
    expect(
      run({ kind: "json", value: { mode: "fast", checked: true } }).ruleId,
    ).toBe("api.fast");
    const safe = run({ kind: "json", value: { mode: "safe" } });
    expect([safe.ruleId, safe.action, safe.reason]).toEqual([
      "api.safe",
      "review",
      "rule",
    ]);
  });

  test("存在しない Pointer は偽として次の候補または fallback へ進む", () => {
    const decision = run({ kind: "json", value: {} });
    expect([decision.ruleId, decision.reason]).toEqual([
      "api.$fallback",
      "scope-fallback",
    ]);
  });

  test("非 scalar と偽が混じると判定不能が勝って traversal を止める", () => {
    const decision = run({
      kind: "json",
      value: { mode: { nested: true }, checked: false },
    });
    expect([decision.ruleId, decision.action, decision.reason]).toEqual([
      "api.fast",
      "review",
      "indeterminate",
    ]);
  });
});

describe("綴りの揺れ", () => {
  test("小文字で書いたメソッドのルールも発火する", () => {
    // リクエストのメソッドは大文字で渡ってくる。設定側を揃えないと、この
    // ルールは 1 度も候補にならず、スコープの fallback が黙って引き受ける。
    const document = documentOf({
      network: {
        scopes: {
          httpbin: {
            targets: ["httpbin.org"],
            fallback: "allow",
            rules: {
              post: {
                match: { methods: ["post"], paths: ["/**"] },
                onMatch: "review",
              },
            },
          },
        },
      },
    });
    const decision = decide(document, at("httpbin.org"), request("POST", "/x"));
    expect(decision.action).toBe("review");
    expect(decision.reason).toBe("rule");
    expect(decision.ruleId).toBe("httpbin.post");
  });

  test("大文字を含むホストのターゲットもそのスコープに入る", () => {
    // ホストは小文字に揃えて渡ってくる。設定側を揃えないと、このスコープは
    // 誰にも一致せず、ネットワークの fallback が引き受ける。
    const document = documentOf({
      network: {
        fallback: "review",
        scopes: {
          logs: {
            targets: ["HTTP-Intake.logs.example.com"],
            fallback: "deny",
          },
        },
      },
    });
    const decision = decide(
      document,
      at("http-intake.logs.example.com"),
      request("POST", "/v1/input"),
    );
    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("scope-fallback");
  });

  test("大小だけが違うホストのターゲットは同じ 1 つのスコープになる", () => {
    // 素な 2 つのパターンと見なされると、どちらが選ばれるかが宣言順に落ちる。
    // 同じパターンなら設定エラーとして書き手に返る。
    const outcome = resolveAuthzConfig({
      network: {
        scopes: {
          upper: { targets: ["API.example.com"] },
          lower: { targets: ["api.example.com"] },
        },
      },
    });
    expect(
      outcome.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => diagnostic.message)
        .join("\n"),
    ).toContain("ターゲット集合が一致します");
  });
});

describe("スコープの選択", () => {
  const document = documentOf({
    network: {
      scopes: {
        wildcard: { targets: ["*.example.com"], fallback: "review" },
        exact: { targets: ["api.example.com"], fallback: "allow" },
        port: { targets: ["api.example.com:8443"], fallback: "deny" },
      },
    },
  });

  test("ポート付きの完全一致がもっとも特異である", () => {
    expect(
      decide(document, at("api.example.com", 8443), request("GET", "/")).action,
    ).toBe("deny");
  });

  test("ポートなしの完全一致がサフィックスワイルドカードに勝つ", () => {
    expect(
      decide(document, at("api.example.com", 443), request("GET", "/")).action,
    ).toBe("allow");
  });

  test("完全一致がなければサフィックスワイルドカードが選ばれる", () => {
    expect(
      decide(document, at("cdn.example.com", 443), request("GET", "/")).action,
    ).toBe("review");
  });
});

describe("継承", () => {
  const document = documentOf({
    secrets: { token: { from: "env:TOKEN" } },
    network: {
      defaults: {
        limits: { maxNodes: 50_000 },
        secrets: { "*": "mask", token: "forbid" },
        audit: "aggregate",
      },
      scopes: {
        api: {
          targets: ["api.example.com"],
          limits: { maxDepth: 32 },
          secrets: { token: "inject" },
          inject: [{ name: "Authorization", value: "secret:token" }],
          audit: "off",
          rules: {
            a: { match: { paths: ["/a"] }, onMatch: "allow" },
            b: {
              match: { paths: ["/b"] },
              onMatch: "allow",
              limits: { maxNodes: 10 },
              audit: "always",
              inject: [{ name: "Authorization", value: "literal:none" }],
            },
          },
        },
      },
    },
  });

  function decisionFor(path: string) {
    return decide(document, at("api.example.com"), request("GET", path));
  }

  test("予算は 3 段を畳み、書かれなかった軸は天井のまま残る", () => {
    expect(decisionFor("/a").limits).toEqual({
      maxBodyBytes: 33_554_432,
      maxDepth: 32,
      maxNodes: 50_000,
      maxSelectorExpansions: 1_000_000,
    });
    expect(decisionFor("/b").limits.maxNodes).toBe(10);
  });

  test("秘密の扱いは下の段が上の段を上書きする", () => {
    expect(decisionFor("/a").secrets.token).toBe("inject");
    expect(decisionFor("/a").secrets["*"]).toBe("mask");
  });

  test("監査はルール・スコープ・既定の順に効く", () => {
    expect(decisionFor("/a").audit).toBe("off");
    expect(decisionFor("/b").audit).toBe("always");
  });

  test("注入はヘッダー名で突き合わせ、同名はルール側を採用する", () => {
    expect(decisionFor("/a").inject).toEqual([
      { name: "Authorization", value: "secret:token" },
    ]);
    expect(decisionFor("/b").inject).toEqual([
      { name: "Authorization", value: "literal:none" },
    ]);
  });
});

describe("解決の失敗", () => {
  test("設定エラーがあるとドキュメントを作らない", () => {
    const outcome = resolveAuthzConfig({
      network: { scopes: { a: { targets: [] } } },
    });
    expect(outcome.document).toBeNull();
    expect(outcome.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("優先関係が循環する設定はドキュメントを作らない", () => {
    // 循環を宣言順で埋めて進むと、c より広い a が先に評価され、
    // POST /repos/x/y/issues が c の deny をすり抜けて a の allow で通る。
    const outcome = resolveAuthzConfig({
      network: {
        scopes: {
          github: {
            targets: ["api.github.com"],
            rules: {
              a: { match: { paths: ["/repos/**"] }, onMatch: "allow" },
              b: {
                match: {
                  methods: ["POST", "GET"],
                  paths: ["/repos/*/*/issues"],
                },
                onMatch: "allow",
                overrides: ["c"],
              },
              c: {
                match: { methods: ["POST"], paths: ["/repos/*/*/**"] },
                onMatch: "deny",
                overrides: ["b"],
              },
            },
          },
        },
      },
    });
    expect(outcome.document).toBeNull();
    expect(outcome.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  test("自分自身を overrides するルールもドキュメントを作らない", () => {
    const outcome = resolveAuthzConfig({
      network: {
        scopes: {
          api: {
            targets: ["api.example.com"],
            rules: {
              a: {
                match: { paths: ["/a"] },
                onMatch: "allow",
                overrides: ["a"],
              },
            },
          },
        },
      },
    });
    expect(outcome.document).toBeNull();
  });

  test("警告だけならドキュメントを作る", () => {
    const outcome = resolveAuthzConfig({
      network: {
        scopes: {
          api: {
            targets: ["api.example.com"],
            rules: {
              narrow: {
                match: { paths: ["/a"], body: { format: "json" } },
                onMatch: "allow",
              },
              wide: { match: { paths: ["/**"] }, onMatch: "allow" },
            },
          },
        },
      },
    });
    expect(outcome.document).not.toBeNull();
    expect(outcome.diagnostics.some((d) => d.severity === "warning")).toBe(
      true,
    );
  });
});

describe("addon に渡すドキュメント", () => {
  const document = documentOf({
    secrets: { token: { from: "env:TOKEN" } },
    network: {
      scopes: {
        api: {
          targets: ["api.example.com"],
          secrets: { token: "inject" },
          inject: [{ name: "X-Scope", value: "literal:plain-text" }],
          rules: {
            one: {
              match: { paths: ["/**"] },
              onMatch: "allow",
              inject: [
                {
                  name: "Authorization",
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: template: の ${...} は Pkl の設定値の構文であり、TS のテンプレートリテラルではない
                  value: "template:Bearer prefix-${token}",
                },
                { name: "X-Secret", value: "secret:token" },
              ],
            },
          },
        },
      },
    },
  });

  test("注入の地の文を落とし、名前と参照だけを残す", () => {
    const redacted = withoutInjectLiterals(document);
    const scope = redacted.scopes[0];
    expect(scope?.inject).toEqual([{ name: "X-Scope", value: "literal:" }]);
    expect(scope?.rules[0]?.inject).toEqual([
      { name: "X-Scope", value: "literal:" },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 参照だけを残した姿
      { name: "Authorization", value: "template:${token}" },
      { name: "X-Secret", value: "secret:token" },
    ]);
  });

  test("元のドキュメントは書き換えない", () => {
    withoutInjectLiterals(document);
    expect(document.scopes[0]?.inject).toEqual([
      { name: "X-Scope", value: "literal:plain-text" },
    ]);
  });

  test("注入以外は素通しする", () => {
    const redacted = withoutInjectLiterals(document);
    expect({ ...redacted, scopes: [] }).toEqual({ ...document, scopes: [] });
    expect(redacted.scopes[0]?.rules[0]?.match).toEqual(
      document.scopes[0]?.rules[0]?.match as never,
    );
  });
});
