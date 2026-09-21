import { describe, expect, test } from "bun:test";
import type { AuthzConfig } from "./config.ts";
import {
  anthropicExample,
  githubGraphqlExample,
  githubPathsExample,
} from "./examples_fixture.ts";
import type { GraphqlMatch } from "./types.ts";
import { detectLegacyIdentifiers, validateAuthzConfig } from "./validate.ts";

function errorsOf(config: AuthzConfig): readonly string[] {
  return validateAuthzConfig(config)
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message);
}

function warningsOf(config: AuthzConfig): readonly string[] {
  return validateAuthzConfig(config)
    .filter((diagnostic) => diagnostic.severity === "warning")
    .map((diagnostic) => diagnostic.message);
}

function joined(config: AuthzConfig): string {
  return errorsOf(config).join("\n---\n");
}

/** 1 スコープ 1 ルールの最小構成を組み立てる。 */
function oneRule(
  rule: AuthzConfig["network"]["scopes"][string]["rules"],
): AuthzConfig {
  return {
    network: {
      scopes: { api: { targets: ["api.example.com"], rules: rule } },
    },
  };
}

describe("仕様の記述例", () => {
  test("要件 1 の GraphQL スコープは設定エラーを出さない", () => {
    expect(errorsOf(githubGraphqlExample())).toEqual([]);
  });

  test("要件 2 と 3 のパスで絞るスコープは設定エラーを出さない", () => {
    expect(errorsOf(githubPathsExample())).toEqual([]);
  });

  test("要件 4 から 6 の Anthropic preset は設定エラーを出さない", () => {
    expect(errorsOf(anthropicExample())).toEqual([]);
  });
});

describe("スコープのターゲット", () => {
  test("交差してどちらも包含しない 2 つのスコープはエラーになる", () => {
    const message = joined({
      network: {
        scopes: {
          a: { targets: ["a.example.com"] },
          b: { targets: ["*.example.com:8443"] },
        },
      },
    });
    expect(message).toContain("target sets of scopes a and b intersect");
    // 証人がないと書き手はどこが重なったのか分からない。
    expect(message).toContain("a.example.com:8443");
  });

  test("包含関係にある 2 つのスコープは共存できる", () => {
    expect(
      errorsOf({
        network: {
          scopes: {
            narrow: { targets: ["a.example.com"] },
            wide: { targets: ["*.example.com"] },
          },
        },
      }),
    ).toEqual([]);
  });

  test("targets が空のスコープはエラーになる", () => {
    expect(joined({ network: { scopes: { a: { targets: [] } } } })).toContain(
      "has no targets",
    );
  });

  test("ターゲットの書き方が不正ならエラーになる", () => {
    expect(
      joined({ network: { scopes: { a: { targets: ["a.*.com"] } } } }),
    ).toContain("wildcard");
  });
});

