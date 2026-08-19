/**
 * 軸ごとの交差・包含の判定と、その合成。
 *
 * 設計「選択規則 > 交差と包含の判定」に対応する。
 *
 * 判定は保守側に倒す。**証明できたときにだけ**「交差しない」「包含する」と結論し、
 * 証明できなければ「交差する」「包含しない」に倒す。どちらの倒し方も設定エラーの
 * 側に落ちるので、判定の不完全さが認可の緩みには変わらない。この向きを逆にしない。
 */

import {
  type CompiledPath,
  compilePathPattern,
  type SegmentSet,
  segmentSetSubsumes,
  segmentSetsIntersect,
} from "./pattern.ts";
import {
  type BodyFormat,
  type BodyMatch,
  DEFAULT_GRAPHQL_AT,
  type GraphqlOperation,
  type HostPattern,
  type JsonScalar,
  type Match,
  type Result,
  type Target,
} from "./types.ts";

export interface NormalizedGraphql {
  readonly at: string;
  readonly operations: readonly GraphqlOperation[];
  /** null は「制約しない」。 */
  readonly rootFields: readonly string[] | null;
  readonly argumentValues: ReadonlyMap<string, readonly string[]>;
}

export interface NormalizedBody {
  /** null は「ボディ条件を持たない」。format の格子の最上位。 */
  readonly format: BodyFormat | null;
  /** JSON Pointer → 許す値の集合。`equals` は 1 要素の `oneOf` に正規化してある。 */
  readonly pointers: ReadonlyMap<string, readonly JsonScalar[]>;
  readonly graphql: NormalizedGraphql | null;
}

export interface CompiledMatch {
  /** null は全メソッド。 */
  readonly methods: readonly string[] | null;
  readonly paths: readonly CompiledPath[];
  readonly body: NormalizedBody;
}

export function compileMatch(match: Match): Result<CompiledMatch> {
  const paths: CompiledPath[] = [];
  for (const source of match.paths) {
    const compiled = compilePathPattern(source, match.captures ?? {});
    if (!compiled.ok) return compiled;
    paths.push(compiled.value);
  }
  return {
    ok: true,
    value: {
      methods:
        match.methods === undefined
          ? null
          : unique(match.methods.map(normalizeMethod)),
      paths,
      body: normalizeBody(match.body),
    },
  };
}

export function normalizeBody(body: BodyMatch | undefined): NormalizedBody {
  if (body === undefined) {
    return { format: null, pointers: new Map(), graphql: null };
  }

  const pointers = new Map<string, readonly JsonScalar[]>();
  for (const [pointer, values] of Object.entries(body.oneOf ?? {})) {
    pointers.set(pointer, uniqueScalars(values));
  }
  for (const [pointer, value] of Object.entries(body.equals ?? {})) {
    const existing = pointers.get(pointer);
    // 同じ Pointer に equals と oneOf が両方あるなら、両方を満たす必要がある。
    pointers.set(
      pointer,
      existing === undefined
        ? [value]
        : existing.filter(
            (candidate) => scalarKey(candidate) === scalarKey(value),
          ),
    );
  }

  const graphql = body.graphql;
  return {
    format: body.format,
    pointers,
    graphql:
      graphql === undefined
        ? null
        : {
            at: graphql.at ?? DEFAULT_GRAPHQL_AT,
            operations: unique(graphql.operations),
            rootFields:
              graphql.rootFields === undefined
                ? null
                : unique(graphql.rootFields),
            argumentValues: new Map(
              Object.entries(graphql.arguments ?? {}).map(([name, values]) => [
                name,
                unique(values),
              ]),
            ),
          },
  };
}

// ---------------------------------------------------------------- メソッド

/**
 * メソッドの綴りを畳む。
 *
 * HTTP のメソッドは大文字小文字を区別する語であり、実際に飛んでくるのは
 * 大文字の綴りである。設定側をここで大文字に揃えるので、比較はどの経路でも
 * 単純な文字列の一致でよい。揃えるのを判定の側でやると、判定の経路が 1 つ
 * 増えるたびに揃え忘れが生まれ、そのたびにルールが黙って発火しなくなる。
 */
export function normalizeMethod(method: string): string {
  return method.toUpperCase();
}

/**
 * 綴りを畳んだあとに既知のメソッドとして通る集合。
 *
 * 一致しない綴りは、そのルールが発火しない可能性の高い書き間違いである。
 * 拡張メソッドを禁じる根拠はないので、エラーではなく警告に使う。
 */
export const KNOWN_HTTP_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "CONNECT",
  "OPTIONS",
  "TRACE",
]);

