import { describe, expect, test } from "bun:test";
import { buildGraphqlDocuments, parseGraphqlFacts } from "./graphql.ts";
import { compileMatch } from "./relation.ts";
import { evaluateMatch } from "./semantics.ts";
import type {
  GraphqlDocument,
  GraphqlFieldOccurrence,
  JsonValue,
} from "./types.ts";

const LIMITS = { maxNodes: 10_000, maxDepth: 16 };

/** 出現 1 件。既定は引数なし。 */
const occurrence = (
  path: string,
  leaf: boolean,
  argumentValues: Readonly<Record<string, string>> = {},
  unresolvedArguments: readonly string[] = [],
): GraphqlFieldOccurrence => ({
  path,
  leaf,
  argumentValues,
  unresolvedArguments,
});

/** 経路と leaf だけを見るとき用。 */
const paths = (facts: GraphqlDocument): readonly string[] =>
  facts.fields.map((field) => field.path);

describe("parseGraphqlFacts", () => {
  test("fragment を使用位置で展開した出現を document 順に返す", () => {
    const facts = parseGraphqlFacts(
      'query($o:String="my-org") { r:repository(owner:$o) { ...F } } ' +
        "fragment F on Repository { issues { nodes { body } } }",
      { maxNodes: 10_000, maxDepth: 16 },
    )!;
    expect(facts.fields).toEqual([
      {
        path: "/repository",
        leaf: false,
        argumentValues: { owner: "my-org" },
        unresolvedArguments: [],
      },
      {
        path: "/repository/issues",
        leaf: false,
        argumentValues: {},
        unresolvedArguments: [],
      },
      {
        path: "/repository/issues/nodes",
        leaf: false,
        argumentValues: {},
        unresolvedArguments: [],
      },
      {
        path: "/repository/issues/nodes/body",
        leaf: true,
        argumentValues: {},
        unresolvedArguments: [],
      },
    ]);
  });

  test("名前のない省略形 `{ a }` は query として扱う", () => {
    const facts = parseGraphqlFacts("{ a }", LIMITS)!;
    expect(facts.operations).toEqual(["query"]);
    expect(facts.fields).toEqual([occurrence("/a", true)]);
  });

  test("mutation と subscription の種別が取れる", () => {
    const facts = parseGraphqlFacts(
      "mutation M { a } subscription S { b }",
      LIMITS,
    )!;
    expect(facts.operations).toEqual(["mutation", "subscription"]);
    expect(facts.fields).toEqual([
      occurrence("/a", true),
      occurrence("/b", true),
    ]);
  });

  test("alias は捨てて実フィールド名を使い、同じ親の 2 出現をまとめない", () => {
    // A5 / A9: alias を許可名に見せても経路は実名で、出現ごとに引数を持つ。
    const facts = parseGraphqlFacts(
      '{ safe: node(id: "a") { id } other: node(id: "b") { id } }',
      LIMITS,
    )!;
    expect(facts.fields).toEqual([
      occurrence("/node", false, { id: "a" }),
      occurrence("/node/id", true),
      occurrence("/node", false, { id: "b" }),
      occurrence("/node/id", true),
    ]);
  });

  test("同じ fragment が別の親に現れれば、それぞれの経路で出現する", () => {
    // A6: fragment 名で「展開済み」と扱うと 2 つ目の親が消える。
    const facts = parseGraphqlFacts(
      "{ safe { ...f } unsafe { ...f } } fragment f on T { body }",
      LIMITS,
    )!;
    expect(paths(facts)).toEqual([
      "/safe",
      "/safe/body",
      "/unsafe",
      "/unsafe/body",
    ]);
  });

  test("inline fragment の型条件は経路に入らず、全分岐を展開する", () => {
    // A7: `... on Blob` は経路要素ではなく、分岐は両方とも検査対象。
    const facts = parseGraphqlFacts(
      "{ object { ... on Blob { text } ... on Tree { entries } } }",
      LIMITS,
    )!;
    expect(paths(facts)).toEqual([
      "/object",
      "/object/text",
      "/object/entries",
    ]);
  });

  test("@skip / @include が付いていても両方の選択を展開する", () => {
    const facts = parseGraphqlFacts(
      "query($c: Boolean!) { a @skip(if: $c) { b @include(if: $c) } " +
        "... on Q @skip(if: $c) { c } ...f @include(if: $c) } " +
        "fragment f on Q { d }",
      LIMITS,
    )!;
    expect(paths(facts)).toEqual(["/a", "/a/b", "/c", "/d"]);
  });

  test("末端の __typename も 1 つの出現になる", () => {
    // A11: introspection 名に自動許可はないので、facts でも隠さない。
    const facts = parseGraphqlFacts("{ repository { __typename } }", LIMITS)!;
    expect(facts.fields).toEqual([
      occurrence("/repository", false),
      occurrence("/repository/__typename", true),
    ]);
  });

  test("使われない fragment は出現を作らない", () => {
    // A6 / A17: 未使用 fragment の無害な名前で違反を相殺できない。
    const facts = parseGraphqlFacts(
      "{ viewer } fragment f on Q { starredRepositories { nodes { name } } }",
      LIMITS,
    )!;
    expect(paths(facts)).toEqual(["/viewer"]);
  });

  test("spread の連鎖は使用位置の経路を引き継いで展開する", () => {
    const chain = Array.from(
      { length: 20 },
      (_, i) => `fragment f${i} on T { ...f${i + 1} }`,
    ).join(" ");
    const facts = parseGraphqlFacts(
      `{ repository { ...f0 } } ${chain} fragment f20 on T { body }`,
      LIMITS,
    )!;
    expect(paths(facts)).toEqual(["/repository", "/repository/body"]);
  });

  test("引数の値を解決する: 文字列リテラルと変数", () => {
    const facts = parseGraphqlFacts(
      "query ($o: String!) { repository(owner: $o, first: 10) { name } }",
      LIMITS,
      { o: "my-org" },
    )!;
    expect(facts.fields).toEqual([
      occurrence("/repository", false, { owner: "my-org" }, ["first"]),
      occurrence("/repository/name", true),
    ]);
  });

  test("variables に無い・文字列でない変数は解決不能になる", () => {
    const facts = parseGraphqlFacts("{ a(o: $o, n: $n, m: $m) }", LIMITS, {
      n: 42,
    })!;
    expect(facts.fields).toEqual([occurrence("/a", true, {}, ["o", "n", "m"])]);
  });

  test("directive の引数は field の引数にならない", () => {
    // 引数条件は field 経路に紐づく。`@include(if:)` は経路を持たないので
    // どの出現の引数にもならない (spec「経路に紐づく引数条件」)。
    const facts = parseGraphqlFacts(
      'query { a @include(if: $show) ...f } fragment f on Q { b(owner: "me") }',
      LIMITS,
      { show: true },
    )!;
    expect(facts.fields).toEqual([
      occurrence("/a", true),
      occurrence("/b", true, { owner: "me" }),
    ]);
  });

  test("1 つの field が同じ引数名を 2 度持つ document は解析できない", () => {
    // A8: どちらの値で実行されるか検査側で決められない。
    expect(
      parseGraphqlFacts('{ repository(owner: "a", owner: "b") }', LIMITS),
    ).toBeNull();
    expect(
      parseGraphqlFacts('{ repository(owner: $o, owner: "b") }', LIMITS),
    ).toBeNull();
    // 別々の field が同じ名前を持つのは正当である。
    expect(
      parseGraphqlFacts('{ a(owner: "x") b(owner: "y") }', LIMITS),
    ).not.toBeNull();
  });

  test("引数名 `__proto__` も他の引数名と同様に扱う", () => {
    // `__proto__` は正当な GraphQL Name であり、request が制御できる。
    // Object リテラルへの `argumentValues["__proto__"] = ...` はブラケット
    // 代入が Object.prototype の setter を踏むため無害化され、消えてしまう
    // (Python の dict はこの問題を持たず一致しない)。
    const facts = parseGraphqlFacts('{ a(__proto__: "x", b: "y") }', LIMITS)!;
    expect(facts.fields).toEqual([
      // 計算プロパティ名でなければ `{ __proto__: "x" }` は own property を
      // 作らず prototype を変えようとするだけなので、期待値もこの形にする。
      occurrence("/a", true, { ["__proto__"]: "x", b: "y" }),
    ]);
    expect(Object.hasOwn(facts.fields[0]!.argumentValues, "__proto__")).toBe(
      true,
    );
    // 同名判定も同様に `__proto__` を特別扱いしない: 2 度現れれば重複拒否。
    expect(
      parseGraphqlFacts('{ a(__proto__: "x", __proto__: "y") }', LIMITS),
    ).toBeNull();
  });

  test.each<[string, string]>([
    ["operation", "query @cached { a }"],
    ["変数定義", "query ($o: String @tag) { a }"],
    ["field", "{ a @cached { b } }"],
    ["inline fragment", "{ a { ... on T @cached { b } } }"],
    ["fragment spread", "{ ...f @cached } fragment f on Q { a }"],
    ["fragment 定義", "{ ...f } fragment f on Q @cached { a }"],
  ])("到達する %s の未知 directive は解析できない", (_name, text) => {
    // A8: 未知 directive の意味を推測して自動許可しない。
    expect(parseGraphqlFacts(text, LIMITS)).toBeNull();
  });

  test("到達しない fragment の未知 directive は解析を妨げない", () => {
    const facts = parseGraphqlFacts(
      "{ a } fragment f on Q @cached { b @cached }",
      LIMITS,
    )!;
    expect(paths(facts)).toEqual(["/a"]);
  });

  describe("変数の既定値", () => {
    const withDefault =
      'query ($o: String = "my-org") { repository(owner: $o) { name } }';
    const owner = (facts: GraphqlDocument | null) => facts?.fields[0];

    test("variables が無い・null・キーを持たないオブジェクトなら operation の既定値で解決する", () => {
      const cases: readonly (JsonValue | undefined)[] = [
        undefined,
        null,
        {},
        { other: "x" },
      ];
      for (const variables of cases) {
        const facts = parseGraphqlFacts(withDefault, LIMITS, variables)!;
        expect(owner(facts)).toEqual(
          occurrence("/repository", false, { owner: "my-org" }),
        );
      }
    });

    test("variables に与えた値が既定値より優先する", () => {
      const facts = parseGraphqlFacts(withDefault, LIMITS, { o: "other" })!;
      expect(owner(facts)).toEqual(
        occurrence("/repository", false, { owner: "other" }),
      );
    });

    test("variables の明示の null や文字列でない値は既定値に落ちず解決不能", () => {
      for (const provided of [null, 42]) {
        const facts = parseGraphqlFacts(withDefault, LIMITS, { o: provided })!;
        expect(owner(facts)).toEqual(
          occurrence("/repository", false, {}, ["owner"]),
        );
      }
    });

    test("オブジェクトでない variables の下では変数は既定値に落ちず解決不能", () => {
      // 文字列の variables を JSON として読み直して実行するサーバがあるので、
      // 既定値の "my-org" で解決すると実行される値 ("other-org") と食い違う。
      const cases: readonly JsonValue[] = [
        '{"o":"other-org"}',
        "",
        [],
        [{ o: "my-org" }],
        42,
        0,
        true,
        false,
      ];
      for (const variables of cases) {
        const facts = parseGraphqlFacts(withDefault, LIMITS, variables)!;
        expect(owner(facts)).toEqual(
          occurrence("/repository", false, {}, ["owner"]),
        );
      }
    });

    test("オブジェクトでない variables でも文字列リテラルの引数は解決する", () => {
      const facts = parseGraphqlFacts(
        'query ($o: String = "my-org") { a(owner: "lit", o: $o) }',
        LIMITS,
        '{"o":"x"}',
      )!;
      expect(facts.fields).toEqual([
        occurrence("/a", true, { owner: "lit" }, ["o"]),
      ]);
    });

    test("文字列でない既定値は解決不能", () => {
      const facts = parseGraphqlFacts(
        "query ($n: Int = 10, $e: E = FOO, $z: String = null, $l: [String] = " +
          '["a"]) { a(n: $n, e: $e, z: $z, l: $l) }',
        LIMITS,
      )!;
      expect(facts.fields).toEqual([
        occurrence("/a", true, {}, ["n", "e", "z", "l"]),
      ]);
    });

    test("同じ変数を 2 度宣言した operation を持つ document は解析できない", () => {
      for (const text of [
        'query ($o: String = "my-org", $o: String = "evil") { r(owner: $o) }',
        'query ($o: String = "my-org", $o: String) { r(owner: $o) }',
        "query A { a } query B ($o: String, $o: Int) { b }",
      ]) {
        expect(parseGraphqlFacts(text, LIMITS)).toBeNull();
      }
      // 別々の operation が同じ名前を宣言するのは正当である。
      expect(
        parseGraphqlFacts(
          'query A ($o: String = "a") { a } query B ($o: String) { b }',
          LIMITS,
        ),
      ).not.toBeNull();
    });

    test("共有 fragment の引数は使用位置の operation の既定値で解決する", () => {
      // A10: 出現ごとに、その出現を含む operation の文脈で解決する。
      const facts = parseGraphqlFacts(
        'query A ($o: String = "a") { ...f } ' +
          'query B ($o: String = "b") { viewer { ...f } } ' +
          "fragment f on Query { repository(owner: $o) { name } }",
        LIMITS,
      )!;
      expect(facts.fields).toEqual([
        occurrence("/repository", false, { owner: "a" }),
        occurrence("/repository/name", true),
        occurrence("/viewer", false),
        occurrence("/viewer/repository", false, { owner: "b" }),
        occurrence("/viewer/repository/name", true),
      ]);
    });

    test("既定値を持たない operation から (推移的に) 届く出現だけが解決不能になる", () => {
      const facts = parseGraphqlFacts(
        'query A ($o: String = "a") { ...f } ' +
          "query B ($o: String) { ...g } " +
          "fragment g on Query { ...f } " +
          "fragment f on Query { repository(owner: $o) }",
        LIMITS,
      )!;
      expect(facts.fields).toEqual([
        occurrence("/repository", true, { owner: "a" }),
        occurrence("/repository", true, {}, ["owner"]),
      ]);
    });
  });

  test("深さは SelectionSet・ObjectValue・ListValue を document 直下から数える", () => {
    // SelectionSet + ObjectValue + ListValue で深さ 3。上限ちょうどは通り、
    // 1 つ下げると落ちる。Python 側も同じ数え方で揃える。
    const text = "{ f(x: {a: [1]}) }";
    expect(
      parseGraphqlFacts(text, { maxNodes: 10_000, maxDepth: 3 }),
    ).not.toBeNull();
    expect(
      parseGraphqlFacts(text, { maxNodes: 10_000, maxDepth: 2 }),
    ).toBeNull();
    expect(
      parseGraphqlFacts("query { a { b } }", { maxNodes: 10_000, maxDepth: 2 }),
    ).not.toBeNull();
  });

  test("maxDepth は展開後の field の入れ子にも効く", () => {
    // AST の段数は operation・fragment それぞれ 2 でも、展開すると
    // /a/b/c の 3 段になる。fragment 越しの深さは token 数でも AST の
    // 段数でも抑えられないので、展開後に測る。
    const text = "{ a { ...f } } fragment f on T { b { c } }";
    expect(
      parseGraphqlFacts(text, { maxNodes: 10_000, maxDepth: 3 }),
    ).not.toBeNull();
    expect(parseGraphqlFacts(text, { maxNodes: 10_000, maxDepth: 2 })).toBe(
      null,
    );
  });

  describe("展開の予算", () => {
    /**
     * 各段が次の fragment を 2 度 spread する連鎖。parse は通るが、展開は
     * 段数に対して倍々に増える。末端の field は名前 `name` を持ち、その後ろに
     * `suffix` (引数や directive) が付く。
     *
     * `levels` 段の展開で取り出す selection は、spread が
     * 1 + 2 + ... + 2^levels = 2^(levels+1) - 1 件、末端の field が 2^levels 件。
     */
    const doubling = (levels: number, suffix: string, name = "a"): string =>
      `query { ...f0 } ` +
      Array.from(
        { length: levels },
        (_, i) => `fragment f${i} on T { ...f${i + 1} ...f${i + 1} }`,
      ).join(" ") +
      ` fragment f${levels} on T { ${name}${suffix} }`;

    test("倍々の spread は重複をまとめる前に課金する", () => {
      // 8 段の spread (1 + 2 + ... + 2^8 = 511) と 2^8 個の field で 767。
      // fragment 名で「展開済み」と扱えば 9 + 1 で済んでしまう。
      const text = doubling(8, "");
      expect(
        parseGraphqlFacts(text, { maxNodes: 767, maxDepth: 16 }),
      ).not.toBeNull();
      expect(parseGraphqlFacts(text, { maxNodes: 766, maxDepth: 16 })).toBe(
        null,
      );
    });

    test("展開後に評価する引数の出現も 1 つずつ課金する", () => {
      // 767 に 2^8 個の引数の出現を足して 1023。
      const text = doubling(8, '(owner: "my-org")');
      expect(
        parseGraphqlFacts(text, { maxNodes: 1023, maxDepth: 16 }),
      ).not.toBeNull();
      expect(parseGraphqlFacts(text, { maxNodes: 1022, maxDepth: 16 })).toBe(
        null,
      );
    });

    test("到達する directive は 1 つずつ課金する", () => {
      // 4 段の spread は 2^5 - 1 = 31、末端の field の出現は 2^4 = 16。
      // その field は @skip を 4 つ持つので、出現 1 件の課金は
      // 1 (selection) + 4 (directive) = 5 になり、合計 31 + 16 × 5 = 111。
      // directive を課金しなければ 31 + 16 = 47 で通ってしまう。同じ
      // field ノードを 16 回通る = 走査 64 回なので、「1 visit = 1 課金」の
      // ままでは小さな body で走査回数だけが増やせる。
      const text = doubling(4, " @skip(if: true)".repeat(4));
      expect(
        parseGraphqlFacts(text, { maxNodes: 111, maxDepth: 16 }),
      ).not.toBeNull();
      expect(parseGraphqlFacts(text, { maxNodes: 110, maxDepth: 16 })).toBe(
        null,
      );
    });

    test("出現に載せる経路は 64 バイトごとに課金する", () => {
      // 4 段なら spread 31 件・末端 field の出現 16 件。field 名を 127 文字に
      // すると経路は "/" + 127 = 128 バイトで 128 / 64 = 2 単位、出現 1 件の
      // 課金は 1 + 2 = 3 になり、合計 31 + 16 × 3 = 79。GraphQL の Name は
      // どれだけ長くても 1 token なので、課金しなければ 31 + 16 = 47 のまま
      // 巨大な文字列を出現の数だけ作れてしまう。
      const long = doubling(4, "", "a".repeat(127));
      expect(
        parseGraphqlFacts(long, { maxNodes: 79, maxDepth: 16 }),
      ).not.toBeNull();
      expect(parseGraphqlFacts(long, { maxNodes: 78, maxDepth: 16 })).toBe(
        null,
      );
      // 64 バイト未満の経路は追加課金 0。6 段・名前 "a" の連鎖は
      // (2^7 - 1) + 2^6 = 191 のままで、上の 767 / 1023 の計算も変わらない。
      const short = doubling(6, "");
      expect(
        parseGraphqlFacts(short, { maxNodes: 191, maxDepth: 16 }),
      ).not.toBeNull();
      expect(parseGraphqlFacts(short, { maxNodes: 190, maxDepth: 16 })).toBe(
        null,
      );
    });

    test("予算が尽きた document は途中までの出現を返さない", () => {
      // A8 / A17: parse 自体は通る document でも、展開しきれなければ
      // 文書全体が null であり、部分的な facts では自動許可しない。
      const text = doubling(8, "");
      expect(parseGraphqlFacts(text, { maxNodes: 200, maxDepth: 16 })).toBe(
        null,
      );
      expect(
        parseGraphqlFacts(text, { maxNodes: 10_000, maxDepth: 16 }),
      ).not.toBeNull();
    });
  });

  test.each<[string, string, typeof LIMITS]>([
    ["構文エラー", "query {", { maxNodes: 10_000, maxDepth: 16 }],
    ["token 予算超過", "{ a }", { maxNodes: 1, maxDepth: 16 }],
    ["深さ超過", "query { a { b } }", { maxNodes: 10_000, maxDepth: 1 }],
    [
      "fragment のみ",
      "fragment f on T { a }",
      { maxNodes: 10_000, maxDepth: 16 },
    ],
    [
      "未定義 fragment",
      "query { ...missing }",
      { maxNodes: 10_000, maxDepth: 16 },
    ],
    [
      "同名の fragment の再定義",
      "query { ...f } fragment f on Q { a } fragment f on Q { b }",
      { maxNodes: 10_000, maxDepth: 16 },
    ],
    [
      "使われない同名の fragment の再定義",
      "query { a } fragment f on Q { a } fragment f on Q { a }",
      { maxNodes: 10_000, maxDepth: 16 },
    ],
    [
      "循環 spread",
      "query { ...a } fragment a on T { ...b } fragment b on T { ...a }",
      { maxNodes: 10_000, maxDepth: 16 },
    ],
  ])("%s は null を返す", (_name, text, limits) => {
    expect(parseGraphqlFacts(text, limits)).toBeNull();
  });
});

