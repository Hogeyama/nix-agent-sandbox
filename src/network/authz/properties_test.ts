/**
 * 交差・包含・特異度・証人のプロパティテスト。
 *
 * 段階 0 の本命の安全網である。判定の誤りは「理不尽な設定エラー」か「静かな認可の
 * 緩み」のどちらかになり、実データでは気づけない。実際 `.nas/config.pkl` は 40 ホスト
 * のベタ allow がほとんどでルールが無く、通しても検査器はほとんど動かない。
 *
 * 依存を増やさないため `fast-check` は使わず、seeded PRNG で生成器を手書きする。
 *
 * 健全性は「生成したリクエストの有限世界」に対して検査する。世界を有限にしても
 * 検出力が落ちないのは、誤りの向きが片方だけだからである。「交差しない」「包含する」
 * と結論した場合だけが反証の対象であり、その反例はこの世界に現れる。
 */

import { describe, expect, test } from "bun:test";
import {
  type CompiledMatch,
  compileMatch,
  matchesIntersect,
  matchSubsumes,
} from "./relation.ts";
import { accepts } from "./semantics.ts";
import { compareSpecificity } from "./specificity.ts";
import type {
  AuthzRequest,
  BodyMatch,
  GraphqlOperation,
  JsonScalar,
  Match,
  RequestBody,
} from "./types.ts";
import { matchIntersectionWitness } from "./witness.ts";

// ------------------------------------------------------------------- 生成器

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function pickSome<T>(rng: Rng, items: readonly T[]): T[] {
  const chosen = items.filter(() => rng() < 0.5);
  return chosen.length === 0 ? [pick(rng, items)] : chosen;
}

const METHOD_ALPHABET = ["GET", "POST", "PUT"] as const;
const PATTERN_SEGMENTS = ["a", "b", "*", "{n}", "{m}"] as const;
const CAPTURE_VALUES = ["a", "b", "c"] as const;
const POINTERS = ["/a", "/b", "/meta/kind"] as const;
const POINTER_VALUES: readonly JsonScalar[] = [1, 2, "x"];
const GRAPHQL_AT = ["/query", "/q2"] as const;
const OPERATIONS: readonly GraphqlOperation[] = ["query", "mutation"];
const ROOT_FIELDS = ["f", "g"] as const;
const ARGUMENT_VALUES = ["v1", "v2"] as const;

function genPathPattern(rng: Rng): string {
  const length = 1 + Math.floor(rng() * 3);
  const parts: string[] = [];
  const used = new Set<string>();
  for (let index = 0; index < length; index++) {
    let segment: string = pick(rng, PATTERN_SEGMENTS);
    if (segment.startsWith("{")) {
      // capture 名は 1 つのパターン内で重複できない。
      if (used.has(segment)) segment = "*";
      else used.add(segment);
    }
    parts.push(segment);
  }
  const trailing = rng() < 0.3 ? "/**" : "";
  return `/${parts.join("/")}${trailing}`;
}

function genBody(rng: Rng): BodyMatch | undefined {
  if (rng() < 0.3) return undefined;
  const format = pick(rng, ["none", "json", "opaque"] as const);
  if (format !== "json") return { format };

  const body: {
    format: "json";
    oneOf?: Record<string, readonly JsonScalar[]>;
    graphql?: BodyMatch["graphql"];
  } = { format };

  if (rng() < 0.5) {
    const oneOf: Record<string, readonly JsonScalar[]> = {};
    for (const pointer of pickSome(rng, POINTERS)) {
      oneOf[pointer] = pickSome(rng, POINTER_VALUES);
    }
    body.oneOf = oneOf;
  }
  if (rng() < 0.4) {
    const args: Record<string, readonly string[]> = {};
    if (rng() < 0.5) args.login = pickSome(rng, ARGUMENT_VALUES);
    body.graphql = {
      at: pick(rng, GRAPHQL_AT),
      operations: pickSome(rng, OPERATIONS),
      ...(rng() < 0.5 ? { rootFields: pickSome(rng, ROOT_FIELDS) } : {}),
      arguments: args,
    };
  }
  return body as BodyMatch;
}