describe("ルールの重なり", () => {
  const ambiguous: AuthzConfig = oneRule({
    "repos.read": {
      match: {
        methods: ["GET", "HEAD"],
        paths: ["/repos/{org}/{repo}/**"],
        captures: { org: ["my-org"] },
      },
      onMatch: "allow",
    },
    "repos.pulls": {
      match: { methods: ["GET"], paths: ["/repos/*/*/pulls"] },
      onMatch: "allow",
    },
  });

  test("交差してどちらも包含しない 2 つのルールはエラーになる", () => {
    const message = joined(ambiguous);
    expect(message).toContain(
      "accepted sets of rules api.repos.read and api.repos.pulls intersect",
    );
  });

  test("エラーには両方に一致する具体的なリクエストが載る", () => {
    const message = joined(ambiguous);
    expect(message).toContain("A request matching both:");
    expect(message).toContain("GET /repos/my-org/x/pulls");
  });

  test("競合する root スカラー条件の診断に証人を載せる", () => {
    const message = joined(
      oneRule({
        "exact-path": {
          match: {
            methods: ["GET", "POST"],
            paths: ["/run"],
            body: { format: "json", equals: { "": "root-value" } },
          },
          onMatch: "allow",
        },
        "exact-method": {
          match: {
            methods: ["GET"],
            paths: ["/**"],
            body: { format: "json", equals: { "": "root-value" } },
          },
          onMatch: "deny",
        },
      }),
    );

    expect(message).toContain("rules api.exact-path and api.exact-method");
    expect(message).toContain("A request matching both:");
    expect(message).toContain('body: "root-value"');
    // root を指す Pointer は空文字なので、表では (root) と書かないと値だけが浮く。
    expect(message).toContain(
      [
        '  api.exact-path    GET|POST  /run  body json (root)="root-value"',
        '  api.exact-method  GET       /**   body json (root)="root-value"',
      ].join("\n"),
    );
  });

  test("ボディ条件のないルール同士の表にはボディの列を足さない", () => {
    const message = joined(ambiguous);
    expect(message).toContain(
      [
        "  api.repos.read   GET|HEAD  /repos/{org}/{repo}/**",
        "  api.repos.pulls  GET       /repos/*/*/pulls",
        "",
        "  How to fix:",
      ].join("\n"),
    );
  });

  test("片側だけがボディ条件を持つとき、もう片側の行にはボディ条件なしと書く", () => {
    const message = joined(
      oneRule({
        mode: {
          match: {
            methods: ["GET", "POST"],
            paths: ["/run"],
            body: {
              format: "json",
              oneOf: { "/mode": ["fast", "safe"] },
              equals: { "/kind": 1 },
            },
          },
          onMatch: "allow",
        },
        any: {
          match: { methods: ["POST"], paths: ["/**"] },
          onMatch: "deny",
        },
      }),
    );
    expect(message).toContain(
      [
        '  api.mode  GET|POST  /run  body json /mode="fast"|"safe" /kind=1',
        "  api.any   POST      /**   no body condition",
      ].join("\n"),
    );
  });

  test("エラーには両方の match と 3 つの解決方法が載る", () => {
    const message = joined(ambiguous);
    expect(message).toContain("GET|HEAD");
    expect(message).toContain("/repos/{org}/{repo}/**");
    expect(message).toContain("/repos/*/*/pulls");
    expect(message).toContain('overrides { "repos.read" }');
    expect(message).toContain("Narrow one side's match");
    expect(message).toContain("Add a third rule covering the intersection");
  });

  test("overrides を書けば重なりは解決される", () => {
    expect(
      errorsOf(
        oneRule({
          "repos.read": {
            match: {
              methods: ["GET", "HEAD"],
              paths: ["/repos/{org}/{repo}/**"],
              captures: { org: ["my-org"] },
            },
            onMatch: "allow",
          },
          "repos.pulls": {
            match: { methods: ["GET"], paths: ["/repos/*/*/pulls"] },
            onMatch: "allow",
            overrides: ["repos.read"],
          },
        }),
      ),
    ).toEqual([]);
  });

  test("交差しない 2 つのルールは共存できる", () => {
    expect(
      errorsOf(
        oneRule({
          read: {
            match: { methods: ["GET"], paths: ["/a"] },
            onMatch: "allow",
          },
          write: {
            match: { methods: ["POST"], paths: ["/a"] },
            onMatch: "review",
          },
        }),
      ),
    ).toEqual([]);
  });

  test("overrides が存在しないキーを指すとエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: {
            match: { paths: ["/a"] },
            onMatch: "allow",
            overrides: ["nope"],
          },
        }),
      ),
    ).toContain("does not exist");
  });

  test("互いに overrides を書いた 2 つのルールはエラーになる", () => {
    // 向きが 2 つ立つので優先関係が循環する。見逃すと評価順が宣言順に落ち、
    // 循環に加わっていない a まで特異度を無視した位置に並ぶ。
    const message = joined({
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
    expect(message).toContain("precedence in scope github is cyclic");
    expect(message).toContain("c → b → c");
    expect(message).toContain(
      'github.b precedes github.c via overrides { "c" }',
    );
    expect(message).toContain(
      'github.c precedes github.b via overrides { "b" }',
    );
  });

  test("overrides と特異度が混ざった 3 本の輪もエラーになる", () => {
    // x → y は overrides、y → z は特異度、z → x は overrides。どの 2 本を見ても
    // 向きは 1 つしかないので、対ごとの検査だけでは見つからない。
    const message = joined(
      oneRule({
        x: {
          match: { paths: ["/a/**"] },
          onMatch: "allow",
          overrides: ["y"],
        },
        y: { match: { paths: ["/a/b/c"] }, onMatch: "allow" },
        z: {
          match: { paths: ["/a/b/**"] },
          onMatch: "allow",
          overrides: ["x"],
        },
      }),
    );
    expect(message).toContain("precedence in scope api is cyclic");
    expect(message).toContain("api.y precedes api.z by specificity");
  });

  test("自分自身を overrides するルールはエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: { match: { paths: ["/a"] }, onMatch: "allow", overrides: ["a"] },
        }),
      ),
    ).toContain("pointing at itself");
  });

  test("overrides が交差しない相手を指すとエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: {
            match: { methods: ["GET"], paths: ["/a"] },
            onMatch: "allow",
            overrides: ["b"],
          },
          b: {
            match: { methods: ["POST"], paths: ["/b"] },
            onMatch: "allow",
          },
        }),
      ),
    ).toContain("does not intersect");
  });

  test("別の Pointer を縛る値条件の重なりは比較不能としてエラーになる", () => {
    expect(
      joined(
        oneRule({
          bymode: {
            match: {
              paths: ["/run"],
              body: { format: "json", equals: { "/mode": "fast" } },
            },
            onMatch: "allow",
          },
          bytier: {
            match: {
              paths: ["/run"],
              body: { format: "json", equals: { "/tier": "pro" } },
            },
            onMatch: "deny",
          },
        }),
      ),
    ).toContain("accepted sets");
  });

  test("__proto__ Pointer は交差診断の JSON データとして提示する", () => {
    const pollutionKey = "stage3SuccessfulWitnessPollution";
    expect(Object.hasOwn(Object.prototype, pollutionKey)).toBe(false);

    try {
      const message = joined(
        oneRule({
          prototype: {
            match: {
              paths: ["/run"],
              body: {
                format: "json",
                equals: { [`/__proto__/${pollutionKey}`]: "blocked" },
              },
            },
            onMatch: "allow",
          },
          tier: {
            match: {
              paths: ["/run"],
              body: { format: "json", equals: { "/tier": "pro" } },
            },
            onMatch: "deny",
          },
        }),
      );

      expect(Object.hasOwn(Object.prototype, pollutionKey)).toBe(false);
      expect(message).toContain(
        `body: {"__proto__":{"${pollutionKey}":"blocked"},"tier":"pro"}`,
      );
    } finally {
      delete (Object.prototype as Record<string, unknown>)[pollutionKey];
    }
  });

  test("__proto__ Pointer の証人構成失敗も Object.prototype を変更しない", () => {
    const pollutionKey = "stage3FailedWitnessPollution";
    expect(Object.hasOwn(Object.prototype, pollutionKey)).toBe(false);

    try {
      const message = joined(
        oneRule({
          descendant: {
            match: {
              paths: ["/run"],
              body: {
                format: "json",
                equals: { [`/__proto__/${pollutionKey}`]: "blocked" },
              },
            },
            onMatch: "allow",
          },
          root: {
            match: {
              paths: ["/run"],
              body: { format: "json", equals: { "/__proto__": "scalar" } },
            },
            onMatch: "deny",
          },
        }),
      );

      expect(Object.hasOwn(Object.prototype, pollutionKey)).toBe(false);
      expect(message).toContain("accepted sets");
      expect(message).not.toContain("A request matching both:");
    } finally {
      delete (Object.prototype as Record<string, unknown>)[pollutionKey];
    }
  });

  test("値集合が素なルールへの overrides はエラーになる", () => {
    expect(
      joined(
        oneRule({
          fast: {
            match: {
              paths: ["/run"],
              body: { format: "json", equals: { "/mode": "fast" } },
            },
            onMatch: "allow",
            overrides: ["safe"],
          },
          safe: {
            match: {
              paths: ["/run"],
              body: { format: "json", equals: { "/mode": "safe" } },
            },
            onMatch: "deny",
          },
        }),
      ),
    ).toContain("does not intersect");
  });

  test("値条件の包含と overrides が作る優先関係の閉路はエラーになる", () => {
    const message = joined(
      oneRule({
        x: {
          match: {
            paths: ["/run"],
            body: {
              format: "json",
              oneOf: { "/mode": ["fast", "safe", "debug"] },
            },
          },
          onMatch: "allow",
          overrides: ["y"],
        },
        y: {
          match: {
            paths: ["/run"],
            body: { format: "json", equals: { "/mode": "fast" } },
          },
          onMatch: "deny",
        },
        z: {
          match: {
            paths: ["/run"],
            body: {
              format: "json",
              oneOf: { "/mode": ["fast", "safe"] },
            },
          },
          onMatch: "review",
          overrides: ["x"],
        },
      }),
    );
    expect(message).toContain("precedence in scope api is cyclic");
    expect(message).toContain("api.y precedes api.z by specificity");
  });
});

