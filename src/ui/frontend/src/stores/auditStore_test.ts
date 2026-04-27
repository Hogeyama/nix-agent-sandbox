/**
 * Tests for `auditStore`.
 *
 * Pin the recent-50 contract: input order is irrelevant, output is
 * always newest-first, and the store keeps no more than 50 entries.
 */

import { describe, expect, test } from "bun:test";
import { createAuditStore, normalizeAuditEntries } from "./auditStore";
import type { AuditLogEntryLike } from "./types";

function makeEntry(
  overrides: Partial<AuditLogEntryLike> = {},
): AuditLogEntryLike {
  return {
    id: "id-1",
    timestamp: "2026-04-20T10:00:00.000Z",
    domain: "network",
    sessionId: "s_abc",
    requestId: "r_1",
    decision: "allow",
    reason: "ok",
    ...overrides,
  };
}

describe("normalizeAuditEntries", () => {
  test("returns rows newest-first regardless of input order", () => {
    const rows = normalizeAuditEntries([
      makeEntry({ id: "a", timestamp: "2026-04-20T10:00:00.000Z" }),
      makeEntry({ id: "b", timestamp: "2026-04-20T12:00:00.000Z" }),
      makeEntry({ id: "c", timestamp: "2026-04-20T11:00:00.000Z" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  test("trims to the most recent 50 entries", () => {
    // Build 60 entries with strictly increasing timestamps; expect the
    // top 50 by timestamp (which are the 50 newest, ids 10..59).
    const items: AuditLogEntryLike[] = [];
    for (let i = 0; i < 60; i++) {
      const minute = String(i).padStart(2, "0");
      items.push(
        makeEntry({
          id: `id-${i}`,
          timestamp: `2026-04-20T10:${minute}:00.000Z`,
        }),
      );
    }
    const rows = normalizeAuditEntries(items);
    expect(rows.length).toBe(50);
    // First row is the newest input (id-59).
    expect(rows[0]?.id).toBe("id-59");
    // Last row in the trimmed window is id-10 (we drop the 10 oldest).
    expect(rows[49]?.id).toBe("id-10");
  });

  test("absorbs upstream-optional fields with null", () => {
    const [row] = normalizeAuditEntries([
      makeEntry({
        scope: undefined,
        target: undefined,
        command: undefined,
      }),
    ]);
    expect(row?.scope).toBeNull();
    expect(row?.target).toBeNull();
    expect(row?.command).toBeNull();
  });

  test("preserves explicitly-set string fields", () => {
    const [row] = normalizeAuditEntries([
      makeEntry({ scope: "host", target: "example.com:443" }),
    ]);
    expect(row?.scope).toBe("host");
    expect(row?.target).toBe("example.com:443");
  });
});

describe("createAuditStore", () => {
  test("entries() reflects the latest setEntries write", () => {
    const store = createAuditStore();
    expect(store.entries()).toEqual([]);
    store.setEntries([
      makeEntry({ id: "a", timestamp: "2026-04-20T10:00:00.000Z" }),
      makeEntry({ id: "b", timestamp: "2026-04-20T11:00:00.000Z" }),
    ]);
    expect(store.entries().map((r) => r.id)).toEqual(["b", "a"]);
    store.setEntries([
      makeEntry({ id: "c", timestamp: "2026-04-20T12:00:00.000Z" }),
    ]);
    expect(store.entries().map((r) => r.id)).toEqual(["c"]);
  });
});