function genMatch(rng: Rng): Match {
  const paths = [genPathPattern(rng)];
  if (rng() < 0.3) paths.push(genPathPattern(rng));

  const captures: Record<string, readonly string[]> = {};
  for (const name of ["n", "m"]) {
    if (rng() < 0.5) captures[name] = pickSome(rng, CAPTURE_VALUES);
  }

  return {
    ...(rng() < 0.7 ? { methods: pickSome(rng, METHOD_ALPHABET) } : {}),
    paths,
    captures,
    ...(() => {
      const body = genBody(rng);
      return body === undefined ? {} : { body };
    })(),
  };
}

/**
 * 既存の match を 1 軸だけ書き換える。
 *
 * 独立に引いた 2 つの match はまず比較可能にならず、包含を前提とするプロパティ
 * (推移性・反対称性) が空回りする。近い形の match を作って前提を成立させる。
 * 書き換えは意味論を見ずに構文をいじるだけなので、どちらが広いかの判断を
 * テスト側に持ち込まない。
 */
function mutateMatch(rng: Rng, match: Match): Match {
  switch (Math.floor(rng() * 4)) {
    case 0:
      return rng() < 0.4
        ? { ...match, methods: undefined }
        : { ...match, methods: pickSome(rng, METHOD_ALPHABET) };
    case 1: {
      const index = Math.floor(rng() * match.paths.length);
      const paths = match.paths.map((path, at) =>
        at === index ? mutatePathPattern(rng, path) : path,
      );
      if (rng() < 0.2) paths.push(genPathPattern(rng));
      return { ...match, paths };
    }
    case 2: {
      const captures: Record<string, readonly string[]> = { ...match.captures };
      const name = pick(rng, ["n", "m"]);
      if (rng() < 0.3) delete captures[name];
      else captures[name] = pickSome(rng, CAPTURE_VALUES);
      return { ...match, captures };
    }
    default:
      return { ...match, body: mutateBody(rng, match.body) };
  }
}

function mutatePathPattern(rng: Rng, pattern: string): string {
  const hadTrailing = pattern.endsWith("/**");
  const core = hadTrailing ? pattern.slice(0, -3) : pattern;
  const tokens = core.split("/").slice(1);
  if (tokens.length === 0) return pattern;

  if (rng() < 0.7) {
    const index = Math.floor(rng() * tokens.length);
    const replacement: string = pick(rng, PATTERN_SEGMENTS);
    tokens[index] = replacement;
    if (
      replacement.startsWith("{") &&
      tokens.filter((token) => token === replacement).length > 1
    ) {
      tokens[index] = "*";
    }
    return `/${tokens.join("/")}${hadTrailing ? "/**" : ""}`;
  }
  // `**` の有無を反転する。
  return `/${tokens.join("/")}${hadTrailing ? "" : "/**"}`;
}

function mutateBody(
  rng: Rng,
  body: BodyMatch | undefined,
): BodyMatch | undefined {
  if (body === undefined || rng() < 0.3) return genBody(rng);
  if (rng() < 0.4) {
    // `format` が `"json"` でないボディに値条件を併記するのは設定エラーなので、
    // 検査器に渡らない形は生成しない。
    const format = pick(rng, ["none", "json", "opaque"] as const);
    return format === "json" ? { ...body, format } : { format };
  }
  if (body.oneOf !== undefined && rng() < 0.5) {
    const pointer = pick(rng, Object.keys(body.oneOf));
    return {
      ...body,
      oneOf: { ...body.oneOf, [pointer]: pickSome(rng, POINTER_VALUES) },
    };
  }
  if (body.format !== "json") return body;
  const graphql = body.graphql;
  if (graphql === undefined) return { ...body, graphql: genBody(rng)?.graphql };
  switch (Math.floor(rng() * 3)) {
    case 0:
      return {
        ...body,
        graphql: { ...graphql, operations: pickSome(rng, OPERATIONS) },
      };
    case 1:
      return {
        ...body,
        graphql: {
          ...graphql,
          rootFields: rng() < 0.3 ? undefined : pickSome(rng, ROOT_FIELDS),
        },
      };
    default:
      return {
        ...body,
        graphql: {
          ...graphql,
          arguments:
            rng() < 0.3 ? {} : { login: pickSome(rng, ARGUMENT_VALUES) },
        },
      };
  }
}

interface Sample {
  readonly source: Match;
  readonly compiled: CompiledMatch;
}

