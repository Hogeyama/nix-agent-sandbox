import { describe, expect, test } from "bun:test";
import {
  compiledPathMatches,
  compilePathPattern,
  parsePathPattern,
  resolveSegment,
  segmentSetIntersectionSample,
  segmentSetSubsumes,
  segmentSetsIntersect,
} from "./pattern.ts";

describe("parsePathPattern", () => {
  test("セグメントを 4 種に分ける", () => {
    const parsed = parsePathPattern("/repos/{org}/*/pulls");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.segments).toEqual([
      { kind: "literal", value: "" },
      { kind: "literal", value: "repos" },
      { kind: "capture", name: "org" },
      { kind: "wildcard" },
      { kind: "literal", value: "pulls" },
    ]);
    expect(parsed.value.trailingDoubleStar).toBe(false);
  });

  test("末尾の ** はセグメント列から外して記録する", () => {
    const parsed = parsePathPattern("/repos/**");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.segments).toHaveLength(2);
    expect(parsed.value.trailingDoubleStar).toBe(true);
  });

  test("** が末尾以外にあれば設定エラー", () => {
    const parsed = parsePathPattern("/a/**/b");
    expect(parsed.ok).toBe(false);
  });

  test("capture 名の重複は設定エラー", () => {
    const parsed = parsePathPattern("/a/{n}/{n}");
    expect(parsed.ok).toBe(false);
  });

  test("セグメントの一部だけのワイルドカードは受け付けない", () => {
    expect(parsePathPattern("/a/pre*").ok).toBe(false);
    expect(parsePathPattern("/a/x{n}").ok).toBe(false);
  });
});

describe("セグメント集合", () => {
  const captures = { org: ["my-org", "other"] };

  test("制約のない capture は全セグメント、制約付きは列挙集合", () => {
    expect(resolveSegment({ kind: "capture", name: "repo" }, captures)).toEqual(
      {
        kind: "all",
      },
    );
    expect(resolveSegment({ kind: "capture", name: "org" }, captures)).toEqual({
      kind: "finite",
      values: ["my-org", "other"],
    });
  });

  test("リテラルは capture より狭く、* と {n} は同じ広さを持つ", () => {
    const literal = { kind: "finite", values: ["a"] } as const;
    const all = { kind: "all" } as const;
    expect(segmentSetSubsumes(literal, all)).toBe(true);
    expect(segmentSetSubsumes(all, literal)).toBe(false);
    expect(segmentSetsIntersect(literal, all)).toBe(true);
  });

  test("交差の要素はリテラル側・制約側から選ばれる", () => {
    expect(
      segmentSetIntersectionSample(
        { kind: "all" },
        { kind: "finite", values: ["b"] },
      ),
    ).toBe("b");
    expect(segmentSetIntersectionSample({ kind: "all" }, { kind: "all" })).toBe(
      "x",
    );
    expect(
      segmentSetIntersectionSample(
        { kind: "finite", values: ["a"] },
        { kind: "finite", values: ["b"] },
      ),
    ).toBeNull();
  });
});

describe("compiledPathMatches", () => {
  const compile = (
    source: string,
    captures: Record<string, readonly string[]> = {},
  ) => {
    const compiled = compilePathPattern(source, captures);
    if (!compiled.ok) throw new Error(compiled.error);
    return compiled.value;
  };

  test("** は 0 個以上のセグメントに一致する", () => {
    const pattern = compile("/repos/**");
    expect(compiledPathMatches(pattern, "/repos")).toBe(true);
    expect(compiledPathMatches(pattern, "/repos/a")).toBe(true);
    expect(compiledPathMatches(pattern, "/repos/a/b")).toBe(true);
    expect(compiledPathMatches(pattern, "/other")).toBe(false);
  });

  test("capture の制約が言語を狭める", () => {
    const pattern = compile("/repos/{org}", { org: ["my-org"] });
    expect(compiledPathMatches(pattern, "/repos/my-org")).toBe(true);
    expect(compiledPathMatches(pattern, "/repos/other")).toBe(false);
  });

  test("パスを正規化しない", () => {
    const pattern = compile("/a/b");
    // 末尾スラッシュの除去も連続スラッシュの畳み込みもしない。
    expect(compiledPathMatches(pattern, "/a/b/")).toBe(false);
    expect(compiledPathMatches(pattern, "//a/b")).toBe(false);
    // パーセント復号もしない。
    expect(compiledPathMatches(compile("/a b"), "/a%20b")).toBe(false);
  });
});
