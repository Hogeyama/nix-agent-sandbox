import { describe, expect, test } from "bun:test";
import { buildSourceView } from "./sourceView";

describe("buildSourceView", () => {
  test("preserves every source line including a trailing empty line", () => {
    expect(buildSourceView("a\nb\n", 2)).toEqual({
      lines: [
        { number: 1, text: "a", highlighted: false },
        { number: 2, text: "b", highlighted: true },
        { number: 3, text: "", highlighted: false },
      ],
      scrollLine: 2,
    });
  });

  test("clamps lines beyond the document to the last source line", () => {
    expect(buildSourceView("a\nb", 99)).toEqual({
      lines: [
        { number: 1, text: "a", highlighted: false },
        { number: 2, text: "b", highlighted: true },
      ],
      scrollLine: 2,
    });
  });

  test("clamps non-positive lines to the first source line", () => {
    expect(buildSourceView("a\nb", 0)).toEqual({
      lines: [
        { number: 1, text: "a", highlighted: true },
        { number: 2, text: "b", highlighted: false },
      ],
      scrollLine: 1,
    });
  });

  test("keeps the exact empty source while omitting an absent target", () => {
    expect(buildSourceView("", null)).toEqual({
      lines: [{ number: 1, text: "", highlighted: false }],
      scrollLine: null,
    });
  });
});