function toSample(source: Match): Sample {
  const compiled = compileMatch(source);
  if (!compiled.ok) {
    throw new Error(`生成した match を解析できない: ${compiled.error}`);
  }
  return { source, compiled: compiled.value };
}

function genSample(rng: Rng): Sample {
  return toSample(genMatch(rng));
}

/** 4 割は独立な 2 本、6 割は片方を書き換えた近い 2 本。 */
function genPair(rng: Rng): readonly [Sample, Sample] {
  const first = genMatch(rng);
  const second = rng() < 0.4 ? genMatch(rng) : mutateMatch(rng, first);
  return [toSample(first), toSample(second)];
}

function genTriple(rng: Rng): readonly [Sample, Sample, Sample] {
  const first = genMatch(rng);
  const second = mutateMatch(rng, first);
  const third = mutateMatch(rng, second);
  return [toSample(first), toSample(second), toSample(third)];
}

function describeSample(sample: Sample): string {
  return JSON.stringify(sample.source);
}

// --------------------------------------------------------- リクエストの世界

function requestPaths(): readonly string[] {
  const alphabet = ["a", "b"];
  const paths: string[] = [];
  for (const first of alphabet) {
    paths.push(`/${first}`);
    for (const second of alphabet) {
      paths.push(`/${first}/${second}`);
      for (const third of alphabet) paths.push(`/${first}/${second}/${third}`);
    }
  }
  return paths;
}

const DOCUMENT_TEXT = "query { f { __typename } }";

const REQUEST_BODIES: readonly RequestBody[] = [
  { kind: "absent" },
  { kind: "empty" },
  { kind: "binary" },
  { kind: "json", value: {} },
  { kind: "json", value: { a: 1 } },
  { kind: "json", value: { a: 2, b: 1 } },
  { kind: "json", value: { a: "x", b: 2 } },
  { kind: "json", value: { meta: { kind: "x" } } },
  // Pointer の対象がスカラーでない。判定不能になる。
  { kind: "json", value: { a: { nested: 1 } } },
  // graphql.at の対象が文字列でない。判定不能になる。
  { kind: "json", value: { query: 1 } },
  {
    kind: "json",
    value: { query: DOCUMENT_TEXT },
    documents: {
      "/query": {
        operations: ["query"],
        rootFields: ["f"],
        argumentValues: { login: ["v1"] },
      },
    },
  },
  {
    kind: "json",
    value: { query: DOCUMENT_TEXT },
    documents: {
      "/query": {
        operations: ["mutation"],
        rootFields: ["g"],
        argumentValues: { login: ["v2"] },
      },
    },
  },
  {
    kind: "json",
    value: { query: DOCUMENT_TEXT, a: 1 },
    documents: {
      "/query": {
        operations: ["query", "mutation"],
        rootFields: ["f", "g"],
        argumentValues: {},
      },
    },
  },
  {
    kind: "json",
    value: { q2: DOCUMENT_TEXT },
    documents: {
      "/q2": { operations: ["query"], rootFields: ["f"], argumentValues: {} },
    },
  },
];

const REQUESTS: readonly AuthzRequest[] = (() => {
  const requests: AuthzRequest[] = [];
  for (const method of ["GET", "POST"]) {
    for (const path of requestPaths()) {
      for (const body of REQUEST_BODIES) requests.push({ method, path, body });
    }
  }
  return requests;
})();

function describeRequestValue(request: AuthzRequest): string {
  return `${request.method} ${request.path} ${JSON.stringify(request.body)}`;
}

// ------------------------------------------------------------- プロパティ

const PAIR_COUNT = 400;
const TRIPLE_COUNT = 600;

