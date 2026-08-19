import { describe, expect, test } from "bun:test";
import { type CompiledMatch, compileMatch, parseTarget } from "./relation.ts";
import { accepts } from "./semantics.ts";
import type { Match, Target } from "./types.ts";
import {
  describeRequest,
  describeTargetAddress,
  matchIntersectionWitness,
  targetIntersectionWitness,
} from "./witness.ts";

function compile(match: Match): CompiledMatch {
  const compiled = compileMatch(match);
  if (!compiled.ok) throw new Error(compiled.error);
  return compiled.value;
}

function targets(...sources: readonly string[]): readonly Target[] {
  return sources.map((source) => {
    const parsed = parseTarget(source);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  });
}

describe("matchIntersectionWitness", () => {
  test("設計「設定エラーの提示」の例と同じ情報を出せる", () => {
    const read = compile({
      methods: ["GET", "HEAD"],
      paths: ["/repos/{org}/{repo}/**"],
      captures: { org: ["my-org"] },
    });
    const pulls = compile({ methods: ["GET"], paths: ["/repos/*/*/pulls"] });

    const witness = matchIntersectionWitness(read, pulls);
    expect(witness).not.toBeNull();
    if (witness === null) return;
    expect(describeRequest(witness)).toEqual([
      "GET /repos/my-org/x/pulls",
      "ボディ条件なし",
    ]);
    expect(accepts(read, witness)).toBe(true);
    expect(accepts(pulls, witness)).toBe(true);
  });

  test("交差しない組では証人を構成しない", () => {
    const get = compile({ methods: ["GET"], paths: ["/a"] });
    const post = compile({ methods: ["POST"], paths: ["/a"] });
    expect(matchIntersectionWitness(get, post)).toBeNull();
  });

  test("** には交差に必要な数だけセグメントを置く", () => {
    const deep = compile({ paths: ["/a/**"] });
    const exact = compile({ paths: ["/a/b/c"] });
    const witness = matchIntersectionWitness(deep, exact);
    expect(witness?.path).toBe("/a/b/c");
  });

  test("制約付き capture は先頭の要素、それ以外は x を置く", () => {
    const a = compile({
      paths: ["/{org}/{repo}"],
      captures: { org: ["my-org"] },
    });
    const b = compile({ paths: ["/*/*"] });
    expect(matchIntersectionWitness(a, b)?.path).toBe("/my-org/x");
  });

  test("ボディは条件を満たす最小の骨格を JSON として構成する", () => {
    const a = compile({
      paths: ["/v1/x"],
      body: { format: "json", equals: { "/model": "claude" } },
    });
    const b = compile({
      paths: ["/v1/x"],
      body: { format: "json", oneOf: { "/stream": [true, false] } },
    });
    const witness = matchIntersectionWitness(a, b);
    expect(witness?.body).toEqual({
      kind: "json",
      value: { model: "claude", stream: true },
      documents: {},
    });
    if (witness === null || witness === undefined) return;
    expect(accepts(a, witness)).toBe(true);
    expect(accepts(b, witness)).toBe(true);
  });

  test("root スカラーと子孫 Pointer の制約は同時に満たせない", () => {
    const root = compile({
      paths: ["/v1/x"],
      body: { format: "json", equals: { "": "root-value" } },
    });
    const descendant = compile({
      paths: ["/v1/x"],
      body: { format: "json", equals: { "/child": "value" } },
    });

    expect(matchIntersectionWitness(root, descendant)).toBeNull();
    expect(matchIntersectionWitness(descendant, root)).toBeNull();
  });

  test("format の交差は狭い側を採る", () => {
    const opaque = compile({ paths: ["/x"], body: { format: "opaque" } });
    const none = compile({ paths: ["/x"], body: { format: "none" } });
    const witness = matchIntersectionWitness(opaque, none);
    expect(witness?.body).toEqual({ kind: "empty" });
    expect(describeRequest(witness as never)[1]).toBe("ボディ: 長さ 0");
  });

  test("graphql の証人は両方の operations と rootFields を満たす", () => {
    const a = compile({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: {
          operations: ["query", "mutation"],
          rootFields: ["repository"],
        },
      },
    });
    const b = compile({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: {
          operations: ["query"],
          rootFields: ["repository", "organization"],
          arguments: { login: ["my-org"] },
        },
      },
    });
    const witness = matchIntersectionWitness(a, b);
    expect(witness).not.toBeNull();
    if (witness === null) return;
    expect(accepts(a, witness)).toBe(true);
    expect(accepts(b, witness)).toBe(true);
    expect(witness.body).toEqual({
      kind: "json",
      value: { query: "query { repository { __typename } }" },
      documents: {
        "/query": {
          operations: ["query"],
          rootFields: ["repository"],
          // 制約された引数は置かない。引数を持たない document は
          // 「その引数が現れるなら値はこの集合」という条件を満たす。
          argumentValues: {},
        },
      },
    });
  });

  test("at が異なる graphql 条件には document を 2 つ置く", () => {
    const a = compile({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: { at: "/query", operations: ["query"] },
      },
    });
    const b = compile({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: { at: "/doc", operations: ["mutation"] },
      },
    });
    const witness = matchIntersectionWitness(a, b);
    expect(witness).not.toBeNull();
    if (witness === null) return;
    expect(accepts(a, witness)).toBe(true);
    expect(accepts(b, witness)).toBe(true);
  });
});

describe("targetIntersectionWitness", () => {
  test("ホストとポートの組を返す", () => {
    const witness = targetIntersectionWitness(
      targets("a.example.com"),
      targets("*.example.com:8443"),
    );
    expect(witness).toEqual({ host: "a.example.com", port: 8443 });
    expect(describeTargetAddress(witness as never)).toBe("a.example.com:8443");
  });

  test("ワイルドカードどうしなら狭い側からホストを作る", () => {
    const witness = targetIntersectionWitness(
      targets("*.gcr.io"),
      targets("*.io:443"),
    );
    expect(witness).toEqual({ host: "x.gcr.io", port: 443 });
  });

  test("交差しないなら null を返す", () => {
    expect(
      targetIntersectionWitness(
        targets("a.example.com"),
        targets("b.example.com"),
      ),
    ).toBeNull();
  });
});
