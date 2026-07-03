import { describe, expect, test } from "bun:test";
import {
  expandMaskPatterns,
  maskReviewContext,
  maskText,
} from "./mask_patterns.ts";

describe("expandMaskPatterns", () => {
  test("includes raw value", () => {
    expect(expandMaskPatterns(["s3cret-value"])).toContain("s3cret-value");
  });

  test("includes percent-encoded variants (quote / quote_plus)", () => {
    const patterns = expandMaskPatterns(["p@ss w+rd"]);
    // Python: urllib.parse.quote("p@ss w+rd", safe="") 相当
    expect(patterns).toContain("p%40ss%20w%2Brd");
    // Python: urllib.parse.quote_plus("p@ss w+rd") 相当 (space → +)
    expect(patterns).toContain("p%40ss+w%2Brd");
  });

  test("includes base64 confident substrings for all 3 alignments", () => {
    const secret = "s3cret-value-long";
    const patterns = expandMaskPatterns([secret]);
    const raw = new TextEncoder().encode(secret);
    for (let k = 0; k < 3; k++) {
      // 秘密値が offset k で埋め込まれた base64 ストリームを再現し、
      // いずれかのパターンが部分文字列として見つかることを確認する
      const prefix = new Uint8Array(k).fill(0x41); // "A" 埋め
      const stream = new Uint8Array([...prefix, ...raw, 0x42, 0x43]);
      const encoded = Buffer.from(stream).toString("base64");
      const hit = patterns.some((p) => encoded.includes(p));
      expect(hit).toBe(true);
    }
  });

  test("short secrets do not generate sub-minimum base64 patterns", () => {
    const patterns = expandMaskPatterns(["abcd"]); // 4 bytes
    for (const p of patterns) {
      // base64 確定部分文字列は 8 文字未満なら採用されない。
      // 生値・percent 変種 (どちらも "abcd") 以外は存在しないはず
      expect(p).toEqual("abcd");
    }
  });

  test("sorted longest-first", () => {
    const patterns = expandMaskPatterns(["shortpw1", "much-longer-secret"]);
    const lengths = patterns.map((p) => p.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });
});

describe("maskText", () => {
  test("replaces all occurrences with ****", () => {
    const patterns = expandMaskPatterns(["s3cret-value"]);
    expect(maskText("a=s3cret-value&b=s3cret-value", patterns)).toEqual(
      "a=****&b=****",
    );
  });

  test("longest pattern wins when one secret contains another", () => {
    const patterns = expandMaskPatterns(["s3cret", "s3cret-extended"]);
    expect(maskText("x=s3cret-extended", patterns)).toEqual("x=****");
  });
});

describe("maskReviewContext", () => {
  test("masks path and bodyPreview", () => {
    const ctx = maskReviewContext(
      {
        path: "/upload?token=s3cret-value",
        contentType: "application/x-www-form-urlencoded",
        bodyPreview: "data=s3cret-value",
        bodySize: 17,
      },
      ["s3cret-value"],
    );
    expect(ctx?.path).toEqual("/upload?token=****");
    expect(ctx?.bodyPreview).toEqual("data=****");
  });

  test("returns ctx unchanged when no values", () => {
    const ctx = {
      path: "/p",
      contentType: null,
      bodyPreview: "body",
      bodySize: 4,
    };
    expect(maskReviewContext(ctx, [])).toEqual(ctx);
    expect(maskReviewContext(undefined, ["s3cret-value"])).toBeUndefined();
  });
});