describe("交差と包含のプロパティ", () => {
  test("反射性: どの match も自分自身を包含する", () => {
    const rng = makeRng(1);
    for (let index = 0; index < PAIR_COUNT; index++) {
      const sample = genSample(rng);
      if (!matchSubsumes(sample.compiled, sample.compiled)) {
        throw new Error(`A ⊆ A が成り立たない: ${describeSample(sample)}`);
      }
    }
  });

  test("包含の健全性: A ⊆ B なら A が受理するリクエストは B も受理する", () => {
    const rng = makeRng(2);
    let subsumptions = 0;
    for (let index = 0; index < PAIR_COUNT; index++) {
      const [a, b] = genPair(rng);
      if (!matchSubsumes(a.compiled, b.compiled)) continue;
      subsumptions++;
      for (const request of REQUESTS) {
        if (!accepts(a.compiled, request)) continue;
        if (accepts(b.compiled, request)) continue;
        throw new Error(
          [
            "包含が健全でない",
            `A: ${describeSample(a)}`,
            `B: ${describeSample(b)}`,
            `A だけが受理: ${describeRequestValue(request)}`,
          ].join("\n"),
        );
      }
    }
    // 前提が一度も成り立たないと検査が空回りする。
    expect(subsumptions).toBeGreaterThan(10);
  });

  test("交差の健全性: 交差しないなら両方に一致するリクエストは存在しない", () => {
    const rng = makeRng(3);
    let disjoint = 0;
    for (let index = 0; index < PAIR_COUNT; index++) {
      const [a, b] = genPair(rng);
      if (matchesIntersect(a.compiled, b.compiled)) continue;
      disjoint++;
      for (const request of REQUESTS) {
        if (!accepts(a.compiled, request)) continue;
        if (!accepts(b.compiled, request)) continue;
        throw new Error(
          [
            "交差しないと判定したのに両方が受理する",
            `A: ${describeSample(a)}`,
            `B: ${describeSample(b)}`,
            `両方が受理: ${describeRequestValue(request)}`,
          ].join("\n"),
        );
      }
    }
    expect(disjoint).toBeGreaterThan(10);
  });

  test("推移性: A ⊆ B かつ B ⊆ C なら A ⊆ C", () => {
    const rng = makeRng(4);
    let premises = 0;
    for (let index = 0; index < TRIPLE_COUNT; index++) {
      const [a, b, c] = genTriple(rng);
      if (!matchSubsumes(a.compiled, b.compiled)) continue;
      if (!matchSubsumes(b.compiled, c.compiled)) continue;
      premises++;
      if (matchSubsumes(a.compiled, c.compiled)) continue;
      throw new Error(
        [
          "包含が推移的でない。評価順の定義が崩れる",
          `A: ${describeSample(a)}`,
          `B: ${describeSample(b)}`,
          `C: ${describeSample(c)}`,
        ].join("\n"),
      );
    }
    expect(premises).toBeGreaterThan(10);
  });

  test("反対称性: A ⊆ B かつ B ⊆ A なら受理集合が等しい", () => {
    const rng = makeRng(5);
    let equivalences = 0;
    for (let index = 0; index < PAIR_COUNT; index++) {
      const [a, b] = genPair(rng);
      if (compareSpecificity(a.compiled, b.compiled) !== "equivalent") continue;
      equivalences++;
      for (const request of REQUESTS) {
        if (accepts(a.compiled, request) === accepts(b.compiled, request))
          continue;
        throw new Error(
          [
            "互いに包含するのに受理集合が違う",
            `A: ${describeSample(a)}`,
            `B: ${describeSample(b)}`,
            `食い違い: ${describeRequestValue(request)}`,
          ].join("\n"),
        );
      }
    }
    expect(equivalences).toBeGreaterThan(10);
  });

  test("証人の妥当性: 交差すると判定したら、構成した証人が両方に一致する", () => {
    const rng = makeRng(6);
    let witnesses = 0;
    for (let index = 0; index < PAIR_COUNT; index++) {
      const [a, b] = genPair(rng);
      if (!matchesIntersect(a.compiled, b.compiled)) continue;
      const witness = matchIntersectionWitness(a.compiled, b.compiled);
      if (witness === null) {
        throw new Error(
          [
            "交差すると判定したのに証人を構成できない",
            `A: ${describeSample(a)}`,
            `B: ${describeSample(b)}`,
          ].join("\n"),
        );
      }
      witnesses++;
      if (accepts(a.compiled, witness) && accepts(b.compiled, witness))
        continue;
      throw new Error(
        [
          "証人がどちらかに一致しない",
          `A: ${describeSample(a)} → ${accepts(a.compiled, witness)}`,
          `B: ${describeSample(b)} → ${accepts(b.compiled, witness)}`,
          `証人: ${describeRequestValue(witness)}`,
        ].join("\n"),
      );
    }
    expect(witnesses).toBeGreaterThan(10);
  });
});
