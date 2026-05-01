import { expect, test } from "bun:test";
import { diffHistorySnapshot } from "./history_sse_diff.ts";

test("initial poll (prevJson = null) reports changed with serialized payload", () => {
  const result = diffHistorySnapshot(null, []);
  expect(result.changed).toBe(true);
  if (result.changed) {
    expect(result.nextJson).toBe("[]");
  }
});

test("identical empty array snapshot reports unchanged", () => {
  const result = diffHistorySnapshot("[]", []);
  expect(result).toEqual({ changed: false });
});

test("payload growth (empty → one row) reports changed", () => {
  const next = [{ id: "c1", agent: null }];
  const result = diffHistorySnapshot("[]", next);
  expect(result.changed).toBe(true);
  if (result.changed) {
    expect(result.nextJson).toBe(JSON.stringify(next));
  }
});

test("nested object equality with stable JSON.stringify ordering", () => {
  const a = { conversation: { id: "c1" }, invocations: [] };
  const prev = JSON.stringify(a);
  // Same shape, same key insertion order — JSON.stringify is deterministic
  // with respect to object insertion order, which is what our reader queries
  // produce.
  const b = { conversation: { id: "c1" }, invocations: [] };
  const result = diffHistorySnapshot(prev, b);
  expect(result).toEqual({ changed: false });
});

test("nested object value change reports changed with new JSON", () => {
  const prev = JSON.stringify({ conversation: { id: "c1" }, invocations: [] });
  const next = {
    conversation: { id: "c1" },
    invocations: [{ id: "i1" }],
  };
  const result = diffHistorySnapshot(prev, next);
  expect(result.changed).toBe(true);
  if (result.changed) {
    expect(result.nextJson).toBe(JSON.stringify(next));
  }
});

test("null payload (e.g. detail not found) is distinguishable from empty", () => {
  const a = diffHistorySnapshot(null, null);
  expect(a.changed).toBe(true);
  if (a.changed) {
    expect(a.nextJson).toBe("null");
  }
  // Subsequent poll with same null payload reports unchanged.
  const b = diffHistorySnapshot("null", null);
  expect(b).toEqual({ changed: false });
});
