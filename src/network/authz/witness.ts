/**
 * 証人リクエストの構成。
 *
 * 設計「設定エラーの提示」に対応する。受理集合の交差を理由とするエラーは、関係
 * だけを述べても書き手が直せない。交差すると判定した経路から、両方に一致する
 * 具体的なリクエストを 1 つ構成して提示する。
 *
 * 構成は交差判定の裏返しである。メソッドは交差した集合から 1 つ選ぶ。パスは交差
 * したパターンの組から、位置ごとにリテラルがあればそれを、制約付き capture が
 * あればその先頭の要素を、それ以外は `x` を置いて構成する。`**` には交差に必要な
 * 数だけセグメントを置く。ボディは条件を満たす最小の骨格を JSON として構成する。
 *
 * 構造的に矛盾する Pointer 条件 (`/a` と `/a/b`) は交差判定が検出しないので、
 * 証人を作れないことがある。そのときは null を返す。関係だけを述べたエラーに
 * 落とす想定で、判定そのものは変えない。
 */

import {
  type CompiledPath,
  joinPath,
  type SegmentSet,
  segmentSetIntersectionSample,
  segmentSetSample,
  WITNESS_SEGMENT,
} from "./pattern.ts";
import {
  type CompiledMatch,
  hostPatternsIntersect,
  type NormalizedBody,
  type NormalizedGraphql,
  pathPatternsIntersect,
  portsIntersect,
  scalarKey,
  targetsIntersect,
} from "./relation.ts";
import type {
  AuthzRequest,
  BodyFormat,
  GraphqlDocument,
  JsonScalar,
  JsonValue,
  RequestBody,
  Target,
  TargetAddress,
} from "./types.ts";

const DEFAULT_METHOD = "GET";
const DEFAULT_ROOT_FIELD = "field";
const DEFAULT_PORT = 443;

/**
 * 両方の `match` に一致するリクエストを 1 つ構成する。
 * 交差しないと判定される組、および証人を構成できない組では null を返す。
 */
export function matchIntersectionWitness(
  a: CompiledMatch,
  b: CompiledMatch,
): AuthzRequest | null {
  const method = methodWitness(a.methods, b.methods);
  if (method === null) return null;
  const path = pathWitness(a.paths, b.paths);
  if (path === null) return null;
  const body = bodyWitness(a.body, b.body);
  if (body === null) return null;
  return { method, path, body };
}

/** 両方のスコープに属するターゲットを 1 つ構成する。 */
export function targetIntersectionWitness(
  a: readonly Target[],
  b: readonly Target[],
): TargetAddress | null {
  for (const ta of a) {
    for (const tb of b) {
      if (!targetsIntersect(ta, tb)) continue;
      const host = hostWitness(ta, tb);
      if (host === null) continue;
      const port = ta.port ?? tb.port ?? DEFAULT_PORT;
      return { host, port };
    }
  }
  return null;
}

export function describeRequest(request: AuthzRequest): readonly string[] {
  return [`${request.method} ${request.path}`, describeBody(request.body)];
}

export function describeTargetAddress(address: TargetAddress): string {
  return `${address.host}:${address.port}`;
}

function describeBody(body: RequestBody): string {
  switch (body.kind) {
    case "absent":
      return "ボディ条件なし";
    case "empty":
      return "ボディ: 長さ 0";
    case "binary":
      return "ボディ: JSON として解析できない任意のバイト列";
    case "json":
      return `ボディ: ${JSON.stringify(body.value)}`;
  }
}

// ---------------------------------------------------------------- メソッド

function methodWitness(
  a: readonly string[] | null,
  b: readonly string[] | null,
): string | null {
  if (a === null && b === null) return DEFAULT_METHOD;
  if (a === null) return b?.[0] ?? null;
  if (b === null) return a[0] ?? null;
  return a.find((method) => b.includes(method)) ?? null;
}

