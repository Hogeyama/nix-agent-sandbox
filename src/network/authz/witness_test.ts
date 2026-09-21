import { describe, expect, test } from "bun:test";
import { buildGraphqlDocuments } from "./graphql.ts";
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
      "no body condition",
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
    expect(describeRequest(witness as never)[1]).toBe("body: length 0");
  });

  test("graphql の証人は共通末端の鎖と両方の必須引数を置く", () => {
    const a = compile({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: {
          operations: ["query", "mutation"],
          fieldPaths: ["/repository/issues/nodes/body"],
          fieldArguments: { "/repository": { owner: ["my-org", "other"] } },
        },
      },
    });
    const b = compile({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: {
          operations: ["query"],
          fieldPaths: ["/repository/issues/nodes/body", "/organization/login"],
          fieldArguments: {
            "/repository": { owner: ["other", "third"] },
            "/repository/issues": { first: ["10"] },
          },
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
      value: {
        query:
          'query { repository(owner: "other") { issues(first: "10") { nodes { body } } } }',
      },
      documents: {
        "/query": {
          operations: ["query"],
          fields: [
            {
              path: "/repository",
              leaf: false,
              // 許可値の積集合から選ぶ。`my-org` は b が許さない。
              argumentValues: { owner: "other" },
              unresolvedArguments: [],
            },
            {
              path: "/repository/issues",
              leaf: false,
              // 片方だけが要求する引数もその出現に置く。
              argumentValues: { first: "10" },
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
          ],
        },
      },
    });
  });

  test("表示用の query を参照 parser で再解析しても両条件が真になる", () => {
    // 表示する文字列と facts が同じ選択・同じ引数を表すことの検証。ずれると
    // 「この例なら直せる」と言いながら直しても直らない設定エラーになる。
    const a = compile({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: {
          operations: ["query"],
          fieldPaths: ["/repository/object/text", "/repository/nameWithOwner"],
          fieldArguments: { "/repository": { owner: ["my-org"] } },
        },
      },
    });
    const b = compile({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: {
          operations: ["query"],
          fieldPaths: ["/repository/object/text"],
          fieldArguments: {
            "/repository/object": { expression: ['HEAD:"R"EADME\\.md'] },
          },
        },
      },
    });
    const witness = matchIntersectionWitness(a, b);
    expect(witness).not.toBeNull();
    if (witness === null || witness.body.kind !== "json") return;
    const documents = buildGraphqlDocuments(witness.body.value, ["/query"], {
      maxNodes: 10_000,
      maxDepth: 16,
    });
    expect(documents["/query"]).toEqual(
      witness.body.documents?.["/query"] as never,
    );
    const reparsed = {
      ...witness,
      body: { ...witness.body, documents },
    };
    expect(accepts(a, reparsed)).toBe(true);
    expect(accepts(b, reparsed)).toBe(true);
  });

  test("共通末端を順に試し、引数が矛盾する候補は飛ばす", () => {
    const a = compile({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: {
          operations: ["query"],
          fieldPaths: ["/organization/login", "/repository/nameWithOwner"],
          fieldArguments: { "/organization": { login: ["a"] } },
        },
      },
    });
    const b = compile({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: {
          operations: ["query"],
          fieldPaths: ["/organization/login", "/repository/nameWithOwner"],
          fieldArguments: { "/organization": { login: ["b"] } },
        },
      },
    });
    const witness = matchIntersectionWitness(a, b);
    expect(witness).not.toBeNull();
    if (witness === null || witness.body.kind !== "json") return;
    expect(witness.body.value).toEqual({
      query: "query { repository { nameWithOwner } }",
    });
    expect(accepts(a, witness)).toBe(true);
    expect(accepts(b, witness)).toBe(true);
  });

  test("どの共通末端でも引数が矛盾すれば証人は null になる", () => {
    // null は「証人を作れなかった」であって「交差しない」ではない。
    const gql = (login: string) =>
      compile({
        paths: ["/graphql"],
        body: {
          format: "json",
          graphql: {
            operations: ["query"],
            fieldPaths: ["/organization/login"],
            fieldArguments: { "/organization": { login: [login] } },
          },
        },
      });
    expect(matchIntersectionWitness(gql("a"), gql("b"))).toBeNull();
  });

  test("at が異なる graphql 条件には document を 2 つ置く", () => {
    const a = compile({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: {
          at: "/query",
          operations: ["query"],
          fieldPaths: ["/repository/nameWithOwner"],
        },
      },
    });
    const b = compile({
      paths: ["/graphql"],
      body: {
        format: "json",
        graphql: {
          at: "/doc",
          operations: ["mutation"],
          fieldPaths: ["/createIssue/issue/id"],
        },
      },
    });
    const witness = matchIntersectionWitness(a, b);
    expect(witness).not.toBeNull();
    if (witness === null || witness.body.kind !== "json") return;
    expect(witness.body.value).toEqual({
      query: "query { repository { nameWithOwner } }",
      doc: "mutation { createIssue { issue { id } } }",
    });
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