export function methodsIntersect(
  a: readonly string[] | null,
  b: readonly string[] | null,
): boolean {
  if (a === null) return b === null || b.length > 0;
  if (b === null) return a.length > 0;
  return a.some((method) => b.includes(method));
}

/** a ⊆ b か。 */
export function methodsSubsume(
  a: readonly string[] | null,
  b: readonly string[] | null,
): boolean {
  if (b === null) return true;
  if (a === null) return false;
  return a.every((method) => b.includes(method));
}

// -------------------------------------------------------------------- パス

export function pathPatternsIntersect(
  a: CompiledPath,
  b: CompiledPath,
): boolean {
  const m = a.segments.length;
  const n = b.segments.length;
  if (a.trailingDoubleStar && b.trailingDoubleStar) {
    return prefixIntersects(a, b, Math.min(m, n));
  }
  if (a.trailingDoubleStar) return n >= m && prefixIntersects(a, b, m);
  if (b.trailingDoubleStar) return m >= n && prefixIntersects(a, b, n);
  return m === n && prefixIntersects(a, b, m);
}

/** a ⊆ b か。 */
export function pathPatternSubsumes(a: CompiledPath, b: CompiledPath): boolean {
  const m = a.segments.length;
  const n = b.segments.length;
  if (a.trailingDoubleStar && !b.trailingDoubleStar) {
    // a は長さ m 以上を無制限に受理するので、有限長の b には収まらない。
    return false;
  }
  if (b.trailingDoubleStar) return m >= n && prefixSubsumes(a, b, n);
  return m === n && prefixSubsumes(a, b, m);
}

/** `paths` は複数パターンの合併である。いずれかどうしが交差すれば交差する。 */
export function pathsIntersect(
  a: readonly CompiledPath[],
  b: readonly CompiledPath[],
): boolean {
  return a.some((pa) => b.some((pb) => pathPatternsIntersect(pa, pb)));
}

/**
 * a ⊆ b か。
 *
 * a の**すべての**パターンが b の**いずれか 1 つ**に包含されるときだけ真とする。
 * 合併に対する包含としては不完全で、`{n}` を `["a","b"]` に制約した 1 本が
 * `/a` と `/b` の合併に包含される場合を取りこぼす。保守側の原則どおり
 * 「包含しない」に倒し、設定エラーとして書き手に判断を返す。
 */
export function pathsSubsume(
  a: readonly CompiledPath[],
  b: readonly CompiledPath[],
): boolean {
  return a.every((pa) => b.some((pb) => pathPatternSubsumes(pa, pb)));
}

function prefixIntersects(
  a: CompiledPath,
  b: CompiledPath,
  length: number,
): boolean {
  return rangeEvery(length, (index) =>
    segmentSetsIntersect(
      a.segments[index] as SegmentSet,
      b.segments[index] as SegmentSet,
    ),
  );
}

function prefixSubsumes(
  a: CompiledPath,
  b: CompiledPath,
  length: number,
): boolean {
  return rangeEvery(length, (index) =>
    segmentSetSubsumes(
      a.segments[index] as SegmentSet,
      b.segments[index] as SegmentSet,
    ),
  );
}

// ------------------------------------------------------------------ ボディ

/**
 * format の格子。
 *
 * ```
 * ボディ条件なし ⊃ "opaque" ⊃ "json"
 *                          ⊃ "none"
 * "json" ∩ "none" = ∅
 * ```
 *
 * `"opaque"` はボディの存在だけを条件にして内容を解析しないので、`"json"` と
 * `"none"` の**両方**を包含する。「format が違えば比較不能」ではない。
 */
export function formatSubsumes(
  a: BodyFormat | null,
  b: BodyFormat | null,
): boolean {
  if (b === null) return true;
  if (a === null) return false;
  if (a === b) return true;
  return b === "opaque";
}

export function formatIntersects(
  a: BodyFormat | null,
  b: BodyFormat | null,
): boolean {
  if (a === null || b === null) return true;
  if (a === b) return true;
  return a === "opaque" || b === "opaque";
}

export function bodiesIntersect(a: NormalizedBody, b: NormalizedBody): boolean {
  if (!formatIntersects(a.format, b.format)) return false;
  if (!pointersIntersect(a.pointers, b.pointers)) return false;
  return graphqlIntersects(a.graphql, b.graphql);
}

/** a ⊆ b か。 */
export function bodySubsumes(a: NormalizedBody, b: NormalizedBody): boolean {
  if (!formatSubsumes(a.format, b.format)) return false;
  if (!pointersSubsume(a.pointers, b.pointers)) return false;
  return graphqlSubsumes(a.graphql, b.graphql);
}