describe("GraphQL 条件の重なり", () => {
  type GraphqlCondition = NonNullable<
    NonNullable<
      NonNullable<
        AuthzConfig["network"]["scopes"][string]["rules"]
      >[string]["match"]["body"]
    >["graphql"]
  >;

  /** `POST /graphql` を分け合う 2 本のルール。違いは graphql 条件だけにある。 */
  function twoGraphqlRules(
    read: GraphqlCondition,
    other: GraphqlCondition,
    overrides?: { readonly read?: string[]; readonly other?: string[] },
  ): AuthzConfig {
    const rule = (graphql: GraphqlCondition, names?: string[]) => ({
      match: {
        methods: ["POST"],
        paths: ["/graphql"],
        body: { format: "json" as const, graphql },
      },
      onMatch: "allow" as const,
      ...(names === undefined ? {} : { overrides: names }),
    });
    return oneRule({
      read: rule(read, overrides?.read),
      other: rule(other, overrides?.other),
    });
  }

  const VIEWER = "/viewer/login";
  const REPO = "/repository/nameWithOwner";
  const ORG = "/organization/login";

  test("許可末端が交差してどちらも包含しなければエラーになり、証人に document が載る", () => {
    const message = joined(
      twoGraphqlRules(
        { operations: ["query"], fieldPaths: [REPO, VIEWER] },
        { operations: ["query"], fieldPaths: [VIEWER, ORG] },
      ),
    );
    expect(message).toContain(
      "accepted sets of rules api.read and api.other intersect",
    );
    // 共通の末端へ至る鎖を持つ document が、at の位置に置かれて現れる。
    expect(message).toContain('body: {"query":"query { viewer { login } }"}');
    expect(message).toContain('overrides { "read" }');
  });

  test("メソッドとパスが同じルールどうしでは、表の列にボディ条件の違いが載る", () => {
    const message = joined(
      twoGraphqlRules(
        {
          operations: ["query"],
          fieldPaths: [REPO, VIEWER],
          fieldArguments: { "/repository": { owner: ["my-org"] } },
        },
        { operations: ["query"], fieldPaths: [VIEWER, ORG] },
      ),
    );
    expect(message).toContain(
      'api.read   POST  /graphql  body json graphql /query operations=query fieldPaths=/repository/nameWithOwner|/viewer/login fieldArguments./repository.owner="my-org"',
    );
    expect(message).toContain(
      "api.other  POST  /graphql  body json graphql /query operations=query fieldPaths=/viewer/login|/organization/login",
    );
  });

  test("at が異なる 2 条件は交差し、どちらも包含しないので overrides が要る", () => {
    const read = {
      at: "/query",
      operations: ["query" as const],
      fieldPaths: [VIEWER],
    };
    const other = {
      at: "/doc",
      operations: ["query" as const],
      fieldPaths: [ORG],
    };

    const message = joined(twoGraphqlRules(read, other));
    expect(message).toContain(
      "accepted sets of rules api.read and api.other intersect",
    );
    // それぞれの位置に別の document を置いた 1 つのボディが両方を満たす。
    expect(message).toContain(
      'body: {"query":"query { viewer { login } }","doc":"query { organization { login } }"}',
    );

    expect(errorsOf(twoGraphqlRules(read, other, { other: ["read"] }))).toEqual(
      [],
    );
  });

  test("at が異なれば operations が素でも交差する", () => {
    const message = joined(
      twoGraphqlRules(
        { at: "/query", operations: ["query"], fieldPaths: [VIEWER] },
        { at: "/doc", operations: ["mutation"], fieldPaths: [ORG] },
      ),
    );
    expect(message).toContain(
      'body: {"query":"query { viewer { login } }","doc":"mutation { organization { login } }"}',
    );
  });

  test("引数の値集合が素でも共通末端があれば交差する", () => {
    // `/organization` の login は矛盾するが、その経路を通らない `/viewer/login`
    // なら両方を満たす。引数の矛盾だけから非交差を推測しない。
    const message = joined(
      twoGraphqlRules(
        {
          operations: ["query"],
          fieldPaths: [VIEWER, ORG],
          fieldArguments: { "/organization": { login: ["a"] } },
        },
        {
          operations: ["query"],
          fieldPaths: [VIEWER, ORG],
          fieldArguments: { "/organization": { login: ["b"] } },
        },
      ),
    );
    expect(message).toContain("accepted sets");
    expect(message).toContain('body: {"query":"query { viewer { login } }"}');
  });

  test("証人を作れない交差では、例を省いたエラーになる", () => {
    // 共通末端が矛盾する引数を必ず通る組。交差の否定ではないので、エラー自体は
    // 出したうえで例だけを落とす。
    const message = joined(
      twoGraphqlRules(
        {
          operations: ["query"],
          fieldPaths: [ORG],
          fieldArguments: { "/organization": { login: ["a"] } },
        },
        {
          operations: ["query"],
          fieldPaths: [ORG],
          fieldArguments: { "/organization": { login: ["b"] } },
        },
      ),
    );
    expect(message).toContain("accepted sets");
    expect(message).not.toContain("A request matching both:");
  });

  test("包含関係にある graphql 条件は overrides なしで共存できる", () => {
    for (const [narrow, wide] of [
      [
        { operations: ["query"], fieldPaths: [VIEWER] },
        { operations: ["query", "mutation"], fieldPaths: [VIEWER] },
      ],
      [
        { operations: ["query"], fieldPaths: [VIEWER] },
        { operations: ["query"], fieldPaths: [VIEWER, REPO] },
      ],
      [
        {
          operations: ["query"],
          fieldPaths: [REPO],
          fieldArguments: { "/repository": { owner: ["my-org"] } },
        },
        {
          operations: ["query"],
          fieldPaths: [REPO],
          fieldArguments: { "/repository": { owner: ["my-org", "other"] } },
        },
      ],
      [
        {
          operations: ["query"],
          fieldPaths: [REPO],
          fieldArguments: { "/repository": { owner: ["my-org"] } },
        },
        { operations: ["query"], fieldPaths: [REPO] },
      ],
    ] as const satisfies readonly (readonly [
      GraphqlCondition,
      GraphqlCondition,
    ])[]) {
      expect(errorsOf(twoGraphqlRules(narrow, wide))).toEqual([]);
    }
  });

  test("graphql 条件を持つルールは、同じ位置の format だけのルールに包含される", () => {
    expect(
      errorsOf(
        oneRule({
          read: {
            match: {
              methods: ["POST"],
              paths: ["/graphql"],
              body: {
                format: "json",
                graphql: { operations: ["query"], fieldPaths: [VIEWER] },
              },
            },
            onMatch: "allow",
          },
          any: {
            match: {
              methods: ["POST"],
              paths: ["/graphql"],
              body: { format: "json" },
            },
            onMatch: "review",
          },
        }),
      ),
    ).toEqual([]);
  });

  test("operations が素な 2 条件は交差しないので、overrides を書くとエラーになる", () => {
    const read = { operations: ["query" as const], fieldPaths: [VIEWER] };
    const write = { operations: ["mutation" as const], fieldPaths: [VIEWER] };
    expect(errorsOf(twoGraphqlRules(read, write))).toEqual([]);
    expect(joined(twoGraphqlRules(read, write, { read: ["other"] }))).toContain(
      "does not intersect",
    );
  });

  test("許可末端が素な 2 条件は交差しない", () => {
    expect(
      errorsOf(
        twoGraphqlRules(
          { operations: ["query"], fieldPaths: [VIEWER] },
          { operations: ["query"], fieldPaths: [REPO] },
        ),
      ),
    ).toEqual([]);
    // 接頭辞を共有していても末端が違えば交差しない。
    expect(
      errorsOf(
        twoGraphqlRules(
          { operations: ["query"], fieldPaths: ["/repository/url"] },
          { operations: ["query"], fieldPaths: [REPO] },
        ),
      ),
    ).toEqual([]);
  });
});

