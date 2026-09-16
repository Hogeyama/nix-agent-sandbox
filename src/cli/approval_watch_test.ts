import { expect, test } from "bun:test";
import type { PendingItem } from "./approval_command.ts";
import { diffPending, type PendingSnapshotEntry } from "./approval_watch.ts";

function item(
  sessionId: string,
  requestId: string,
  structured?: Record<string, unknown>,
): PendingItem {
  return { sessionId, requestId, displayLine: "", structured };
}

function emptyState(): Map<string, PendingSnapshotEntry> {
  return new Map();
}

test("diffPending emits added for every entry of the first snapshot", () => {
  const { events, nextState } = diffPending("hostexec", emptyState(), [
    item("sess_a", "req_1", {
      sessionId: "sess_a",
      requestId: "req_1",
      ruleId: "gcloud",
    }),
    item("sess_a", "req_2", {
      sessionId: "sess_a",
      requestId: "req_2",
      ruleId: "gpg-git-sign",
    }),
  ]);

  expect(events).toEqual([
    {
      event: "added",
      domain: "hostexec",
      entry: { sessionId: "sess_a", requestId: "req_1", ruleId: "gcloud" },
    },
    {
      event: "added",
      domain: "hostexec",
      entry: {
        sessionId: "sess_a",
        requestId: "req_2",
        ruleId: "gpg-git-sign",
      },
    },
  ]);
  expect(nextState.size).toBe(2);
});

test("diffPending emits nothing when the snapshot is unchanged", () => {
  const first = diffPending("network", emptyState(), [item("sess_a", "req_1")]);
  const second = diffPending("network", first.nextState, [
    item("sess_a", "req_1"),
  ]);

  expect(second.events).toEqual([]);
});

test("diffPending emits removed for entries that disappeared", () => {
  const first = diffPending("hostexec", emptyState(), [
    item("sess_a", "req_1"),
    item("sess_b", "req_2"),
  ]);
  const second = diffPending("hostexec", first.nextState, [
    item("sess_b", "req_2"),
  ]);

  expect(second.events).toEqual([
    {
      event: "removed",
      domain: "hostexec",
      sessionId: "sess_a",
      requestId: "req_1",
    },
  ]);
  expect(second.nextState.size).toBe(1);
});

test("diffPending emits removed before added within one tick", () => {
  const first = diffPending("hostexec", emptyState(), [
    item("sess_a", "req_1"),
  ]);
  const second = diffPending("hostexec", first.nextState, [
    item("sess_a", "req_2"),
  ]);

  expect(second.events.map((e) => e.event)).toEqual(["removed", "added"]);
});

test("diffPending falls back to the id pair when an item carries no structured payload", () => {
  const { events } = diffPending("network", emptyState(), [
    item("sess_a", "req_1"),
  ]);

  expect(events).toEqual([
    {
      event: "added",
      domain: "network",
      entry: { sessionId: "sess_a", requestId: "req_1" },
    },
  ]);
});

test("diffPending distinguishes the same requestId across sessions", () => {
  const { nextState } = diffPending("hostexec", emptyState(), [
    item("sess_a", "req_1"),
    item("sess_b", "req_1"),
  ]);

  expect(nextState.size).toBe(2);
});