describe("buildGraphqlDocuments", () => {
  test("文字列を持つ `at` の位置だけが documents に載る", () => {
    const documents = buildGraphqlDocuments(
      { query: "{ a }", other: 42, nested: { doc: "{ b }" } },
      ["/query", "/other", "/nested/doc", "/missing"],
      LIMITS,
    );
    expect(Object.keys(documents).sort()).toEqual(["/nested/doc", "/query"]);
    expect(paths(documents["/query"]!)).toEqual(["/a"]);
    expect(paths(documents["/nested/doc"]!)).toEqual(["/b"]);
  });

  test("fragment のみ・未定義 fragment・循環・深さ超過は documents に載らない", () => {
    const documents = buildGraphqlDocuments(
      {
        fragOnly: "fragment f on T { a }",
        missing: "query { ...missing }",
        cyclic:
          "query { ...a } fragment a on T { ...b } fragment b on T { ...a }",
        deep: "query { a { b { c } } }",
        good: "{ a }",
      },
      ["/fragOnly", "/missing", "/cyclic", "/deep", "/good"],
      { maxNodes: 10_000, maxDepth: 2 },
    );
    expect(Object.keys(documents)).toEqual(["/good"]);
  });

  test("GraphQL でない文字列は documents に載らない", () => {
    expect(
      buildGraphqlDocuments({ query: "not graphql {" }, ["/query"], LIMITS),
    ).toEqual({});
  });

  test("変数は `at` と同じオブジェクトの `variables` から取る", () => {
    const body = {
      query: "{ a(o: $o) }",
      variables: { o: "top" },
      batch: [{ query: "{ a(o: $o) }", variables: { o: "item" } }],
    };
    const documents = buildGraphqlDocuments(
      body,
      ["/query", "/batch/0/query"],
      LIMITS,
    );
    expect(documents["/query"]!.fields[0]!.argumentValues).toEqual({
      o: "top",
    });
    expect(documents["/batch/0/query"]!.fields[0]!.argumentValues).toEqual({
      o: "item",
    });
  });

  test("variables メンバが無い・ルートの document は既定値、文字列の variables は解決不能", () => {
    const query = 'query ($o: String = "d") { a(o: $o) }';
    expect(
      buildGraphqlDocuments({ query }, ["/query"], LIMITS)["/query"]!.fields[0]!
        .argumentValues,
    ).toEqual({ o: "d" });
    expect(
      buildGraphqlDocuments({ query, variables: "{}" }, ["/query"], LIMITS)[
        "/query"
      ]!.fields[0]!.unresolvedArguments,
    ).toEqual(["o"]);
    // document がボディのルートなら兄弟は無く、既定値で解決する。
    expect(
      buildGraphqlDocuments(query, [""], LIMITS)[""]!.fields[0]!.argumentValues,
    ).toEqual({ o: "d" });
  });
});