describe("実 ID の一意性", () => {
  /**
   * キー構文は `.` を許すので、`<スコープ名>.<キー>` の連結は一意に戻せない。
   * スコープ github のルール api.read と、スコープ github.api のルール read は、
   * どちらも実 ID github.api.read になる。
   */
  const colliding: AuthzConfig = {
    network: {
      scopes: {
        github: {
          targets: ["api.github.com:443"],
          rules: {
            "api.read": {
              match: { methods: ["GET"], paths: ["/**"] },
              onMatch: "review",
            },
          },
        },
        "github.api": {
          targets: ["internal.example.com:443"],
          rules: {
            read: {
              match: { methods: ["GET"], paths: ["/**"] },
              onMatch: "review",
            },
          },
        },
      },
    },
  };

  test("2 つの宣言が同じ実 ID を作る設定はエラーになる", () => {
    expect(joined(colliding)).toContain("effective id github.api.read");
  });

  test("エラーは衝突した両方の宣言を名指しする", () => {
    const message = joined(colliding);
    expect(message).toContain("scope github ");
    expect(message).toContain('rule "api.read"');
    expect(message).toContain("scope github.api ");
    expect(message).toContain('rule "read"');
  });

  test("実 ID が重ならなければキーに `.` があっても共存できる", () => {
    expect(
      errorsOf({
        network: {
          scopes: {
            github: {
              targets: ["api.github.com:443"],
              rules: {
                "api.read": {
                  match: { methods: ["GET"], paths: ["/**"] },
                  onMatch: "review",
                },
              },
            },
            "github.gql": {
              targets: ["internal.example.com:443"],
              rules: {
                read: {
                  match: { methods: ["GET"], paths: ["/**"] },
                  onMatch: "review",
                },
              },
            },
          },
        },
      }),
    ).toEqual([]);
  });
});

