import { describe, expect, test } from "bun:test";
import {
  bodiesIntersect,
  bodySubsumes,
  type CompiledMatch,
  compileMatch,
  hostMatches,
  matchesIntersect,
  matchSubsumes,
  methodsIntersect,
  methodsSubsume,
  normalizeBody,
  parseTarget,
  targetSetsIntersect,
  targetSetsSubsume,
} from "./relation.ts";
import type { BodyMatch, Match, Target } from "./types.ts";

function compile(match: Match): CompiledMatch {
  const compiled = compileMatch(match);
  if (!compiled.ok) throw new Error(compiled.error);
  return compiled.value;
}

function target(source: string): Target {
  const parsed = parseTarget(source);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const body = (value: BodyMatch | undefined) => normalizeBody(value);

describe("メソッド", () => {
  test("省略は全メソッドの集合として扱う", () => {
    expect(methodsSubsume(["GET"], null)).toBe(true);
    expect(methodsSubsume(null, ["GET"])).toBe(false);
    expect(methodsIntersect(null, ["GET"])).toBe(true);
    expect(methodsIntersect(["GET"], ["POST"])).toBe(false);
  });

  test("綴りの大小は畳む", () => {
    // リクエスト側のメソッドは大文字に揃えて渡ってくる。設定側を揃えないと、
    // 小文字で書いたルールが 1 度も発火しないまま黙って消える。
    expect(compile({ methods: ["post"], paths: ["/**"] }).methods).toEqual([
      "POST",
    ]);
  });

  test("大小だけが違う綴りは同じ 1 つのメソッドになる", () => {
    expect(
      compile({ methods: ["post", "POST", "Post"], paths: ["/**"] }).methods,
    ).toEqual(["POST"]);
  });

  test("大小だけが違う 2 つのルールは同じ受理集合として扱う", () => {
    const lower = compile({ methods: ["post"], paths: ["/a"] });
    const upper = compile({ methods: ["POST"], paths: ["/a"] });
    expect(matchesIntersect(lower, upper)).toBe(true);
    expect(matchSubsumes(lower, upper)).toBe(true);
    expect(matchSubsumes(upper, lower)).toBe(true);
  });
});

describe("パス", () => {
  test("どちらも ** を持たないなら長さが等しいときだけ関係する", () => {
    const short = compile({ paths: ["/a"] });
    const long = compile({ paths: ["/a/b"] });
    expect(matchesIntersect(short, long)).toBe(false);
    expect(matchSubsumes(short, long)).toBe(false);
  });

  test("** を持つ側は有限長のパターンに包含されない", () => {
    const deep = compile({ paths: ["/a/**"] });
    const exact = compile({ paths: ["/a/b"] });
    expect(matchesIntersect(deep, exact)).toBe(true);
    expect(matchSubsumes(deep, exact)).toBe(false);
    expect(matchSubsumes(exact, deep)).toBe(true);
  });

  test("どちらも ** を持つなら長い側が短い側に包含されうる", () => {
    const wide = compile({ paths: ["/a/**"] });
    const narrow = compile({ paths: ["/a/b/**"] });
    expect(matchSubsumes(narrow, wide)).toBe(true);
    expect(matchSubsumes(wide, narrow)).toBe(false);
  });

  test("capture の制約は言語を狭める", () => {
    const constrained = compile({
      paths: ["/repos/{org}"],
      captures: { org: ["my-org"] },
    });
    const free = compile({ paths: ["/repos/*"] });
    expect(matchSubsumes(constrained, free)).toBe(true);
    expect(matchSubsumes(free, constrained)).toBe(false);
  });

  test("合併に対する包含は不完全でよい", () => {
    // {n} を ["a","b"] に制約した 1 本は、実際には /a と /b の合併に包含される。
    // 規則はこれを包含と認めず、保守側に倒して設定エラーの側に落とす。
    const union = compile({ paths: ["/{n}"], captures: { n: ["a", "b"] } });
    const split = compile({ paths: ["/a", "/b"] });
    expect(matchSubsumes(union, split)).toBe(false);
    expect(matchesIntersect(union, split)).toBe(true);
  });
});

describe("ボディの format は格子である", () => {
  test('"opaque" は "json" と "none" の両方を包含する', () => {
    expect(
      bodySubsumes(body({ format: "json" }), body({ format: "opaque" })),
    ).toBe(true);
    expect(
      bodySubsumes(body({ format: "none" }), body({ format: "opaque" })),
    ).toBe(true);
    expect(
      bodySubsumes(body({ format: "opaque" }), body({ format: "json" })),
    ).toBe(false);
  });

  test('"json" と "none" は交わらない', () => {
    expect(
      bodiesIntersect(body({ format: "json" }), body({ format: "none" })),
    ).toBe(false);
  });

  test("ボディ条件を持たない match は opaque より広い", () => {
    expect(bodySubsumes(body({ format: "opaque" }), body(undefined))).toBe(
      true,
    );
    expect(bodySubsumes(body(undefined), body({ format: "opaque" }))).toBe(
      false,
    );
  });
});

describe("ボディの値条件", () => {
  const withPointer = (pointer: string, values: readonly (string | number)[]) =>
    body({ format: "json", oneOf: { [pointer]: values } });

  test("equals は 1 要素の oneOf として比べる", () => {
    const equals = body({ format: "json", equals: { "/a": 1 } });
    expect(bodySubsumes(equals, withPointer("/a", [1, 2]))).toBe(true);
    expect(bodySubsumes(withPointer("/a", [1, 2]), equals)).toBe(false);
  });

  test("片方にしか現れない Pointer は交差を妨げない", () => {
    expect(
      bodiesIntersect(withPointer("/a", [1]), withPointer("/b", [2])),
    ).toBe(true);
  });

  test("両方に現れる Pointer の値集合が素なら交差しない", () => {
    expect(
      bodiesIntersect(withPointer("/a", [1]), withPointer("/a", [2])),
    ).toBe(false);
  });

  test("a にしか現れない Pointer は包含を妨げない", () => {
    const narrow = body({ format: "json", oneOf: { "/a": [1], "/b": [2] } });
    const wide = withPointer("/a", [1, 2]);
    expect(bodySubsumes(narrow, wide)).toBe(true);
    expect(bodySubsumes(wide, narrow)).toBe(false);
  });

  test("Pointer どうしの構造的な矛盾は検出しない", () => {
    const scalar = withPointer("/a", ["x"]);
    const nested = withPointer("/a/b", ["y"]);
    expect(bodiesIntersect(scalar, nested)).toBe(true);
  });
});

describe("ボディの graphql", () => {
  const gql = (graphql: NonNullable<BodyMatch["graphql"]>) =>
    body({ format: "json", graphql });

  test("operations と rootFields は集合の包含で比べる", () => {
    const narrow = gql({ operations: ["query"] });
    const wide = gql({ operations: ["query", "mutation"] });
    expect(bodySubsumes(narrow, wide)).toBe(true);
    expect(bodySubsumes(wide, narrow)).toBe(false);
    expect(
      bodiesIntersect(
        gql({ operations: ["query"] }),
        gql({ operations: ["mutation"] }),
      ),
    ).toBe(false);
  });

  test("省略された rootFields は制約なしとして最も広く扱う", () => {
    const constrained = gql({
      operations: ["query"],
      rootFields: ["organization"],
    });
    const free = gql({ operations: ["query"] });
    expect(bodySubsumes(constrained, free)).toBe(true);
    expect(bodySubsumes(free, constrained)).toBe(false);
  });

  test("at が異なる 2 つは交差し、どちらも包含しない", () => {
    const a = gql({ at: "/query", operations: ["query"] });
    const b = gql({ at: "/doc", operations: ["mutation"] });
    expect(bodiesIntersect(a, b)).toBe(true);
    expect(bodySubsumes(a, b)).toBe(false);
    expect(bodySubsumes(b, a)).toBe(false);
  });

  test("arguments は包含を狭めるが、交差は否定しない", () => {
    const v1 = gql({ operations: ["query"], arguments: { login: ["v1"] } });
    const v2 = gql({ operations: ["query"], arguments: { login: ["v2"] } });
    const free = gql({ operations: ["query"] });
    expect(bodySubsumes(v1, free)).toBe(true);
    expect(bodySubsumes(free, v1)).toBe(false);
    expect(bodySubsumes(v1, v2)).toBe(false);
    // その引数を 1 つも含まない document は両方を満たすので、値集合が素でも
    // 受理集合は交差する。
    expect(bodiesIntersect(v1, v2)).toBe(true);
  });
});

describe("軸の合成", () => {
  test("3 つの軸すべてで交差するときだけ交差する", () => {
    const a = compile({
      methods: ["GET"],
      paths: ["/a"],
      body: { format: "json" },
    });
    const b = compile({
      methods: ["GET"],
      paths: ["/a"],
      body: { format: "none" },
    });
    expect(matchesIntersect(a, b)).toBe(false);
  });

  test("3 つの軸すべてで包含するときだけ包含する", () => {
    const narrow = compile({ methods: ["GET"], paths: ["/a"] });
    const wide = compile({ paths: ["/**"] });
    expect(matchSubsumes(narrow, wide)).toBe(true);
    expect(matchSubsumes(wide, narrow)).toBe(false);
  });
});

describe("ターゲット", () => {
  test("ポート付きの完全一致が最も特異である", () => {
    expect(
      targetSetsSubsume(
        [target("a.example.com:8443")],
        [target("a.example.com")],
      ),
    ).toBe(true);
    expect(
      targetSetsSubsume(
        [target("a.example.com")],
        [target("a.example.com:8443")],
      ),
    ).toBe(false);
  });

  test("サフィックスワイルドカードはラベル数が多いほど特異である", () => {
    expect(targetSetsSubsume([target("*.gcr.io")], [target("*.io")])).toBe(
      true,
    );
    expect(targetSetsSubsume([target("*.io")], [target("*.gcr.io")])).toBe(
      false,
    );
    expect(targetSetsSubsume([target("a.gcr.io")], [target("*.gcr.io")])).toBe(
      true,
    );
  });

  test("ホストとポートで包含の向きが逆になる組は交差しつつ比較不能になる", () => {
    const a = [target("a.example.com")];
    const b = [target("*.example.com:8443")];
    expect(targetSetsIntersect(a, b)).toBe(true);
    expect(targetSetsSubsume(a, b)).toBe(false);
    expect(targetSetsSubsume(b, a)).toBe(false);
  });

  test("素なホストどうしは交差しない", () => {
    expect(
      targetSetsIntersect([target("a.example.com")], [target("*.other.com")]),
    ).toBe(false);
  });

  test("ワイルドカードは 1 ラベル以上に一致し、サフィックス自身は含まない", () => {
    expect(
      targetSetsIntersect([target("*.example.com")], [target("example.com")]),
    ).toBe(false);
  });

  test("ホストの綴りの大小は畳む", () => {
    // リクエストのホストは小文字に揃えて渡ってくる。
    expect(target("API.Example.COM").host).toEqual({
      kind: "exact",
      host: "api.example.com",
    });
    expect(target("*.GCR.io").host).toEqual({
      kind: "suffix",
      suffix: "gcr.io",
    });
    expect(hostMatches(target("API.Example.COM").host, "api.example.com")).toBe(
      true,
    );
    expect(hostMatches(target("*.GCR.io").host, "a.gcr.io")).toBe(true);
  });

  test("大小だけが違う 2 つのターゲットは同じ 1 つのパターンとして扱う", () => {
    // 素な 2 つと見なされると、包含で決まるはずの特異度の順序が壊れる。
    const upper = [target("API.example.com")];
    const lower = [target("api.example.com")];
    expect(targetSetsIntersect(upper, lower)).toBe(true);
    expect(targetSetsSubsume(upper, lower)).toBe(true);
    expect(targetSetsSubsume(lower, upper)).toBe(true);
    expect(
      targetSetsSubsume([target("a.EXAMPLE.com")], [target("*.example.com")]),
    ).toBe(true);
  });

  test("元の綴りは診断のために残す", () => {
    expect(target("API.example.com:8443").source).toBe("API.example.com:8443");
  });

  test("不正なターゲットは設定エラーにする", () => {
    expect(parseTarget("api.*.com").ok).toBe(false);
    expect(parseTarget("example.com:0").ok).toBe(false);
    expect(parseTarget("example.com:https").ok).toBe(false);
  });
});