/**
 * 両方に現れるすべての Pointer で値集合が交差すれば交差する。
 * 片方にしか現れない Pointer は交差を妨げない。
 *
 * Pointer どうしの構造的な矛盾 (`/a` に文字列を要求する条件と `/a/b` に値を要求
 * する条件) は検出せず、保守側の原則により交差すると見なす。
 */
function pointersIntersect(
  a: ReadonlyMap<string, readonly JsonScalar[]>,
  b: ReadonlyMap<string, readonly JsonScalar[]>,
): boolean {
  for (const [pointer, valuesA] of a) {
    const valuesB = b.get(pointer);
    if (valuesB === undefined) continue;
    if (!scalarSetsIntersect(valuesA, valuesB)) return false;
  }
  return true;
}

/**
 * a ⊆ b は「b に現れるすべての Pointer が a にも現れ、値集合が V_a ⊆ V_b」。
 * a にしか現れない Pointer は a を狭めるだけなので包含を妨げない。
 */
function pointersSubsume(
  a: ReadonlyMap<string, readonly JsonScalar[]>,
  b: ReadonlyMap<string, readonly JsonScalar[]>,
): boolean {
  for (const [pointer, valuesB] of b) {
    const valuesA = a.get(pointer);
    if (valuesA === undefined) return false;
    if (!scalarSetSubsumes(valuesA, valuesB)) return false;
  }
  return true;
}

function graphqlIntersects(
  a: NormalizedGraphql | null,
  b: NormalizedGraphql | null,
): boolean {
  if (a === null || b === null) return true;
  // `at` が異なる 2 つは、交差するとしどちらも包含しないとする。
  if (a.at !== b.at) return true;
  if (!a.operations.some((operation) => b.operations.includes(operation))) {
    return false;
  }
  if (a.rootFields !== null && b.rootFields !== null) {
    if (!a.rootFields.some((field) => b.rootFields?.includes(field)))
      return false;
  }
  // `arguments` は交差を妨げない。「この名前の引数が現れるなら値はこの集合に
  // 含まれる」という条件なので、その引数を 1 つも含まない document は値集合が
  // 素な 2 つの条件を同時に満たす。値集合の非交差から document の非存在は導け
  // ないので、保守側に倒してここでは交差を否定しない。witness.ts の証人も、
  // 制約された引数を置かない形で構成することでこの判断と一貫している。
  return true;
}

function graphqlSubsumes(
  a: NormalizedGraphql | null,
  b: NormalizedGraphql | null,
): boolean {
  if (b === null) return true;
  if (a === null) return false;
  if (a.at !== b.at) return false;
  if (!a.operations.every((operation) => b.operations.includes(operation))) {
    return false;
  }
  if (b.rootFields !== null) {
    if (a.rootFields === null) return false;
    if (!a.rootFields.every((field) => b.rootFields?.includes(field)))
      return false;
  }
  // Pointer → 値集合と同じ規則。b のすべての引数名が a にもあり、値集合が
  // V_a ⊆ V_b であること。
  for (const [name, valuesB] of b.argumentValues) {
    const valuesA = a.argumentValues.get(name);
    if (valuesA === undefined) return false;
    if (!valuesA.every((value) => valuesB.includes(value))) return false;
  }
  return true;
}

// -------------------------------------------------------------------- 合成

/**
 * 3 つの軸 (メソッド / パス / ボディ) は独立なので、受理集合は直積であり、
 * 交差と包含は軸ごとに判定して合成できる。この分解はボディ条件の右辺に capture を
 * 置けないことに依存している。その制限を緩めると分解が壊れる。
 */
export function matchesIntersect(a: CompiledMatch, b: CompiledMatch): boolean {
  return (
    methodsIntersect(a.methods, b.methods) &&
    pathsIntersect(a.paths, b.paths) &&
    bodiesIntersect(a.body, b.body)
  );
}

/** a ⊆ b か。 */
export function matchSubsumes(a: CompiledMatch, b: CompiledMatch): boolean {
  return (
    methodsSubsume(a.methods, b.methods) &&
    pathsSubsume(a.paths, b.paths) &&
    bodySubsumes(a.body, b.body)
  );
}

// -------------------------------------------------------------- ターゲット

const PORT = /^[0-9]{1,5}$/;

export function parseTarget(source: string): Result<Target> {
  const separator = source.lastIndexOf(":");
  const hostPart = separator === -1 ? source : source.slice(0, separator);
  const portPart = separator === -1 ? null : source.slice(separator + 1);

  let port: number | null = null;
  if (portPart !== null) {
    if (!PORT.test(portPart)) {
      return { ok: false, error: `ポートが不正である: ${source}` };
    }
    port = Number.parseInt(portPart, 10);
    if (port < 1 || port > 65535) {
      return { ok: false, error: `ポートが範囲外である: ${source}` };
    }
  }

  const host = parseHostPattern(hostPart);
  if (!host.ok) return { ok: false, error: `${host.error} (${source})` };
  return { ok: true, value: { source, host: host.value, port } };
}