describe("match の構文", () => {
  test("ルールのキーが構文に反するとエラーになる", () => {
    expect(
      joined(
        oneRule({ Bad_Key: { match: { paths: ["/a"] }, onMatch: "allow" } }),
      ),
    ).toContain("rule key");
  });

  test("** が末尾以外に現れるとエラーになる", () => {
    expect(
      joined(
        oneRule({ a: { match: { paths: ["/a/**/b"] }, onMatch: "allow" } }),
      ),
    ).toContain("last segment");
  });

  test("capture 名が同一パターン内で重複するとエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: { match: { paths: ["/{n}/{n}"] }, onMatch: "allow" },
        }),
      ),
    ).toContain("duplicate");
  });

  test("どのパスパターンにも現れない capture を制約するとエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: {
            match: { paths: ["/repos/{org}"], captures: { repo: ["x"] } },
            onMatch: "allow",
          },
        }),
      ),
    ).toContain("repo");
  });

  test("captures の制約が空の Listing だとエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: {
            match: { paths: ["/repos/{org}"], captures: { org: [] } },
            onMatch: "allow",
          },
        }),
      ).replaceAll("\n", " "),
    ).toMatch(/empty Listing.*accepted set/s);
  });

  for (const format of ["opaque", "none"] as const) {
    test(`${format} に equals を併記するとエラーになる`, () => {
      expect(
        joined(
          oneRule({
            a: {
              match: {
                paths: ["/a"],
                body: { format, equals: { "/mode": "fast" } },
              },
              onMatch: "allow",
            },
          }),
        ),
      ).toContain(`format = "${format}" with equals`);
    });

    test(`${format} に oneOf を併記するとエラーになる`, () => {
      expect(
        joined(
          oneRule({
            a: {
              match: {
                paths: ["/a"],
                body: { format, oneOf: { "/mode": ["fast", "safe"] } },
              },
              onMatch: "allow",
            },
          }),
        ),
      ).toContain(`format = "${format}" with oneOf`);
    });

    test(`${format} に graphql を併記するとエラーになる`, () => {
      expect(
        joined(
          oneRule({
            a: {
              match: {
                paths: ["/a"],
                body: {
                  format,
                  graphql: {
                    operations: ["query"],
                    fieldPaths: ["/viewer/login"],
                  },
                },
              },
              onMatch: "allow",
            },
          }),
        ),
      ).toContain(`format = "${format}" with graphql`);
    });
  }

  test("match の graphql は expect と同じく空の Listing を拒否する", () => {
    const message = joined(
      oneRule({
        a: {
          match: {
            paths: ["/a"],
            body: {
              format: "json",
              graphql: {
                operations: [],
                fieldPaths: [],
                fieldArguments: { "/repository": { owner: [] } },
              },
            },
          },
          onMatch: "allow",
        },
      }),
    );
    expect(message).toContain(
      "match.body.graphql.operations is an empty Listing",
    );
    expect(message).toContain(
      "match.body.graphql.fieldPaths is an empty Listing",
    );
    expect(message).toContain(
      "match.body.graphql.fieldArguments /repository owner is an empty Listing",
    );
    expect(message).toContain("this rule never fires");
  });

  test("graphql の fieldPaths は必須である", () => {
    // 経路を制約しない GraphQL 条件は提供しない。省略を「制約なし」に倒すと、
    // root しか見ていなかった旧条件と同じ横断を自動許可してしまう。
    for (const fieldPaths of [undefined, null]) {
      const message = joined(
        oneRule({
          a: {
            match: {
              paths: ["/a"],
              body: {
                format: "json",
                graphql: {
                  operations: ["query"],
                  fieldPaths,
                } as unknown as GraphqlMatch,
              },
            },
            onMatch: "allow",
          },
        }),
      );
      expect(message).toContain("match.body.graphql.fieldPaths is missing");
    }
  });

  test("旧 rootFields / 全域 arguments は未知のキーとして拒否する", () => {
    // 黙って無視すると制約が落ちる。自動変換もしない。旧 rootFields が許して
    // いた「その root の下の任意の取得」は経路の集合に書き直せない。
    const message = joined(
      oneRule({
        a: {
          match: {
            paths: ["/a"],
            body: {
              format: "json",
              graphql: {
                operations: ["query"],
                fieldPaths: ["/viewer/login"],
                rootFields: ["viewer"],
                arguments: { owner: ["my-org"] },
              } as unknown as GraphqlMatch,
            },
          },
          onMatch: "allow",
        },
      }),
    );
    expect(message).toContain(
      'match.body.graphql has an unknown key "rootFields"',
    );
    expect(message).toContain(
      'match.body.graphql has an unknown key "arguments"',
    );
    expect(message).toContain(
      "Allowed keys: at, operations, fieldPaths, fieldArguments",
    );
  });

  test("fieldPaths の文法に反する経路を拒否する", () => {
    for (const path of [
      "/repository/**",
      "/repository/*",
      "/repository/",
      "/repository//body",
      "/repository~1issues",
      "repository",
      "/",
      "",
      "/repository/0",
    ]) {
      const message = joined(
        oneRule({
          a: {
            match: {
              paths: ["/a"],
              body: {
                format: "json",
                graphql: { operations: ["query"], fieldPaths: [path] },
              },
            },
            onMatch: "allow",
          },
        }),
      );
      expect([
        path,
        message.includes(
          `match.body.graphql.fieldPaths entry ${JSON.stringify(path)} is not a GraphQL selection path`,
        ),
      ]).toEqual([path, true]);
    }
  });

  test("fieldArguments のキーは許可末端かその途中でなければならない", () => {
    const message = joined(
      oneRule({
        a: {
          match: {
            paths: ["/a"],
            body: {
              format: "json",
              graphql: {
                operations: ["query"],
                fieldPaths: ["/repository/issues/nodes/body"],
                fieldArguments: {
                  // 許可末端の下。この経路の field は現れ得ない。
                  "/repository/issues/nodes/body/text": { owner: ["x"] },
                  // 別の root。
                  "/organization": { login: ["x"] },
                  // 文法に反するキー。
                  "/repository/**": { owner: ["x"] },
                  // 空の Mapping。
                  "/repository/issues": {},
                  // 引数名が GraphQL の名前でない。
                  "/repository": { "owner ": ["x"] },
                },
              },
            },
          },
          onMatch: "allow",
        },
      }),
    );
    for (const key of [
      '"/repository/issues/nodes/body/text" is neither a leaf nor a prefix of any fieldPaths entry',
      '"/organization" is neither a leaf nor a prefix of any fieldPaths entry',
      'key "/repository/**" is not a GraphQL selection path',
      "/repository/issues is an empty Mapping",
      'key "owner " is not a GraphQL name',
    ]) {
      expect(message).toContain(key);
    }
  });

  test("許可末端そのものも途中の経路も fieldArguments のキーにできる", () => {
    expect(
      errorsOf(
        oneRule({
          a: {
            match: {
              paths: ["/a"],
              body: {
                format: "json",
                graphql: {
                  operations: ["query"],
                  fieldPaths: ["/repository/issues/nodes/body"],
                  fieldArguments: {
                    "/repository": { owner: ["my-org"] },
                    "/repository/issues": { first: ["10"] },
                    "/repository/issues/nodes/body": { _x9: ["y"] },
                  },
                },
              },
            },
            onMatch: "allow",
          },
        }),
      ),
    ).toEqual([]);
  });

  test("graphql の at は JSON Pointer でなければならない", () => {
    const message = joined(
      oneRule({
        a: {
          match: {
            paths: ["/a"],
            body: {
              format: "json",
              graphql: {
                at: "query",
                operations: ["query"],
                fieldPaths: ["/viewer/login"],
              },
            },
          },
          onMatch: "allow",
          expect: [
            {
              kind: "body",
              graphql: {
                at: "/bad~2",
                operations: ["query"],
                fieldPaths: ["/viewer/login"],
              },
            },
          ],
        },
      }),
    );
    expect(message).toContain("match.body.graphql.at query");
    expect(message).toContain("expect[0] graphql.at /bad~2");
  });

  const invalidBodyValues: readonly (readonly [string, unknown])[] = [
    ["配列", ["fast"]],
    ["オブジェクト", { mode: "fast" }],
    ["null", null],
    ["NaN", Number.NaN],
    ["正の無限大", Number.POSITIVE_INFINITY],
    ["負の無限大", Number.NEGATIVE_INFINITY],
  ];

  for (const [label, value] of invalidBodyValues) {
    test(`equals の ${label} を拒否する`, () => {
      const equals = { "/value": value } as unknown as Record<string, string>;
      const message = joined(
        oneRule({
          a: {
            match: {
              paths: ["/a"],
              body: { format: "json", equals },
            },
            onMatch: "allow",
          },
        }),
      );
      expect(message).toContain("equals /value");
      expect(message).toContain("a string, a finite number, or a boolean");
    });

    test(`oneOf の ${label} を拒否する`, () => {
      const oneOf = { "/value": [value] } as unknown as Record<
        string,
        readonly string[]
      >;
      const message = joined(
        oneRule({
          a: {
            match: {
              paths: ["/a"],
              body: { format: "json", oneOf },
            },
            onMatch: "allow",
          },
        }),
      );
      expect(message).toContain("oneOf /value");
      expect(message).toContain("strings, finite numbers, or booleans");
    });
  }

  for (const [label, pointer] of [
    ["先頭の slash がない", "mode"],
    ["不正な escape を持つ", "/bad~2escape"],
    ["末尾が単独の ~ である", "/bad~"],
  ] as const) {
    test(`equals の ${label} Pointer を拒否する`, () => {
      const message = joined(
        oneRule({
          a: {
            match: {
              paths: ["/a"],
              body: {
                format: "json",
                equals: { [pointer]: "fast" },
              },
            },
            onMatch: "allow",
          },
        }),
      );
      expect(message).toContain(`equals ${pointer}`);
      expect(message).toContain("RFC 6901 JSON Pointer");
    });

    test(`oneOf の ${label} Pointer を拒否する`, () => {
      const message = joined(
        oneRule({
          a: {
            match: {
              paths: ["/a"],
              body: {
                format: "json",
                oneOf: { [pointer]: ["fast"] },
              },
            },
            onMatch: "allow",
          },
        }),
      );
      expect(message).toContain(`oneOf ${pointer}`);
      expect(message).toContain("RFC 6901 JSON Pointer");
    });
  }

  test("root と escape 済みの JSON Pointer は受理する", () => {
    expect(
      errorsOf(
        oneRule({
          a: {
            match: {
              paths: ["/a"],
              body: {
                format: "json",
                equals: { "": "root" },
                oneOf: { "/a~0b~1c": [true, 1, "x"] },
              },
            },
            onMatch: "allow",
          },
        }),
      ),
    ).toEqual([]);
  });

  test("oneOf の値集合が空だとエラーになる", () => {
    const message = joined(
      oneRule({
        a: {
          match: {
            paths: ["/a"],
            body: { format: "json", oneOf: { "/mode": [] } },
          },
          onMatch: "allow",
        },
      }),
    );
    expect(message).toContain("oneOf /mode is an empty Listing");
    expect(message).toContain("this rule never fires");
  });
});

