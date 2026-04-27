import { describe, expect, test } from "bun:test";
import { shortenSessionId } from "./sessionId";

describe("shortenSessionId", () => {
  test("strips sess_ prefix and returns the next 6 chars (real backend format)", () => {
    expect(shortenSessionId("sess_f7a3f12345ab")).toBe("f7a3f1");
  });

  test("strips s_ prefix and returns the next 6 chars", () => {
    expect(shortenSessionId("s_7a3f1234567890")).toBe("7a3f12");
  });

  test("returns the first 6 chars when input has no recognized prefix", () => {
    expect(shortenSessionId("f7a3f12345")).toBe("f7a3f1");
  });

  test("returns the first 6 chars when input starts with sess but has no underscore", () => {
    // "session_xyz123" starts with "sess" but does not match the sess_ or s_ prefix,
    // so the regex must not strip anything and slice(0, 6) returns "sessio".
    expect(shortenSessionId("session_xyz123")).toBe("sessio");
  });

  test("returns input as-is when shorter than 6 chars", () => {
    // slice(0, 6) on a 3-char string yields the full string; should not throw
    expect(shortenSessionId("abc")).toBe("abc");
  });

  test("returns empty string for empty input", () => {
    expect(shortenSessionId("")).toBe("");
  });

  test("returns the remainder when prefix strip leaves fewer than 6 chars", () => {
    expect(shortenSessionId("sess_abc")).toBe("abc");
  });
});