describe("facts と evaluateMatch の結合", () => {
  const compiled = compileMatch({
    paths: ["/graphql"],
    body: {
      format: "json",
      graphql: {
        operations: ["query"],
        fieldPaths: [
          "/repository/nameWithOwner",
          "/repository/issues/nodes/body",
          "/repository/issues/nodes/comments/nodes/body",
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
  });
  if (!compiled.ok) throw new Error(compiled.error);
  const match = compiled.value;

  const evaluate = (value: JsonValue): string =>
    evaluateMatch(match, {
      method: "POST",
      path: "/graphql",
      body: {
        kind: "json",
        value,
        documents: buildGraphqlDocuments(value, ["/query"], LIMITS),
      },
    });

  const query = (text: string): string => evaluate({ query: text });

  test("brief の経路条件の例をそのまま評価する", () => {
    const example = compileMatch({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: {
          operations: ["query"],
          fieldPaths: ["/repository/issues/nodes/body"],
          fieldArguments: { "/repository": { owner: ["my-org"] } },
        },
      },
    });
    if (!example.ok) throw new Error(example.error);
    for (const [text, truth] of [
      ['{ repository(owner:"my-org") { issues { nodes { body } } } }', "true"],
      ["{ repository { issues { nodes { body } } } }", "false"],
      ['{ repository(owner:"other") { issues { nodes { body } } } }', "false"],
      [
        "{ repository(owner:$missing) { issues { nodes { body } } } }",
        "indeterminate",
      ],
      [
        '{ repository(owner:"my-org") { parent { issues { nodes { body } } } } }',
        "false",
      ],
    ] as const) {
      const value = { query: text };
      const documents = buildGraphqlDocuments(value, ["/query"], LIMITS);
      expect([
        text,
        evaluateMatch(example.value, {
          method: "POST",
          path: "/graphql",
          body: { kind: "json", value, documents },
        }),
      ]).toEqual([text, truth]);
    }
  });

  test("A2/A3: 許可 owner の Issue 本文・コメント・Blob.text は真になる", () => {
    expect(
      query(`{
        repository(owner: "my-org", name: "r") {
          nameWithOwner
          issues(first: 10) {
            nodes { body comments(first: 10) { nodes { body } } }
          }
          object(expression: "HEAD:README.md") { ... on Blob { text } }
        }
      }`),
    ).toBe("true");
  });

  test("A1: organization → member → star → Issue/README の反例は偽になる", () => {
    expect(
      query(`query {
        organization(login: "my-org") {
          membersWithRole(first: 10) {
            nodes {
              starredRepositories(first: 10) {
                nodes {
                  issues(first: 10) {
                    nodes { body comments(first: 10) { nodes { body } } }
                  }
                  object(expression: "HEAD:README.md") { ... on Blob { text } }
                }
              }
            }
          }
        }
      }`),
    ).toBe("false");
  });

  test("A4: 同じ body/text を別経路から取ると偽になる", () => {
    for (const text of [
      '{ repository(owner: "my-org") { parent { issues { nodes { body } } } } }',
      '{ repository(owner: "my-org") { issues { nodes { author { ... on User { login } } } } } }',
      '{ repository(owner: "my-org") { forks { nodes { object { text } } } } }',
    ]) {
      expect([text, query(text)]).toEqual([text, "false"]);
    }
  });

  test("A5/A11: alias・edges/node への差し替え・許可外の子は偽になる", () => {
    // alias は捨てて実フィールド名で検査する。
    expect(
      query('{ safe: repository(owner: "my-org") { nameWithOwner } }'),
    ).toBe("true");
    expect(
      query(
        '{ repository(owner: "my-org") { nameWithOwner: starredRepositories { nodes { name } } } }',
      ),
    ).toBe("false");
    // `nodes` を `edges { node }` に変えた経路は別物である。
    expect(
      query(
        '{ repository(owner: "my-org") { issues { edges { node { body } } } } }',
      ),
    ).toBe("false");
    // 許可末端の子を足す・未許可の __typename を足す。
    expect(
      query(
        '{ repository(owner: "my-org") { issues { nodes { body { text } } } } }',
      ),
    ).toBe("false");
    expect(
      query('{ repository(owner: "my-org") { __typename nameWithOwner } }'),
    ).toBe("false");
  });

  test("A6/A7: fragment・型条件・skip/include は経路を隠せない", () => {
    // 同じ fragment を安全な親と不安全な親の両方で使う。
    expect(
      query(`query {
        repository(owner: "my-org") { ...body }
        organization(login: "my-org") {
          membersWithRole { nodes { starredRepositories { nodes { ...body } } } }
        }
      }
      fragment body on Repository { issues { nodes { body } } }`),
    ).toBe("false");
    // 条件に関係なく両方の選択を検査する。
    expect(
      query(
        '{ repository(owner: "my-org") { issues @skip(if: true) { nodes { author { login } } } } }',
      ),
    ).toBe("false");
    // 型条件は経路要素にならず、全分岐を検査する。
    expect(
      query(
        '{ repository(owner: "my-org") { object { ... on Blob { text } ... on Tree { entries { name } } } } }',
      ),
    ).toBe("false");
  });

  test("A8: 未知 directive・重複引数・予算超過は自動許可しない", () => {
    expect(
      query('{ repository(owner: "my-org") @auth { nameWithOwner } }'),
    ).toBe("indeterminate");
    expect(
      query(
        '{ repository(owner: "my-org", owner: "my-org") { nameWithOwner } }',
      ),
    ).toBe("indeterminate");
    const value = {
      query: '{ repository(owner: "my-org") { nameWithOwner } }',
    };
    const documents = buildGraphqlDocuments(value, ["/query"], {
      maxNodes: 2,
      maxDepth: 16,
    });
    expect(documents).toEqual({});
    expect(
      evaluateMatch(match, {
        method: "POST",
        path: "/graphql",
        body: { kind: "json", value, documents },
      }),
    ).toBe("indeterminate");
  });

  test("A9: owner の省略・別 field の owner での代用・片方だけの不正は偽になる", () => {
    expect(query("{ repository { nameWithOwner } }")).toBe("false");
    // 別の field にある owner で `/repository` の必須 owner は満たせない。
    expect(
      query('{ repository { issues(owner: "my-org") { nodes { body } } } }'),
    ).toBe("false");
    // 2 つの出現のうち片方だけが不正でも全体が偽になる。
    expect(
      query(`{
        a: repository(owner: "my-org") { nameWithOwner }
        b: repository(owner: "other") { nameWithOwner }
      }`),
    ).toBe("false");
  });

  test("A10: 変数・既定値・明示 null・数値を出現ごとに解決する", () => {
    expect(
      evaluate({
        query:
          "query ($o: String!) { repository(owner: $o) { nameWithOwner } }",
        variables: { o: "my-org" },
      }),
    ).toBe("true");
    expect(
      evaluate({
        query:
          "query ($o: String!) { repository(owner: $o) { nameWithOwner } }",
        variables: { o: "other-org" },
      }),
    ).toBe("false");
    // variables に無い変数は operation の既定値で解決する。
    expect(
      query(
        'query ($o: String = "my-org") { repository(owner: $o) { nameWithOwner } }',
      ),
    ).toBe("true");
    expect(
      query(
        'query ($o: String = "other") { repository(owner: $o) { nameWithOwner } }',
      ),
    ).toBe("false");
    // 明示 null・数値は文字列化しないので解決不能 = 判定不能。
    expect(query("{ repository(owner: null) { nameWithOwner } }")).toBe(
      "indeterminate",
    );
    expect(query("{ repository(owner: 42) { nameWithOwner } }")).toBe(
      "indeterminate",
    );
    expect(
      evaluate({
        query: "{ repository(owner: $o) { nameWithOwner } }",
        variables: { o: 42 },
      }),
    ).toBe("indeterminate");
    // 複数 operation で既定値が違えば、出現ごとにその operation の文脈で解決する。
    expect(
      query(`query A ($o: String = "my-org") { repository(owner: $o) { nameWithOwner } }
             query B ($o: String = "other") { repository(owner: $o) { nameWithOwner } }`),
    ).toBe("false");
  });

  test("A10: variables が null なら既定値、オブジェクトでなければ判定不能", () => {
    const text =
      'query ($o: String = "my-org") { repository(owner: $o) { nameWithOwner } }';
    expect(evaluate({ query: text, variables: null })).toBe("true");
    expect(evaluate({ query: text, variables: {} })).toBe("true");
    for (const variables of ['{"o":"other-org"}', [], 1, true]) {
      expect(evaluate({ query: text, variables })).toBe("indeterminate");
    }
  });

  test("A12: 許可・禁止の取得が混在すると全体が偽になる", () => {
    expect(
      query(`{
        repository(owner: "my-org") { nameWithOwner }
        organization(login: "my-org") { membersWithRole { nodes { login } } }
        viewer { login }
      }`),
    ).toBe("false");
  });

  test("mutation を含む document は operations の条件で偽になる", () => {
    expect(query('mutation { repository(owner: "my-org") }')).toBe("false");
    // 省略形 `{ a }` は query として判定される。
    expect(
      buildGraphqlDocuments({ query: "{ a }" }, ["/query"], LIMITS)["/query"]!
        .operations,
    ).toEqual(["query"]);
  });

  test("A17: parse 失敗は documents に載らず判定不能になる", () => {
    expect(query("not graphql {")).toBe("indeterminate");
    // 旧形式の手書き facts も、末端を持たないので判定不能になる。
    expect(
      evaluateMatch(match, {
        method: "POST",
        path: "/graphql",
        body: {
          kind: "json",
          value: { query: "{ a }" },
          documents: {
            "/query": {
              operations: ["query"],
              fields: [],
            },
          },
        },
      }),
    ).toBe("indeterminate");
  });
});
