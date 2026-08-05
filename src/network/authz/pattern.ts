/**
 * パスパターンの解析と、セグメント集合の演算。
 *
 * 設計「Match の語彙 > パスパターン」「交差と包含の判定 > パス」に対応する。
 * パスの正規化は一切行わない。パーセント復号も連続スラッシュの畳み込みも
 * 末尾スラッシュの除去もせず、`/` で切った生のトークン列として扱う。
 */

import type { Result } from "./types.ts";

export type PatternSegment =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "wildcard" }
  | { readonly kind: "capture"; readonly name: string };

export interface PathPattern {
  readonly source: string;
  /** `**` を除いたセグメント列。 */
  readonly segments: readonly PatternSegment[];
  readonly trailingDoubleStar: boolean;
}

/** セグメントが表す文字列集合。 */
export type SegmentSet =
  | { readonly kind: "all" }
  | { readonly kind: "finite"; readonly values: readonly string[] };

/** capture 制約を解決し、各セグメントを集合に落としたパターン。 */
export interface CompiledPath {
  readonly source: string;
  readonly segments: readonly SegmentSet[];
  readonly trailingDoubleStar: boolean;
}

const CAPTURE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** 交差の証人で、集合が全体のときに置くセグメント。 */
export const WITNESS_SEGMENT = "x";

export function parsePathPattern(source: string): Result<PathPattern> {
  const tokens = source.split("/");
  const segments: PatternSegment[] = [];
  const names = new Set<string>();
  let trailingDoubleStar = false;

  for (const [index, token] of tokens.entries()) {
    if (token === "**") {
      if (index !== tokens.length - 1) {
        return err(`"**" は末尾のセグメントにのみ置ける: ${source}`);
      }
      trailingDoubleStar = true;
      continue;
    }
    if (token.includes("**")) {
      return err(`セグメントの一部に "**" を書けない: ${source}`);
    }
    if (token === "*") {
      segments.push({ kind: "wildcard" });
      continue;
    }
    if (token.includes("*")) {
      return err(`セグメントの一部に "*" を書けない: ${source}`);
    }
    if (token.startsWith("{") && token.endsWith("}") && token.length >= 2) {
      const name = token.slice(1, -1);
      if (!CAPTURE_NAME.test(name)) {
        return err(`capture 名が不正である: ${token} (${source})`);
      }
      if (names.has(name)) {
        return err(
          `capture 名が同一パターン内で重複している: ${name} (${source})`,
        );
      }
      names.add(name);
      segments.push({ kind: "capture", name });
      continue;
    }
    if (token.includes("{") || token.includes("}")) {
      return err(
        `capture は 1 セグメント全体でなければならない: ${token} (${source})`,
      );
    }
    segments.push({ kind: "literal", value: token });
  }

  return { ok: true, value: { source, segments, trailingDoubleStar } };
}

export function compilePathPattern(
  source: string,
  captures: Readonly<Record<string, readonly string[]>> = {},
): Result<CompiledPath> {
  const parsed = parsePathPattern(source);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      source,
      segments: parsed.value.segments.map((segment) =>
        resolveSegment(segment, captures),
      ),
      trailingDoubleStar: parsed.value.trailingDoubleStar,
    },
  };
}

export function resolveSegment(
  segment: PatternSegment,
  captures: Readonly<Record<string, readonly string[]>>,
): SegmentSet {
  if (segment.kind === "literal") {
    return { kind: "finite", values: [segment.value] };
  }
  if (segment.kind === "wildcard") return { kind: "all" };
  const constraint = captures[segment.name];
  if (constraint === undefined) return { kind: "all" };
  return { kind: "finite", values: unique(constraint) };
}

export function segmentSetsIntersect(a: SegmentSet, b: SegmentSet): boolean {
  if (a.kind === "all") return b.kind === "all" || b.values.length > 0;
  if (b.kind === "all") return a.values.length > 0;
  return a.values.some((value) => b.values.includes(value));
}

/** a ⊆ b か。 */
export function segmentSetSubsumes(a: SegmentSet, b: SegmentSet): boolean {
  if (b.kind === "all") return true;
  if (a.kind === "all") return false;
  return a.values.every((value) => b.values.includes(value));
}

/** 集合の要素を 1 つ選ぶ。空集合なら null。 */
export function segmentSetSample(set: SegmentSet): string | null {
  if (set.kind === "all") return WITNESS_SEGMENT;
  return set.values[0] ?? null;
}

/** a ∩ b の要素を 1 つ選ぶ。交差しなければ null。 */
export function segmentSetIntersectionSample(
  a: SegmentSet,
  b: SegmentSet,
): string | null {
  if (a.kind === "all") return segmentSetSample(b);
  if (b.kind === "all") return segmentSetSample(a);
  return a.values.find((value) => b.values.includes(value)) ?? null;
}

export function segmentSetMatches(set: SegmentSet, token: string): boolean {
  return set.kind === "all" || set.values.includes(token);
}

/**
 * パスをセグメント列に切る。
 *
 * 先頭の `/` は空トークンとして残す。`"/a/b".split("/")` は `["", "a", "b"]` で
 * あり、パターン側も同じ切り方をするので、先頭の空トークンどうしが一致する。
 * `join("/")` で元に戻るので、証人の構成も同じ表現の上で閉じる。
 */
export function splitPath(path: string): readonly string[] {
  return path.split("/");
}

export function joinPath(tokens: readonly string[]): string {
  return tokens.join("/");
}

export function compiledPathMatches(
  pattern: CompiledPath,
  path: string,
): boolean {
  const tokens = splitPath(path);
  const m = pattern.segments.length;
  if (pattern.trailingDoubleStar) {
    if (tokens.length < m) return false;
  } else if (tokens.length !== m) {
    return false;
  }
  return pattern.segments.every((set, index) =>
    segmentSetMatches(set, tokens[index] as string),
  );
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function err(error: string): Result<never> {
  return { ok: false, error };
}