describe("受理条件", () => {
  test("format が json でないルールに JsonRoot を置くとエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: {
            match: { paths: ["/a"] },
            onMatch: "allow",
            expect: [{ kind: "jsonRoot", rootType: "object" }],
          },
        }),
      ),
    ).toContain('format = "json"');
  });

  test("EmptyBody は format を要求しない", () => {
    expect(
      errorsOf(
        oneRule({
          a: {
            match: { paths: ["/a"] },
            onMatch: "allow",
            expect: [{ kind: "emptyBody" }],
          },
        }),
      ),
    ).toEqual([]);
  });

  test("onViolation = allow を持つルールの audit が always でないとエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: {
            match: { paths: ["/a"], body: { format: "json" } },
            onMatch: "allow",
            audit: "off",
            expect: [
              { kind: "jsonRoot", rootType: "object", onViolation: "allow" },
            ],
          },
        }),
      ),
    ).toContain('audit = "always"');
  });

  test("audit = always なら onViolation = allow を書ける", () => {
    expect(
      errorsOf(
        oneRule({
          a: {
            match: { paths: ["/a"], body: { format: "json" } },
            onMatch: "allow",
            audit: "always",
            expect: [
              { kind: "jsonRoot", rootType: "object", onViolation: "allow" },
            ],
          },
        }),
      ),
    ).toEqual([]);
  });

  test("audit はスコープから継承する", () => {
    expect(
      errorsOf({
        network: {
          scopes: {
            api: {
              targets: ["api.example.com"],
              audit: "always",
              rules: {
                a: {
                  match: { paths: ["/a"], body: { format: "json" } },
                  onMatch: "allow",
                  expect: [
                    {
                      kind: "jsonRoot",
                      rootType: "object",
                      onViolation: "allow",
                    },
                  ],
                },
              },
            },
          },
        },
      }),
    ).toEqual([]);
  });

  test("BodyExpect の oneOf の値集合が空だとエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: {
            match: { paths: ["/a"], body: { format: "json" } },
            onMatch: "allow",
            expect: [{ kind: "body", oneOf: { "/kind": [] } }],
          },
        }),
      ),
    ).toContain("/kind");
  });

  // addon は解決済みドキュメントを同じ形で検証し直し、読めない条件があると
  // ドキュメント全体を拒否する。ここで止めないと最初のリクエストが 403 になる。
  test("BodyExpect の equals / oneOf は match と同じ形の検査を受ける", () => {
    const message = joined(
      oneRule({
        a: {
          match: { paths: ["/a"], body: { format: "json" } },
          onMatch: "allow",
          expect: [
            {
              kind: "body",
              equals: { mode: "fast" },
              oneOf: {
                "/tier": [{ nested: true }] as unknown as readonly string[],
              },
            },
          ],
        },
      }),
    );
    expect(message).toContain("expect[0] equals mode");
    expect(message).toContain("RFC 6901");
    expect(message).toContain(
      "expect[0] oneOf /tier may only contain strings, finite numbers, or booleans",
    );
  });

  // 違反レコードの値は Pointer を切らずに含むので、Pointer が長いと broker が違反レコードを
  // 受け取れず、そのリクエストは承認できない。
  for (const field of ["equals", "oneOf"] as const) {
    const bodyExpect = (pointer: string) =>
      oneRule({
        a: {
          match: { paths: ["/a"], body: { format: "json" } },
          onMatch: "allow",
          expect: [
            field === "equals"
              ? { kind: "body", equals: { [pointer]: "x" } }
              : { kind: "body", oneOf: { [pointer]: ["x"] } },
          ],
        },
      });

    test(`BodyExpect の ${field} の Pointer は 257 文字だとエラーになる`, () => {
      expect(joined(bodyExpect(`/${"p".repeat(256)}`))).toContain(
        `rule api.a expect[0] ${field} Pointer /${"p".repeat(31)}… is 257 characters, over the 256-character limit.`,
      );
    });

    test(`BodyExpect の ${field} の Pointer は 256 文字なら受け付ける`, () => {
      expect(errorsOf(bodyExpect(`/${"p".repeat(255)}`))).toEqual([]);
    });
  }

  test("match.body の Pointer には長さの上限を課さない", () => {
    expect(
      errorsOf(
        oneRule({
          a: {
            match: {
              paths: ["/a"],
              body: {
                format: "json",
                equals: { [`/${"p".repeat(300)}`]: "x" },
              },
            },
            onMatch: "allow",
          },
        }),
      ),
    ).toEqual([]);
  });

  test("graphql の operations が空だとエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: {
            match: { paths: ["/a"], body: { format: "json" } },
            onMatch: "allow",
            expect: [
              {
                kind: "body",
                graphql: { operations: [], fieldPaths: ["/viewer/login"] },
              },
            ],
          },
        }),
      ),
    ).toContain("operations");
  });

  test("graphql の fieldArguments のエントリが空だとエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: {
            match: { paths: ["/a"], body: { format: "json" } },
            onMatch: "allow",
            expect: [
              {
                kind: "body",
                graphql: {
                  operations: ["query"],
                  fieldPaths: ["/organization/login"],
                  fieldArguments: { "/organization": { login: [] } },
                },
              },
            ],
          },
        }),
      ),
    ).toContain("expect[0] graphql.fieldArguments /organization login");
  });

  test("UnionShape の allowed が空だとエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: {
            match: { paths: ["/a"], body: { format: "json" } },
            onMatch: "allow",
            expect: [
              {
                kind: "unionShape",
                at: "/**/content/*",
                discriminator: "type",
                allowed: [],
              },
            ],
          },
        }),
      ),
    ).toContain("allowed");
  });
});

