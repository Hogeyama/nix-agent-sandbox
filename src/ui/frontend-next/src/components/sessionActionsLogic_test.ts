import { describe, expect, test } from "bun:test";
import { NAME_MAX_LENGTH, validateName } from "./sessionActionsLogic";

describe("validateName", () => {
  test("trims surrounding whitespace", () => {
    expect(validateName("  foo  ")).toEqual({ ok: true, value: "foo" });
  });

  test("rejects input that is empty after trim", () => {
    expect(validateName("   ")).toEqual({
      ok: false,
      reason: "Name cannot be empty",
    });
  });

  test("rejects input that exceeds NAME_MAX_LENGTH after trim", () => {
    const tooLong = "a".repeat(NAME_MAX_LENGTH + 1);
    expect(validateName(tooLong)).toEqual({
      ok: false,
      reason: `Name exceeds ${NAME_MAX_LENGTH} characters`,
    });
  });

  test("strips ASCII control characters before trimming", () => {
    expect(validateName("a\x00b\x1Fc\x7Fd")).toEqual({
      ok: true,
      value: "abcd",
    });
  });

  test("preserves valid unicode (e.g. Japanese)", () => {
    expect(validateName("テスト")).toEqual({ ok: true, value: "テスト" });
  });

  test("accepts an input that is exactly NAME_MAX_LENGTH after trim", () => {
    const exact = "a".repeat(NAME_MAX_LENGTH);
    expect(validateName(exact)).toEqual({ ok: true, value: exact });
  });

  test("rejects input that contains only control characters", () => {
    expect(validateName("\x00\x01\x02")).toEqual({
      ok: false,
      reason: "Name cannot be empty",
    });
  });
});
