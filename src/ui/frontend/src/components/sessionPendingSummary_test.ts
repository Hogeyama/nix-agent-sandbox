import { describe, expect, test } from "bun:test";
import { summarizePendingBySession } from "./sessionPendingSummary";

describe("summarizePendingBySession", () => {
  test("returns an empty map when both queues are empty", () => {
    const summary = summarizePendingBySession([], []);
    expect(summary.size).toBe(0);
  });

  test("counts a single network row against its session", () => {
    const summary = summarizePendingBySession([{ sessionId: "sA" }], []);
    expect(Array.from(summary.entries())).toEqual([
      ["sA", { network: 1, hostexec: 0 }],
    ]);
  });

  test("counts a single hostexec row against its session", () => {
    const summary = summarizePendingBySession([], [{ sessionId: "sA" }]);
    expect(Array.from(summary.entries())).toEqual([
      ["sA", { network: 0, hostexec: 1 }],
    ]);
  });

  test("aggregates 2 network + 1 hostexec under the same session", () => {
    const summary = summarizePendingBySession(
      [{ sessionId: "sA" }, { sessionId: "sA" }],
      [{ sessionId: "sA" }],
    );
    expect(summary.size).toBe(1);
    expect(summary.get("sA")).toEqual({ network: 2, hostexec: 1 });
  });

  test("keeps independent entries when sessions differ", () => {
    const summary = summarizePendingBySession(
      [{ sessionId: "sA" }, { sessionId: "sB" }],
      [{ sessionId: "sB" }, { sessionId: "sC" }],
    );
    expect(summary.size).toBe(3);
    expect(summary.get("sA")).toEqual({ network: 1, hostexec: 0 });
    expect(summary.get("sB")).toEqual({ network: 1, hostexec: 1 });
    expect(summary.get("sC")).toEqual({ network: 0, hostexec: 1 });
  });

  test("does not synthesise an entry for sessions with no pending rows", () => {
    const summary = summarizePendingBySession(
      [{ sessionId: "sA" }],
      [{ sessionId: "sA" }],
    );
    expect(summary.has("sZ")).toBe(false);
    expect(summary.get("sZ")).toBeUndefined();
  });
});
