import { describe, expect, test } from "bun:test";
import { shortenSessionId } from "./sessionId";

describe("shortenSessionId", () => {
  test("strips existing s_ prefix and applies a single one with 6 chars", () => {
    expect(shortenSessionId("s_7a3f1234567890")).toBe("s_7a3f12");
  });

  test("adds s_ prefix when input has none", () => {
    expect(shortenSessionId("7a3f1234")).toBe("s_7a3f12");
  });

  test("returns input as-is (with prefix) when shorter than 6 chars after stripping", () => {
    // slice(0, 6) on a 3-char string yields the full string; should not throw
    expect(shortenSessionId("s_abc")).toBe("s_abc");
  });
});
