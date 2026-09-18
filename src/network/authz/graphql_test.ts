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
