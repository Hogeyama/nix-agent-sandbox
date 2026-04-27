/**
 * Tests for `auditPageStore`.
 *
 * The reducer that backs the store is exhaustively pinned in
 * `auditPaginationLogic_test.ts`. These tests pin the wiring layer:
 *
 *   - `setFilter` builds the server filter from the display filter
 *     and dispatches `reset`.
 *   - `loadOlder` snapshots the cursor and the filter, captures the
 *     generation after `startLoad`, and dispatches the right
 *     follow-up action when the fetch resolves or rejects.
 *   - Stale responses from a load that races with `setFilter` leave
 *     the older-history pool untouched.
 *   - Re-entrancy and exhaustion guards short-circuit `loadOlder`
 *     before it dispatches anything.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AuditServerFilter } from "../components/settings/auditPaginationLogic";
import { createAuditPageStore } from "./auditPageStore";
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

/**
 * Build a deferred promise so a test can await `loadOlder` after
 * deliberately resolving / rejecting the in-flight fetch from the
 * outside.
 */
function defer<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createAuditPageStore / initial state", () => {
  test("starts empty with the default display filter and an empty server filter", () => {
    const store = createAuditPageStore();
    const s = store.state();
    expect(s.olderItems).toEqual([]);
    expect(s.hasMore).toBe(true);
    expect(s.loadingMore).toBe(false);
    expect(s.loadError).toBeNull();
    expect(s.serverFilter).toEqual({});
  });
});

describe("setFilter", () => {
  test("dispatches reset, bumps fetchGen, and rebuilds the server filter", () => {
    const store = createAuditPageStore();
    const startGen = store.state().fetchGen;
    store.setFilter(
      { domain: "network", sessionContains: "abc", activeOnly: true },
      new Set(["s1", "s2"]),
    );
    const s = store.state();
    expect(s.fetchGen).toBe(startGen + 1);
    expect(s.serverFilter).toEqual<AuditServerFilter>({
      domain: "network",
      sessionContains: "abc",
      sessions: ["s1", "s2"],
    });
    expect(s.displayFilter.domain).toBe("network");
    expect(s.olderItems).toEqual([]);
  });
});