// -------------------------------------------------------------------- パス

function pathWitness(
  a: readonly CompiledPath[],
  b: readonly CompiledPath[],
): string | null {
  for (const pa of a) {
    for (const pb of b) {
      if (!pathPatternsIntersect(pa, pb)) continue;
      const tokens = pathPatternWitness(pa, pb);
      if (tokens !== null) return joinPath(tokens);
    }
  }
  return null;
}

function pathPatternWitness(
  a: CompiledPath,
  b: CompiledPath,
): readonly string[] | null {
  const m = a.segments.length;
  const n = b.segments.length;
  // 交差する組では、短い側の長さまでが両方の制約を受ける位置である。
  const shared = Math.min(m, n);
  const total = Math.max(m, n);
  const tokens: string[] = [];

  for (let index = 0; index < shared; index++) {
    const token = segmentSetIntersectionSample(
      a.segments[index] as SegmentSet,
      b.segments[index] as SegmentSet,
    );
    if (token === null) return null;
    tokens.push(token);
  }
  // `**` が吸収する余りの位置は、有限長の側のセグメント集合から埋める。
  const longer = m >= n ? a : b;
  for (let index = shared; index < total; index++) {
    const token = segmentSetSample(longer.segments[index] as SegmentSet);
    if (token === null) return null;
    tokens.push(token);
  }
  // どちらも `**` だけで、置くセグメントが 1 つも残らない組では空文字列になる。
  // `**` は 0 個以上に一致するので、読める形にセグメントを 1 つ足しておく。
  if (joinPath(tokens) === "" && a.trailingDoubleStar && b.trailingDoubleStar) {
    tokens.push(WITNESS_SEGMENT);
  }
  return tokens;
}

// ------------------------------------------------------------------ ボディ

function bodyWitness(a: NormalizedBody, b: NormalizedBody): RequestBody | null {
  const format = intersectFormat(a.format, b.format);
  if (format === undefined) return null;
  if (format === null) return { kind: "absent" };
  if (format === "none") return { kind: "empty" };

  const value: Record<string, JsonValue> = {};
  const documents: Record<string, GraphqlDocument> = {};

  for (const [pointer, values] of mergedPointers(a, b)) {
    const scalar = values[0];
    if (scalar === undefined) return null;
    if (!setPointer(value, pointer, scalar)) return null;
  }

  const graphqlDocuments = mergedGraphql(a.graphql, b.graphql);
  if (graphqlDocuments === null) return null;
  for (const document of graphqlDocuments) {
    if (!setPointer(value, document.at, document.text)) return null;
    documents[document.at] = document.facts;
  }

  return { kind: "json", value, documents };
}

/**
 * format の交差。undefined は交差しない (`"json"` と `"none"`)、
 * null は「ボディ条件なし」を意味する。
 */
function intersectFormat(
  a: BodyFormat | null,
  b: BodyFormat | null,
): BodyFormat | null | undefined {
  if (a === null) return b;
  if (b === null) return a;
  if (a === b) return a;
  if (a === "opaque") return b;
  if (b === "opaque") return a;
  return undefined;
}

function mergedPointers(
  a: NormalizedBody,
  b: NormalizedBody,
): ReadonlyMap<string, readonly JsonScalar[]> {
  const merged = new Map<string, readonly JsonScalar[]>();
  for (const [pointer, values] of a.pointers) merged.set(pointer, values);
  for (const [pointer, values] of b.pointers) {
    const existing = merged.get(pointer);
    if (existing === undefined) {
      merged.set(pointer, values);
      continue;
    }
    const keys = new Set(values.map(scalarKey));
    merged.set(
      pointer,
      existing.filter((value) => keys.has(scalarKey(value))),
    );
  }
  return merged;
}

interface WitnessDocument {
  readonly at: string;
  readonly facts: GraphqlDocument;
  /** `at` の位置に置く document の文字列表現。 */
  readonly text: string;
}