/**
 * ホストの綴りを畳む。
 *
 * DNS 名の大小は意味を持たず、リクエストのホストは小文字に揃えて渡ってくる。
 * ここで畳むので、`HostPattern` を読む側 — 一致判定、包含判定、そこから導かれる
 * 特異度の順序 — はすべて小文字どうしを比べることになる。畳むのを一致判定だけに
 * 置くと、包含判定が大小の違う 2 つを素なパターンと見て、包含で決まるはずの
 * スコープの順序が黙って崩れる。
 */
export function normalizeHost(host: string): string {
  return host.toLowerCase();
}

function parseHostPattern(host: string): Result<HostPattern> {
  if (host === "") return { ok: false, error: "ホストが空である" };
  if (host.startsWith("*.")) {
    const suffix = host.slice(2);
    if (suffix === "" || suffix.includes("*")) {
      return { ok: false, error: `ホストパターンが不正である: ${host}` };
    }
    return {
      ok: true,
      value: { kind: "suffix", suffix: normalizeHost(suffix) },
    };
  }
  if (host.includes("*")) {
    return {
      ok: false,
      error: `ワイルドカードは先頭の "*." だけに置ける: ${host}`,
    };
  }
  return { ok: true, value: { kind: "exact", host: normalizeHost(host) } };
}

export function hostMatches(pattern: HostPattern, host: string): boolean {
  if (pattern.kind === "exact") return pattern.host === host;
  return (
    host.endsWith(`.${pattern.suffix}`) &&
    host.length > pattern.suffix.length + 1
  );
}

/**
 * ホストパターンはサフィックスワイルドカードしか持たないので、2 つは必ず
 * 入れ子か素である。したがって交差は「どちらかが他方を包含する」に等しい。
 */
export function hostPatternsIntersect(a: HostPattern, b: HostPattern): boolean {
  return hostPatternSubsumes(a, b) || hostPatternSubsumes(b, a);
}

/** a ⊆ b か。 */
export function hostPatternSubsumes(a: HostPattern, b: HostPattern): boolean {
  if (b.kind === "exact") return a.kind === "exact" && a.host === b.host;
  if (a.kind === "exact") return hostMatches(b, a.host);
  return a.suffix === b.suffix || a.suffix.endsWith(`.${b.suffix}`);
}

export function portsIntersect(a: number | null, b: number | null): boolean {
  return a === null || b === null || a === b;
}

/** a ⊆ b か。 */
export function portSubsumes(a: number | null, b: number | null): boolean {
  return b === null || a === b;
}

export function targetsIntersect(a: Target, b: Target): boolean {
  return (
    hostPatternsIntersect(a.host, b.host) && portsIntersect(a.port, b.port)
  );
}

/** a ⊆ b か。 */
export function targetSubsumes(a: Target, b: Target): boolean {
  return hostPatternSubsumes(a.host, b.host) && portSubsumes(a.port, b.port);
}

export function targetSetsIntersect(
  a: readonly Target[],
  b: readonly Target[],
): boolean {
  return a.some((ta) => b.some((tb) => targetsIntersect(ta, tb)));
}

/** a ⊆ b か。`paths` と同じく、合併に対しては不完全な判定である。 */
export function targetSetsSubsume(
  a: readonly Target[],
  b: readonly Target[],
): boolean {
  return a.every((ta) => b.some((tb) => targetSubsumes(ta, tb)));
}

// ------------------------------------------------------------------ 補助

export function scalarKey(value: JsonScalar): string {
  return `${typeof value}:${String(value)}`;
}

function scalarSetsIntersect(
  a: readonly JsonScalar[],
  b: readonly JsonScalar[],
): boolean {
  const keys = new Set(b.map(scalarKey));
  return a.some((value) => keys.has(scalarKey(value)));
}

function scalarSetSubsumes(
  a: readonly JsonScalar[],
  b: readonly JsonScalar[],
): boolean {
  const keys = new Set(b.map(scalarKey));
  return a.every((value) => keys.has(scalarKey(value)));
}

function uniqueScalars(values: readonly JsonScalar[]): readonly JsonScalar[] {
  const seen = new Set<string>();
  const result: JsonScalar[] = [];
  for (const value of values) {
    const key = scalarKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function rangeEvery(
  length: number,
  predicate: (index: number) => boolean,
): boolean {
  for (let index = 0; index < length; index++) {
    if (!predicate(index)) return false;
  }
  return true;
}