describe("loadOlder / success path", () => {
  test("appends the returned items to the older-history pool", async () => {
    const store = createAuditPageStore();
    // The page only has a cursor when there is at least one row; seed
    // the live window with one entry.
    const liveItems = [
      makeEntry({ id: "live-1", timestamp: "2026-04-20T12:00:00.000Z" }),
    ];
    const fetchAuditLogs = mock(async () => ({
      items: [
        makeEntry({ id: "older-1", timestamp: "2026-04-20T11:00:00.000Z" }),
        makeEntry({ id: "older-2", timestamp: "2026-04-20T10:00:00.000Z" }),
      ],
    }));
    await store.loadOlder({
      fetchAuditLogs:
        fetchAuditLogs as unknown as typeof import("../api/client").getAuditLogs,
      live: () => liveItems,
      pageSize: 2,
    });
    const s = store.state();
    expect(s.olderItems.map((e) => e.id)).toEqual(["older-1", "older-2"]);
    expect(s.loadingMore).toBe(false);
    expect(s.loadError).toBeNull();
    // Returned items match pageSize exactly: more matching history may
    // still exist on the backend, so hasMore stays true.
    expect(s.hasMore).toBe(true);
  });

  test("forwards the snapshotted server filter and the oldest timestamp as the cursor", async () => {
    const store = createAuditPageStore();
    store.setFilter(
      { domain: "network", sessionContains: "", activeOnly: false },
      new Set(),
    );
    const liveItems = [
      makeEntry({ id: "newest", timestamp: "2026-04-20T12:00:00.000Z" }),
      makeEntry({ id: "oldest", timestamp: "2026-04-20T08:00:00.000Z" }),
    ];
    const calls: unknown[][] = [];
    const fetchAuditLogs: typeof import("../api/client").getAuditLogs = async (
      ...args
    ) => {
      calls.push(args);
      return { items: [] };
    };
    await store.loadOlder({
      fetchAuditLogs,
      live: () => liveItems,
      pageSize: 50,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toEqual({
      domain: "network",
      before: "2026-04-20T08:00:00.000Z",
      limit: 50,
    });
  });

  test("flips hasMore=false when the response is empty", async () => {
    const store = createAuditPageStore();
    const fetchAuditLogs = mock(async () => ({ items: [] }));
    await store.loadOlder({
      fetchAuditLogs:
        fetchAuditLogs as unknown as typeof import("../api/client").getAuditLogs,
      live: () => [makeEntry({ id: "live-1" })],
      pageSize: 200,
    });
    const s = store.state();
    expect(s.hasMore).toBe(false);
    expect(s.olderItems).toEqual([]);
  });

  test("flips hasMore=false when the response is shorter than pageSize", async () => {
    const store = createAuditPageStore();
    const fetchAuditLogs = mock(async () => ({
      items: [
        makeEntry({ id: "older-1", timestamp: "2026-04-20T09:00:00.000Z" }),
      ],
    }));
    await store.loadOlder({
      fetchAuditLogs:
        fetchAuditLogs as unknown as typeof import("../api/client").getAuditLogs,
      live: () => [
        makeEntry({ id: "live-1", timestamp: "2026-04-20T10:00:00.000Z" }),
      ],
      pageSize: 50,
    });
    expect(store.state().hasMore).toBe(false);
  });
});

describe("loadOlder / failure path", () => {
  test("records the error message in state.loadError without swallowing", async () => {
    const store = createAuditPageStore();
    const fetchAuditLogs = mock(async () => {
      throw new Error("network down");
    });
    await store.loadOlder({
      fetchAuditLogs:
        fetchAuditLogs as unknown as typeof import("../api/client").getAuditLogs,
      live: () => [makeEntry({ id: "live-1" })],
    });
    const s = store.state();
    expect(s.loadError).toBe("network down");
    expect(s.loadingMore).toBe(false);
    // Failure does not flip hasMore — the user can retry.
    expect(s.hasMore).toBe(true);
  });

  test("falls back to String(err) for thrown non-Error values", async () => {
    const store = createAuditPageStore();
    const fetchAuditLogs = mock(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "boom";
    });
    await store.loadOlder({
      fetchAuditLogs:
        fetchAuditLogs as unknown as typeof import("../api/client").getAuditLogs,
      live: () => [makeEntry({ id: "live-1" })],
    });
    expect(store.state().loadError).toBe("boom");
  });
});

describe("loadOlder / stale-response handling", () => {
  test("a setFilter that lands during a load discards the in-flight response", async () => {
    const store = createAuditPageStore();
    const pending = defer<{ items: AuditLogEntryLike[] }>();
    const fetchAuditLogs = mock(() => pending.promise);
    const liveItems = [makeEntry({ id: "live-1" })];

    const inflight = store.loadOlder({
      fetchAuditLogs:
        fetchAuditLogs as unknown as typeof import("../api/client").getAuditLogs,
      live: () => liveItems,
    });
    // The user changes the filter while the request is in flight.
    store.setFilter(
      { domain: "hostexec", sessionContains: "", activeOnly: false },
      new Set(),
    );
    // Now the original network call resolves with rows that belong to
    // the previous filter.
    pending.resolve({
      items: [makeEntry({ id: "leak", timestamp: "2026-04-20T08:00:00.000Z" })],
    });
    await inflight;
    const s = store.state();
    // The reset already cleared the older pool; the stale response
    // must not re-introduce any entries.
    expect(s.olderItems).toEqual([]);
    // Server filter reflects the new selection, not the old.
    expect(s.serverFilter.domain).toBe("hostexec");
  });
});

describe("loadOlder / re-entrancy and exhaustion guards", () => {
  test("returns immediately when loadingMore is already true", async () => {
    const store = createAuditPageStore();
    const pending = defer<{ items: AuditLogEntryLike[] }>();
    const fetchAuditLogs = mock(() => pending.promise);
    const liveItems = [makeEntry({ id: "live-1" })];

    const first = store.loadOlder({
      fetchAuditLogs:
        fetchAuditLogs as unknown as typeof import("../api/client").getAuditLogs,
      live: () => liveItems,
    });
    // loadingMore is now true because the first fetch has not resolved.
    expect(store.state().loadingMore).toBe(true);
    await store.loadOlder({
      fetchAuditLogs:
        fetchAuditLogs as unknown as typeof import("../api/client").getAuditLogs,
      live: () => liveItems,
    });
    // The second call must not have triggered another fetch.
    expect(fetchAuditLogs).toHaveBeenCalledTimes(1);
    pending.resolve({ items: [] });
    await first;
  });

  test("returns immediately when hasMore is false", async () => {
    const store = createAuditPageStore();
    // Drive the store into the exhausted state first.
    const fetchEmpty = mock(async () => ({ items: [] }));
    await store.loadOlder({
      fetchAuditLogs:
        fetchEmpty as unknown as typeof import("../api/client").getAuditLogs,
      live: () => [makeEntry({ id: "live-1" })],
    });
    expect(store.state().hasMore).toBe(false);

    const fetchAuditLogs = mock(async () => ({ items: [] }));
    await store.loadOlder({
      fetchAuditLogs:
        fetchAuditLogs as unknown as typeof import("../api/client").getAuditLogs,
      live: () => [makeEntry({ id: "live-1" })],
    });
    expect(fetchAuditLogs).not.toHaveBeenCalled();
  });

  test("returns immediately when no cursor is available (empty live + empty older)", async () => {
    const store = createAuditPageStore();
    const fetchAuditLogs = mock(async () => ({ items: [] }));
    await store.loadOlder({
      fetchAuditLogs:
        fetchAuditLogs as unknown as typeof import("../api/client").getAuditLogs,
      live: () => [],
    });
    expect(fetchAuditLogs).not.toHaveBeenCalled();
  });
});