describe("秘密と注入", () => {
  function withSecret(
    config: Partial<AuthzConfig> & Pick<AuthzConfig, "network">,
  ): AuthzConfig {
    return {
      secrets: { "gh-token": { from: "cmd:gh auth token" } },
      ...config,
    };
  }

  test("扱いが inject でない秘密を注入するとエラーになる", () => {
    expect(
      joined(
        withSecret({
          network: {
            scopes: {
              github: {
                targets: ["api.github.com"],
                inject: [{ name: "Authorization", value: "secret:gh-token" }],
              },
            },
          },
        }),
      ),
    ).toContain("inject");
  });

  test("スキームを取り違えた inject の値は診断に現れない", () => {
    // 旧 CredentialRule.value は素の文字列を取ったので、literal: を書き忘れる
    // 移行が起こりうる。そのとき値は資格情報そのものであり、起動時のエラーと
    // その行き先のログに丸ごと乗ってはならない。
    const message = joined(
      withSecret({
        network: {
          scopes: {
            github: {
              targets: ["api.github.com"],
              inject: [
                { name: "Authorization", value: "Bearer ghp-not-a-real-token" },
              ],
            },
          },
        },
      }),
    );
    expect(message).not.toContain("ghp-not-a-real-token");
    expect(message).not.toContain("Bearer");
    // 場所と直し方は残す。
    expect(message).toContain("Authorization");
    expect(message).toContain("literal:");
    expect(message).toContain("secret:");
    expect(message).toContain("template:");
  });

  test("スコープが inject を宣言していれば注入できる", () => {
    expect(
      errorsOf(
        withSecret({
          network: {
            scopes: {
              github: {
                targets: ["api.github.com"],
                secrets: { "gh-token": "inject" },
                inject: [{ name: "Authorization", value: "secret:gh-token" }],
              },
            },
          },
        }),
      ),
    ).toEqual([]);
  });

  test("ルールが扱いを mask に戻した場合、そのルールの注入はエラーになる", () => {
    expect(
      joined(
        withSecret({
          network: {
            scopes: {
              github: {
                targets: ["api.github.com"],
                secrets: { "gh-token": "inject" },
                inject: [{ name: "Authorization", value: "secret:gh-token" }],
                rules: {
                  a: {
                    match: { paths: ["/a"] },
                    onMatch: "allow",
                    secrets: { "gh-token": "mask" },
                  },
                },
              },
            },
          },
        }),
      ),
    ).toContain("github.a");
  });

  test("複数の値に展開される秘密を注入するとエラーになる", () => {
    expect(
      joined({
        secrets: { lines: { from: "lines:/etc/tokens" } },
        network: {
          scopes: {
            a: {
              targets: ["a.example.com"],
              secrets: { lines: "inject" },
              inject: [{ name: "X-Token", value: "secret:lines" }],
            },
          },
        },
      }),
    ).toContain("multiple values");
  });

  test("template が存在しない名前を指すとエラーになる", () => {
    expect(
      joined(
        withSecret({
          network: {
            scopes: {
              github: {
                targets: ["api.github.com"],
                secrets: { "gh-token": "inject" },
                inject: [
                  {
                    name: "Authorization",
                    // biome-ignore lint/suspicious/noTemplateCurlyInString: template: の ${...} は Pkl の設定値の構文であり、TS のテンプレートリテラルではない
                    value: "template:Bearer ${nope}",
                  },
                ],
              },
            },
          },
        }),
      ),
    ).toContain("nope");
  });

  test("注入する値のスキームが未知だとエラーになる", () => {
    expect(
      joined(
        withSecret({
          network: {
            scopes: {
              github: {
                targets: ["api.github.com"],
                inject: [{ name: "X", value: "cmd:gh auth token" }],
              },
            },
          },
        }),
      ),
    ).toContain("literal:");
  });

  test("mask を持つスコープがある設定で mask.proxy = false はエラーになる", () => {
    expect(
      joined({
        mask: { proxy: false },
        network: { scopes: { a: { targets: ["a.example.com"] } } },
      }),
    ).toContain("mask.proxy");
  });

  test("既定の扱いを ignore にすれば mask.proxy = false を選べる", () => {
    expect(
      errorsOf({
        mask: { proxy: false },
        network: {
          defaults: { secrets: { "*": "ignore" } },
          scopes: { a: { targets: ["a.example.com"] } },
        },
      }),
    ).toEqual([]);
  });
});

describe("予算", () => {
  test("天井を上回る limits はエラーになる", () => {
    expect(
      joined(
        oneRule({
          a: {
            match: { paths: ["/a"] },
            onMatch: "allow",
            limits: { maxNodes: 200_001 },
          },
        }),
      ),
    ).toContain("maxNodes");
  });

  test("天井を下回る limits は通る", () => {
    expect(
      errorsOf(
        oneRule({
          a: {
            match: { paths: ["/a"] },
            onMatch: "allow",
            limits: { maxNodes: 1000 },
          },
        }),
      ),
    ).toEqual([]);
  });

  test("スコープが狭めた予算を、ルールが広げ返すことはできない", () => {
    expect(
      joined({
        network: {
          fallback: "deny",
          scopes: {
            s: {
              targets: ["a.example.com"],
              limits: { maxNodes: 1000 },
              rules: {
                a: {
                  match: { paths: ["/a"] },
                  onMatch: "allow",
                  limits: { maxNodes: 5000 },
                },
              },
            },
          },
        },
      }),
    ).toContain("the inherited ceiling of 1000");
  });

  test("defaults が狭めた予算を、スコープが広げ返すことはできない", () => {
    expect(
      joined({
        network: {
          fallback: "deny",
          defaults: { limits: { maxDepth: 8 } },
          scopes: {
            s: { targets: ["a.example.com"], limits: { maxDepth: 32 } },
          },
        },
      }),
    ).toContain("the inherited ceiling of 8");
  });

  test("スコープが狭めた範囲の内側なら、ルールはさらに狭められる", () => {
    expect(
      errorsOf({
        network: {
          fallback: "deny",
          scopes: {
            s: {
              targets: ["a.example.com"],
              limits: { maxNodes: 1000 },
              rules: {
                a: {
                  match: { paths: ["/a"] },
                  onMatch: "allow",
                  limits: { maxNodes: 500 },
                },
              },
            },
          },
        },
      }),
    ).toEqual([]);
  });
});

