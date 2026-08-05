import { describe, expect, test } from "bun:test";
import { type CompiledMatch, compileMatch } from "./relation.ts";
import { evaluateMatch } from "./semantics.ts";
import type { Match, RequestBody } from "./types.ts";

function compile(match: Match): CompiledMatch {
  const compiled = compileMatch(match);
  if (!compiled.ok) throw new Error(compiled.error);
  return compiled.value;
}

const request = (body: RequestBody, path = "/x", method = "POST") => ({
  method,
  path,
  body,
});

describe("evaluateMatch", () => {
  test("メソッドとパスが外れた候補は何も主張しない", () => {
    const match = compile({ methods: ["GET"], paths: ["/x"] });
    expect(
      evaluateMatch(match, request({ kind: "absent" }, "/x", "POST")),
    ).toBe("false");
    expect(evaluateMatch(match, request({ kind: "absent" }, "/y", "GET"))).toBe(
      "false",
    );
    expect(evaluateMatch(match, request({ kind: "absent" }, "/x", "GET"))).toBe(
      "true",
    );
  });
});

describe("format の意味", () => {
  const evaluate = (format: "none" | "json" | "opaque", body: RequestBody) =>
    evaluateMatch(compile({ paths: ["/x"], body: { format } }), request(body));

  test('"none" はボディが存在し長さが 0 であることを条件にする', () => {
    expect(evaluate("none", { kind: "empty" })).toBe("true");
    expect(evaluate("none", { kind: "json", value: {} })).toBe("false");
    expect(evaluate("none", { kind: "absent" })).toBe("false");
  });

  test('"opaque" はボディの存在だけを条件にする', () => {
    expect(evaluate("opaque", { kind: "empty" })).toBe("true");
    expect(evaluate("opaque", { kind: "binary" })).toBe("true");
    expect(evaluate("opaque", { kind: "json", value: {} })).toBe("true");
    expect(evaluate("opaque", { kind: "absent" })).toBe("false");
  });

  test('"json" は解析できないボディで判定不能になる', () => {
    expect(evaluate("json", { kind: "json", value: {} })).toBe("true");
    // 0 バイトのボディは JSON として解析できない。偽ではなく判定不能である。
    expect(evaluate("json", { kind: "empty" })).toBe("indeterminate");
    expect(evaluate("json", { kind: "binary" })).toBe("indeterminate");
    expect(evaluate("json", { kind: "absent" })).toBe("false");
  });

  test("ボディ条件を持たない match はボディのないリクエストも受理する", () => {
    const match = compile({ paths: ["/x"] });
    expect(evaluateMatch(match, request({ kind: "absent" }))).toBe("true");
  });
});

describe("値条件の意味", () => {
  const match = compile({
    paths: ["/x"],
    body: { format: "json", oneOf: { "/model": ["claude"] } },
  });

  test("対象が存在しない場合と値が異なる場合は偽である", () => {
    expect(evaluateMatch(match, request({ kind: "json", value: {} }))).toBe(
      "false",
    );
    expect(
      evaluateMatch(
        match,
        request({ kind: "json", value: { model: "other" } }),
      ),
    ).toBe("false");
  });

  test("条件と噛み合わない型は判定不能である", () => {
    expect(
      evaluateMatch(
        match,
        request({ kind: "json", value: { model: { a: 1 } } }),
      ),
    ).toBe("indeterminate");
  });

  test("判定不能は偽より優先する", () => {
    const both = compile({
      paths: ["/x"],
      body: { format: "json", oneOf: { "/a": ["y"], "/b": ["y"] } },
    });
    expect(
      evaluateMatch(
        both,
        request({ kind: "json", value: { a: "n", b: { c: 1 } } }),
      ),
    ).toBe("indeterminate");
  });

  test("数値と文字列は区別する", () => {
    const numeric = compile({
      paths: ["/x"],
      body: { format: "json", equals: { "/n": 1 } },
    });
    expect(
      evaluateMatch(numeric, request({ kind: "json", value: { n: 1 } })),
    ).toBe("true");
    expect(
      evaluateMatch(numeric, request({ kind: "json", value: { n: "1" } })),
    ).toBe("false");
  });
});

describe("graphql 条件の意味", () => {
  const match = compile({
    paths: ["/graphql"],
    body: {
      format: "json",
      graphql: {
        operations: ["query"],
        rootFields: ["organization"],
        arguments: { login: ["my-org"] },
      },
    },
  });

  const withDocument = (
    operations: readonly ("query" | "mutation")[],
    rootFields: readonly string[],
    argumentValues: Record<string, readonly string[]>,
  ): RequestBody => ({
    kind: "json",
    value: { query: "..." },
    documents: { "/query": { operations, rootFields, argumentValues } },
  });

  test("すべての operation と root field が集合に含まれるときだけ真になる", () => {
    expect(
      evaluateMatch(
        match,
        request(withDocument(["query"], ["organization"], {}), "/graphql"),
      ),
    ).toBe("true");
    expect(
      evaluateMatch(
        match,
        request(
          withDocument(["query", "mutation"], ["organization"], {}),
          "/graphql",
        ),
      ),
    ).toBe("false");
    expect(
      evaluateMatch(
        match,
        request(withDocument(["query"], ["search"], {}), "/graphql"),
      ),
    ).toBe("false");
  });

  test("その名前の引数が現れないなら制約は空になり真である", () => {
    expect(
      evaluateMatch(
        match,
        request(
          withDocument(["query"], ["organization"], { owner: ["other"] }),
          "/graphql",
        ),
      ),
    ).toBe("true");
    expect(
      evaluateMatch(
        match,
        request(
          withDocument(["query"], ["organization"], { login: ["other"] }),
          "/graphql",
        ),
      ),
    ).toBe("false");
  });

  test("at の対象が document として読めないなら判定不能である", () => {
    expect(
      evaluateMatch(
        match,
        request({ kind: "json", value: { query: 1 } }, "/graphql"),
      ),
    ).toBe("indeterminate");
    // 対象が存在しない場合は偽である。
    expect(
      evaluateMatch(match, request({ kind: "json", value: {} }, "/graphql")),
    ).toBe("false");
  });
});
