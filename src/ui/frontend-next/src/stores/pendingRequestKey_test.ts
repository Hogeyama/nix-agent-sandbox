import { describe, expect, test } from "bun:test";
import { pendingRequestKey } from "./pendingRequestKey";

describe("pendingRequestKey", () => {
  test("equal inputs produce equal keys", () => {
    const a = pendingRequestKey("network", "s_abc", "req-1");
    const b = pendingRequestKey("network", "s_abc", "req-1");
    expect(a).toBe(b);
  });

  test("different domain with same sessionId and requestId yields distinct keys", () => {
    const net = pendingRequestKey("network", "s_abc", "req-1");
    const exec = pendingRequestKey("hostexec", "s_abc", "req-1");
    expect(net).not.toBe(exec);
  });

  test("different sessionId with same domain and requestId yields distinct keys", () => {
    const a = pendingRequestKey("network", "s_aaa", "req-1");
    const b = pendingRequestKey("network", "s_bbb", "req-1");
    expect(a).not.toBe(b);
  });

  test("different requestId with same domain and sessionId yields distinct keys", () => {
    const a = pendingRequestKey("network", "s_abc", "req-1");
    const b = pendingRequestKey("network", "s_abc", "req-2");
    expect(a).not.toBe(b);
  });

  test("returns a stable string format containing domain, sessionId, and requestId", () => {
    const key = pendingRequestKey("network", "s_abcdef", "req-xyz");
    expect(typeof key).toBe("string");
    expect(key).toBe("network|s_abcdef|req-xyz");
  });

  test("hostexec domain is encoded distinctly from network in the key string", () => {
    expect(pendingRequestKey("hostexec", "s_abc", "req-1")).toBe(
      "hostexec|s_abc|req-1",
    );
  });

  test("delimiter `|` cannot appear in valid sessionId or requestId so triples are unambiguous", () => {
    // The backend validates both sessionId and requestId against
    // /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/ (src/ui/routes/validate_ids.ts),
    // so neither can contain `|`. This test pins that invariant: two
    // distinct triples always produce distinct keys regardless of how
    // their pieces happen to align.
    const a = pendingRequestKey("network", "abc", "def-ghi");
    const b = pendingRequestKey("network", "abc-def", "ghi");
    expect(a).not.toBe(b);
  });
});