describe("設定の警告", () => {
  test("ボディ条件つきのルールが同一スコープの広い無条件 allow に覆われていると警告する", () => {
    const warnings = warningsOf(
      oneRule({
        "gql.read": {
          match: {
            methods: ["POST"],
            paths: ["/graphql"],
            body: { format: "json" },
          },
          onMatch: "allow",
        },
        "api.all": {
          match: { methods: ["POST"], paths: ["/**"] },
          onMatch: "allow",
        },
      }),
    );
    expect(warnings.join("\n")).toContain("api.gql.read");
    expect(warnings.join("\n")).toContain("expect");
  });

  test("graphql 条件を match に置いたルールも、広い無条件 allow に覆われていると警告する", () => {
    const warnings = warningsOf(
      oneRule({
        "gql.read": {
          match: {
            methods: ["POST"],
            paths: ["/graphql"],
            body: {
              format: "json",
              graphql: {
                operations: ["query"],
                fieldPaths: ["/viewer/login"],
              },
            },
          },
          onMatch: "allow",
        },
        "api.all": {
          match: { methods: ["POST"], paths: ["/**"] },
          onMatch: "allow",
        },
      }),
    ).join("\n");
    expect(warnings).toContain(
      "the body condition of rule api.gql.read is covered by the broader unconditional allow rule api.api.all",
    );
    expect(warnings).toContain("put the condition on expect, not match");
  });

  test("overrides の総数がルール数を超えると警告する", () => {
    // 4 本のルールに 6 本の overrides。特異度による選択が手書きの優先順位に
    // 退化しかけている。
    const warnings = warningsOf(
      oneRule({
        a: { match: { paths: ["/a/**"] }, onMatch: "allow" },
        b: {
          match: { paths: ["/a/*/**"] },
          onMatch: "allow",
          overrides: ["a"],
        },
        c: {
          match: { paths: ["/a/b/**"] },
          onMatch: "allow",
          overrides: ["a", "b"],
        },
        d: {
          match: { paths: ["/a/b/c"] },
          onMatch: "allow",
          overrides: ["a", "b", "c"],
        },
      }),
    );
    expect(warnings.join("\n")).toContain("overrides");
  });

  test("重なりのない設定は警告を出さない", () => {
    expect(warningsOf(anthropicExample())).toEqual([]);
  });

  test("既知の HTTP メソッドでない綴りを警告する", () => {
    const warnings = warningsOf(
      oneRule({
        typo: { match: { methods: ["PSOT"], paths: ["/**"] }, onMatch: "deny" },
      }),
    );
    expect(warnings.join("\n")).toContain("PSOT");
  });

  test("小文字で書いたメソッドは警告しない", () => {
    // 綴りの大小は畳むので、これは書き間違いではない。
    expect(
      warningsOf(
        oneRule({
          post: {
            match: { methods: ["post"], paths: ["/**"] },
            onMatch: "deny",
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe("旧識別子の検出", () => {
  test("廃止した識別子を見つけたら行番号と移行先を名指しする", () => {
    const source = ["network {", "  reviewRules {", "  }", "}"].join("\n");
    const [diagnostic, ...rest] = detectLegacyIdentifiers(
      source,
      ".nas/config.pkl",
    );
    expect(rest).toEqual([]);
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain(".nas/config.pkl:2");
    expect(diagnostic?.message).toContain("reviewRules");
    // Pkl の Unresolved reference では移行先が分からないのでこれが要る。
    expect(diagnostic?.message).toContain("network.scopes");
  });

  test("12 個の廃止識別子をすべて名指しする", () => {
    const migrationGuideUrl =
      "https://github.com/Hogeyama/nix-agent-sandbox/blob/main/docs/migration/network-scopes.md#legacy-identifier-mapping";
    const removed = [
      "reviewRules",
      "ReviewRule",
      "credentials",
      "CredentialRule",
      "CredentialValSpec",
      "BodylessRequestPolicy",
      "JsonRequestPolicy",
      "TaggedUnionGuard",
      "anthropicV1",
      "anthropicJsonPolicy",
      "MaskValueConfig",
      "pendingDefaultScope",
    ];
    for (const identifier of removed) {
      const found = detectLegacyIdentifiers(`x = ${identifier}`, "c.pkl");
      expect(found.map((diagnostic) => diagnostic.severity)).toEqual(["error"]);
      expect(found[0]?.message).toContain(identifier);
      expect(found[0]?.message).toContain(migrationGuideUrl);
      expect(found[0]?.message).not.toContain("docs/superpowers/");
    }
  });

  test("識別子の一部として現れる名前は拾わない", () => {
    expect(
      detectLegacyIdentifiers(
        "myReviewRules = 1\nreviewRulesExtra = 2",
        "c.pkl",
      ),
    ).toEqual([]);
  });

  test("コメントの中の旧識別子は拾わない", () => {
    expect(
      detectLegacyIdentifiers("// 旧 reviewRules から移行した", "c.pkl"),
    ).toEqual([]);
  });

  test("文字列リテラルの中の旧識別子は拾わない", () => {
    // 廃止したのは識別子であって語ではない。パスやホスト名にたまたま同じ綴りが
    // 現れる設定を、起動できなくする理由がない。
    expect(
      detectLegacyIdentifiers('paths { "/v1/credentials" }', "c.pkl"),
    ).toEqual([]);
    expect(
      detectLegacyIdentifiers('targets { "credentials.example.com" }', "c.pkl"),
    ).toEqual([]);
    expect(
      detectLegacyIdentifiers('x = "移行前は reviewRules だった"', "c.pkl"),
    ).toEqual([]);
  });

  test("引用符を含む文字列でも中身は拾わず、閉じたあとは拾う", () => {
    expect(detectLegacyIdentifiers('x = "a \\" credentials"', "c.pkl")).toEqual(
      [],
    );
    const found = detectLegacyIdentifiers(
      'x = "a \\" b"\ny = reviewRules',
      "c.pkl",
    );
    expect(found.map((diagnostic) => diagnostic.severity)).toEqual(["error"]);
    expect(found[0]?.message).toContain("c.pkl:2");
  });

  test("複数行文字列の中の旧識別子は拾わない", () => {
    const source = [
      'note = """',
      "  旧 reviewRules は network.scopes になった",
      '  "credentials" も廃止した',
      '  """',
      "x = 1",
    ].join("\n");
    expect(detectLegacyIdentifiers(source, "c.pkl")).toEqual([]);
  });

  test("ブロックコメントの中の旧識別子は拾わない", () => {
    expect(
      detectLegacyIdentifiers(
        "/* 旧 reviewRules\n   から移行 */\nx = 1",
        "c.pkl",
      ),
    ).toEqual([]);
  });

  test("ポンド記号つきの文字列も中身を拾わない", () => {
    expect(detectLegacyIdentifiers('x = #"credentials"#', "c.pkl")).toEqual([]);
    // ポンドつきの文字列では素の `"` は閉じ記号ではない。
    expect(
      detectLegacyIdentifiers('x = #"a " credentials"#\ny = 1', "c.pkl"),
    ).toEqual([]);
    const found = detectLegacyIdentifiers(
      'x = #"a"#\ny = credentials',
      "c.pkl",
    );
    expect(found.map((diagnostic) => diagnostic.severity)).toEqual(["error"]);
    expect(found[0]?.message).toContain("c.pkl:2");
  });

  test("文字列補間の中は参照なので拾う", () => {
    const found = detectLegacyIdentifiers('x = "\\(reviewRules)"', "c.pkl");
    expect(found.map((diagnostic) => diagnostic.severity)).toEqual(["error"]);
  });

  test("閉じていない引用符は行末で切れ、次の行の参照を隠さない", () => {
    const found = detectLegacyIdentifiers(
      'x = "unterminated\ny = credentials',
      "c.pkl",
    );
    expect(found.map((diagnostic) => diagnostic.severity)).toEqual(["error"]);
    expect(found[0]?.message).toContain("c.pkl:2");
  });

  test("新しい設定は何も報告しない", () => {
    const source = [
      "network {",
      '  scopes { ["github"] { targets { "api.github.com" } } }',
      "}",
    ].join("\n");
    expect(detectLegacyIdentifiers(source, "c.pkl")).toEqual([]);
  });
});

describe("同一ホストの分割", () => {
  test("ターゲット集合が等しい 2 つのスコープはエラーになる", () => {
    // 同一ホストを 2 つのスコープに割ると、リクエストが属するスコープが
    // 1 つに定まらない。
    expect(
      joined({
        network: {
          scopes: {
            read: { targets: ["api.example.com"] },
            write: { targets: ["api.example.com"] },
          },
        },
      }),
    ).toContain("scopes read and write have identical target sets");
  });
});

describe("秘密の扱いの既定", () => {
  test("defaults.secrets は既定の Mapping を amend する", () => {
    // ["*"] を書かずに個別の名前だけを足した設定でも、既定の "mask" は残る。
    // Pkl の Mapping は既定値を amend するので、そこと同じ意味にする。
    expect(
      joined({
        mask: { proxy: false },
        secrets: { token: { from: "env:TOKEN" } },
        network: {
          defaults: { secrets: { token: "ignore" } },
          scopes: { a: { targets: ["a.example.com"] } },
        },
      }),
    ).toContain("mask.proxy");
  });
});
