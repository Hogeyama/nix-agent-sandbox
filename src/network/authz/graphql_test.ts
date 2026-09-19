import { describe, expect, test } from "bun:test";
import { buildGraphqlDocuments, parseGraphqlFacts } from "./graphql.ts";
import { compileMatch } from "./relation.ts";
import { evaluateMatch } from "./semantics.ts";
import type { JsonValue } from "./types.ts";

const LIMITS = { maxNodes: 10_000, maxDepth: 16 };

describe("parseGraphqlFacts", () => {
  test("名前のない省略形 `{ a }` は query として扱う", () => {
    const facts = parseGraphqlFacts("{ a }", LIMITS)!;
    expect(facts.operations).toEqual(["query"]);
    expect(facts.rootFields).toEqual(["a"]);
  });

  test("mutation と subscription の種別が取れる", () => {
    const facts = parseGraphqlFacts(
      "mutation M { a } subscription S { b }",
      LIMITS,
    )!;
    expect(facts.operations).toEqual(["mutation", "subscription"]);
  });

  test("root の fragment spread と inline fragment を展開して rootFields に含める", () => {
    const facts = parseGraphqlFacts(
      "query { viewer ...f ... on Query { rateLimit } } " +
        "fragment f on Query { repository { name } }",
      LIMITS,
    )!;
    expect(facts.rootFields).toEqual(["viewer", "repository", "rateLimit"]);
  });

  test("引数の値を解決する: 文字列リテラルと変数", () => {
    const facts = parseGraphqlFacts(
      "query ($o: String!) { repository(owner: $o, first: 10) { name } }",
      LIMITS,
      { o: "my-org" },
    )!;
    expect(facts.argumentValues).toEqual({ owner: ["my-org"] });
    expect(facts.unresolvedArguments).toEqual(["first"]);
  });

  test("variables に無い・文字列でない変数は解決不能になる", () => {
    const facts = parseGraphqlFacts("{ a(o: $o, n: $n, m: $m) }", LIMITS, {
      n: 42,
    })!;
    expect(facts.argumentValues).toEqual({});
    expect(facts.unresolvedArguments).toEqual(["o", "n", "m"]);
  });

  test("directive の引数や fragment 内の引数も集める", () => {
    const facts = parseGraphqlFacts(
      'query { a @include(if: $show) ...f } fragment f on Q { b(owner: "me") }',
      LIMITS,
      { show: true },
    )!;
    expect(facts.argumentValues).toEqual({ owner: ["me"] });
    expect(facts.unresolvedArguments).toEqual(["if"]);
  });

  describe("変数の既定値", () => {
    const withDefault =
      'query ($o: String = "my-org") { repository(owner: $o) { name } }';

    test("variables が無い・null・キーを持たないオブジェクトなら operation の既定値で解決する", () => {
      const cases: readonly (JsonValue | undefined)[] = [
        undefined,
        null,
        {},
        { other: "x" },
      ];
      for (const variables of cases) {
        const facts = parseGraphqlFacts(withDefault, LIMITS, variables)!;
        expect(facts.argumentValues).toEqual({ owner: ["my-org"] });
        expect(facts.unresolvedArguments).toEqual([]);
      }
    });

    test("variables に与えた値が既定値より優先する", () => {
      const facts = parseGraphqlFacts(withDefault, LIMITS, { o: "other" })!;
      expect(facts.argumentValues).toEqual({ owner: ["other"] });
      expect(facts.unresolvedArguments).toEqual([]);
    });

    test("variables の明示の null や文字列でない値は既定値に落ちず解決不能", () => {
      for (const provided of [null, 42]) {
        const facts = parseGraphqlFacts(withDefault, LIMITS, { o: provided })!;
        expect(facts.argumentValues).toEqual({});
        expect(facts.unresolvedArguments).toEqual(["owner"]);
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
        expect(facts.argumentValues).toEqual({});
        expect(facts.unresolvedArguments).toEqual(["owner"]);
      }
    });

    test("オブジェクトでない variables でも文字列リテラルの引数は解決する", () => {
      const facts = parseGraphqlFacts(
        'query ($o: String = "my-org") { a(owner: "lit", o: $o) }',
        LIMITS,
        '{"o":"x"}',
      )!;
      expect(facts.argumentValues).toEqual({ owner: ["lit"] });
      expect(facts.unresolvedArguments).toEqual(["o"]);
    });

    test("文字列でない既定値は解決不能", () => {
      const facts = parseGraphqlFacts(
        "query ($n: Int = 10, $e: E = FOO, $z: String = null, $l: [String] = " +
          '["a"]) { a(n: $n, e: $e, z: $z, l: $l) }',
        LIMITS,
      )!;
      expect(facts.argumentValues).toEqual({});
      expect(facts.unresolvedArguments).toEqual(["n", "e", "z", "l"]);
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

    test("共有 fragment の引数は到達する operation ごとの既定値をすべて集める", () => {
      const facts = parseGraphqlFacts(
        'query A ($o: String = "a") { ...f } ' +
          'query B ($o: String = "b") { viewer { ...f } } ' +
          "fragment f on Query { repository(owner: $o) { name } }",
        LIMITS,
      )!;
      expect(facts.argumentValues).toEqual({ owner: ["a", "b"] });
      expect(facts.unresolvedArguments).toEqual([]);
    });

    test("既定値を持たない operation から (推移的に) 届く共有 fragment は解決不能も載る", () => {
      const facts = parseGraphqlFacts(
        'query A ($o: String = "a") { ...f } ' +
          "query B ($o: String) { ...g } " +
          "fragment g on Query { ...f } " +
          "fragment f on Query { repository(owner: $o) { name } }",
        LIMITS,
      )!;
      expect(facts.argumentValues).toEqual({ owner: ["a"] });
      expect(facts.unresolvedArguments).toEqual(["owner"]);
    });

    test("どの operation からも届かない fragment の引数は variables だけで解決する", () => {
      const text =
        'query ($o: String = "a") { viewer } ' +
        "fragment f on Query { repository(owner: $o) }";
      const bare = parseGraphqlFacts(text, LIMITS)!;
      expect(bare.argumentValues).toEqual({});
      expect(bare.unresolvedArguments).toEqual(["owner"]);
      const provided = parseGraphqlFacts(text, LIMITS, { o: "v" })!;
      expect(provided.argumentValues).toEqual({ owner: ["v"] });
      expect(provided.unresolvedArguments).toEqual([]);
    });

    test("operation ごとの fragment 展開量が maxNodes を超えると解析できない", () => {
      // 20 個の operation がそれぞれ引数 20 個の fragment に届くので、
      // 展開量は 20 × (1 + 20) = 420。token 数はそれより少ない。
      const text =
        "query { ...f } ".repeat(20) +
        `fragment f on Q { ${"a(x: 1) ".repeat(20)}}`;
      expect(parseGraphqlFacts(text, { maxNodes: 420, maxDepth: 16 })).not.toBe(
        null,
      );
      expect(parseGraphqlFacts(text, { maxNodes: 419, maxDepth: 16 })).toBe(
        null,
      );
    });

    test("fragment が spread する相異なる fragment の数も展開量に数える", () => {
      // f への訪問は 1 + 0 + 20、g1..g20 への訪問は 1 ずつなので、
      // operation 1 つあたり 41、20 個で 820。
      const spreads = Array.from({ length: 20 }, (_, i) => `...g${i}`).join(
        " ",
      );
      const targets = Array.from(
        { length: 20 },
        (_, i) => `fragment g${i} on Q { a }`,
      ).join(" ");
      const text = `${"query { ...f } ".repeat(20)}fragment f on Q { ${spreads} } ${targets}`;
      expect(parseGraphqlFacts(text, { maxNodes: 820, maxDepth: 16 })).not.toBe(
        null,
      );
      expect(parseGraphqlFacts(text, { maxNodes: 819, maxDepth: 16 })).toBe(
        null,
      );
    });

    test("同じ spread の繰り返しは 1 本の辺として数えて辿る", () => {
      // f は g を 200 回 spread するが辺は 1 本なので、f への訪問は 1 + 0 + 1、
      // g への訪問は 1 + 20。operation 1 つあたり 23、40 個で 920。
      // 繰り返しを数えるなら (あるいは辿るなら) 境界はここに来ない。
      const text =
        "query { ...f } ".repeat(40) +
        `fragment f on Q { ${"...g ".repeat(200)}} ` +
        `fragment g on Q { ${"a(x: 1) ".repeat(20)}}`;
      expect(parseGraphqlFacts(text, { maxNodes: 920, maxDepth: 16 })).not.toBe(
        null,
      );
      expect(parseGraphqlFacts(text, { maxNodes: 919, maxDepth: 16 })).toBe(
        null,
      );
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
    expect(documents["/query"]!.rootFields).toEqual(["a"]);
    expect(documents["/nested/doc"]!.rootFields).toEqual(["b"]);
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
});

describe("facts と evaluateMatch の結合", () => {
  const compiled = compileMatch({
    paths: ["/graphql"],
    body: {
      format: "json",
      graphql: {
        operations: ["query"],
        rootFields: ["repository", "viewer", "rateLimit"],
        arguments: { owner: ["my-org"], login: ["my-org"] },
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

  test("省略形 `{ a }` は query として判定される", () => {
    const documents = buildGraphqlDocuments(
      { query: "{ a }" },
      ["/query"],
      LIMITS,
    );
    expect(documents["/query"]!.operations).toEqual(["query"]);
  });

  test('mutation を含む document は operations { "query" } の条件で偽', () => {
    expect(evaluate({ query: "mutation { repository }" })).toBe("false");
  });

  test("root の fragment spread 越しの node は rootFields の条件で偽になる", () => {
    expect(
      evaluate({
        query: 'query { ...f } fragment f on Query { node(id: "abc") }',
      }),
    ).toBe("false");
  });

  test("`repository(owner:$o)` + variables が解決されて arguments の条件を判定する", () => {
    expect(
      evaluate({
        query: "query ($o: String!) { repository(owner: $o) { name } }",
        variables: { o: "my-org" },
      }),
    ).toBe("true");
    expect(
      evaluate({
        query: "query ($o: String!) { repository(owner: $o) { name } }",
        variables: { o: "other-org" },
      }),
    ).toBe("false");
  });

  test("variables に無い変数は operation の既定値で arguments の条件を判定する", () => {
    expect(
      evaluate({
        query:
          'query ($o: String = "my-org") { repository(owner: $o) { name } }',
      }),
    ).toBe("true");
    expect(
      evaluate({
        query:
          'query ($o: String = "other-org") { repository(owner: $o) { name } }',
      }),
    ).toBe("false");
  });

  test("variables が null なら既定値で、オブジェクトでなければ判定不能になる", () => {
    const query =
      'query ($o: String = "my-org") { repository(owner: $o) { name } }';
    expect(evaluate({ query, variables: null })).toBe("true");
    expect(evaluate({ query, variables: {} })).toBe("true");
    for (const variables of ['{"o":"other-org"}', [], 1, true]) {
      expect(evaluate({ query, variables })).toBe("indeterminate");
    }
  });

  test("variables メンバが無い・ルートの document は既定値、文字列の variables は解決不能", () => {
    const query = 'query ($o: String = "d") { a(o: $o) }';
    expect(
      buildGraphqlDocuments({ query }, ["/query"], LIMITS)["/query"]!
        .argumentValues,
    ).toEqual({ o: ["d"] });
    expect(
      buildGraphqlDocuments({ query, variables: "{}" }, ["/query"], LIMITS)[
        "/query"
      ]!.unresolvedArguments,
    ).toEqual(["o"]);
    // document がボディのルートなら兄弟は無く、既定値で解決する。
    expect(
      buildGraphqlDocuments(query, [""], LIMITS)[""]!.argumentValues,
    ).toEqual({ o: ["d"] });
  });

  test("名指しした引数が解決不能なら判定不能 (偽ではない)", () => {
    expect(
      evaluate({ query: "query ($o: String!) { repository(owner: $o) }" }),
    ).toBe("indeterminate");
    expect(
      evaluate({
        query: "{ repository(owner: $o) }",
        variables: { o: 42 },
      }),
    ).toBe("indeterminate");
  });

  test("名指ししていない引数の解決不能は判定に関与しない", () => {
    expect(
      evaluate({
        query: '{ repository(owner: "my-org", first: 10) { name } }',
      }),
    ).toBe("true");
  });

  test("引数が 1 つも現れない document は `arguments` の条件で真", () => {
    expect(evaluate({ query: "{ repository { name } }" })).toBe("true");
  });

  test("parse 失敗や token 予算超過は documents に載らず判定不能になる", () => {
    expect(evaluate({ query: "not graphql {" })).toBe("indeterminate");
    const documents = buildGraphqlDocuments({ query: "{ a }" }, ["/query"], {
      maxNodes: 1,
      maxDepth: 16,
    });
    expect(documents).toEqual({});
    expect(
      evaluateMatch(match, {
        method: "POST",
        path: "/graphql",
        body: { kind: "json", value: { query: "{ a }" }, documents },
      }),
    ).toBe("indeterminate");
  });
});