/**
 * 満たすべき GraphQL document を列挙する。`at` が同じ 2 つは 1 つの document で
 * 両方を満たす。`at` が違う 2 つは、それぞれの位置に別の document を置く。
 * どれか 1 つでも構成できなければ null を返す。
 */
function mergedGraphql(
  a: NormalizedGraphql | null,
  b: NormalizedGraphql | null,
): readonly WitnessDocument[] | null {
  const requested: readonly (readonly [
    NormalizedGraphql,
    NormalizedGraphql | null,
  ])[] =
    a === null && b === null
      ? []
      : a === null
        ? [[b as NormalizedGraphql, null]]
        : b === null
          ? [[a, null]]
          : a.at === b.at
            ? [[a, b]]
            : [
                [a, null],
                [b, null],
              ];

  const documents: WitnessDocument[] = [];
  for (const [first, second] of requested) {
    const document = documentFor(first, second);
    if (document === null) return null;
    documents.push(document);
  }
  return documents;
}

function documentFor(
  a: NormalizedGraphql,
  b: NormalizedGraphql | null,
): WitnessDocument | null {
  const operation =
    b === null
      ? a.operations[0]
      : a.operations.find((candidate) => b.operations.includes(candidate));
  if (operation === undefined) return null;

  const rootField = pickRootField(a.rootFields, b?.rootFields ?? null);
  if (rootField === null) return null;

  // 引数は置かない。`arguments` は「その引数が現れるなら値はこの集合」という
  // 条件なので、引数を持たない document は両方の制約を満たす。relation.ts が
  // `arguments` を交差の否定に使わないのと同じ判断である。
  const facts: GraphqlDocument = {
    operations: [operation],
    rootFields: [rootField],
    argumentValues: {},
  };
  return {
    at: a.at,
    facts,
    text: `${operation} { ${rootField} { __typename } }`,
  };
}

function pickRootField(
  a: readonly string[] | null,
  b: readonly string[] | null,
): string | null {
  if (a === null && b === null) return DEFAULT_ROOT_FIELD;
  if (a === null) return b?.[0] ?? null;
  if (b === null) return a[0] ?? null;
  return a.find((field) => b.includes(field)) ?? null;
}

/**
 * JSON Pointer の位置にスカラーを置く。途中の位置がすでに別の型で埋まっている
 * 場合や、同じ位置に別の値を要求された場合は false を返す。
 */
function setPointer(
  root: Record<string, JsonValue>,
  pointer: string,
  value: JsonScalar,
): boolean {
  if (!pointer.startsWith("/")) return false;
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current = root;
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index] as string;
    const next = current[token];
    if (next === undefined) {
      const created: Record<string, JsonValue> = {};
      current[token] = created;
      current = created;
      continue;
    }
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return false;
    }
    current = next as Record<string, JsonValue>;
  }
  const last = tokens[tokens.length - 1] as string;
  const existing = current[last];
  if (existing !== undefined) {
    return (
      typeof existing !== "object" &&
      existing !== null &&
      scalarKey(existing) === scalarKey(value)
    );
  }
  current[last] = value;
  return true;
}

// -------------------------------------------------------------- ターゲット

function hostWitness(a: Target, b: Target): string | null {
  if (!hostPatternsIntersect(a.host, b.host)) return null;
  if (!portsIntersect(a.port, b.port)) return null;
  // 入れ子か素かのどちらかなので、狭い側を選べば両方に属する。
  const narrower = a.host.kind === "exact" ? a.host : b.host;
  if (narrower.kind === "exact") return narrower.host;
  const suffixA = a.host.kind === "suffix" ? a.host.suffix : "";
  const suffixB = b.host.kind === "suffix" ? b.host.suffix : "";
  const suffix = suffixA.length >= suffixB.length ? suffixA : suffixB;
  return `${WITNESS_SEGMENT}.${suffix}`;
}
