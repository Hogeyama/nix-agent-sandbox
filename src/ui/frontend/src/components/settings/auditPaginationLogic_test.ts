/**
 * Tests for the pure helpers behind the Audit settings page.
 *
 * The reducer pins the stale-response contract: any async-result
 * action that arrives with a `gen` mismatching the current `fetchGen`
 * must leave the state unchanged. The other helpers pin
 * dedupe / sort / filter behaviour that the page layer composes
 * directly.
 */

import { describe, expect, test } from "bun:test";
import type { AuditLogEntryLike } from "../../stores/types";
import {
  type AuditDisplayFilter,
  type AuditPageState,
  type AuditServerFilter,
  applyDisplayFilter,
  buildServerFilter,
  cursorReducer,
  initialAuditPageState,
  mergeAuditEntries,
  oldestCursor,
  serverFilterKey,
  shouldResetFilter,
} from "./auditPaginationLogic";

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

const DEFAULT_DISPLAY: AuditDisplayFilter = {
  domain: "all",
  sessionContains: "",
  activeOnly: true,
};

describe("initialAuditPageState", () => {
  test("starts with an empty older-history pool and hasMore=true", () => {
    expect(initialAuditPageState.olderItems).toEqual([]);
    expect(initialAuditPageState.hasMore).toBe(true);
    expect(initialAuditPageState.loadingMore).toBe(false);
    expect(initialAuditPageState.loadError).toBeNull();
    expect(initialAuditPageState.fetchGen).toBe(0);
  });
});

describe("cursorReducer / reset", () => {
  test("clears the older pool, bumps fetchGen, and adopts the new filters", () => {
    const start: AuditPageState = {
      ...initialAuditPageState,
      olderItems: [makeEntry({ id: "old" })],
      hasMore: false,
      loadingMore: true,
      loadError: "boom",
      fetchGen: 3,
    };
    const next = cursorReducer(start, {
      type: "reset",
      serverFilter: { domain: "network" },
      displayFilter: { ...DEFAULT_DISPLAY, domain: "network" },
    });
    expect(next.olderItems).toEqual([]);
    expect(next.hasMore).toBe(true);
    expect(next.loadingMore).toBe(false);
    expect(next.loadError).toBeNull();
    expect(next.fetchGen).toBe(4);
    expect(next.serverFilter).toEqual({ domain: "network" });
    expect(next.displayFilter.domain).toBe("network");
  });
});

describe("cursorReducer / startLoad", () => {
  test("sets loadingMore=true, clears loadError, and bumps fetchGen", () => {
    const start: AuditPageState = {
      ...initialAuditPageState,
      loadError: "previous error",
      fetchGen: 5,
    };
    const next = cursorReducer(start, { type: "startLoad" });
    expect(next.loadingMore).toBe(true);
    expect(next.loadError).toBeNull();
    expect(next.fetchGen).toBe(6);
  });
});

describe("cursorReducer / loadSucceeded", () => {
  test("appends new items, dedupes by id, and clears loadingMore on a gen match", () => {
    const start: AuditPageState = {
      ...initialAuditPageState,
      olderItems: [
        makeEntry({ id: "a", timestamp: "2026-04-20T11:00:00.000Z" }),
      ],
      loadingMore: true,
      fetchGen: 1,
    };
    const next = cursorReducer(start, {
      type: "loadSucceeded",
      gen: 1,
      pageSize: 2,
      items: [
        makeEntry({ id: "b", timestamp: "2026-04-20T10:00:00.000Z" }),
        makeEntry({ id: "c", timestamp: "2026-04-20T09:00:00.000Z" }),
      ],
    });
    expect(next.olderItems.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(next.loadingMore).toBe(false);
    expect(next.loadError).toBeNull();
    // Returned items match pageSize exactly: the backend may still
    // have more matching history, so hasMore stays true.
    expect(next.hasMore).toBe(true);
  });

  test("sets hasMore=false when the returned page is shorter than pageSize", () => {
    const start: AuditPageState = {
      ...initialAuditPageState,
      loadingMore: true,
      fetchGen: 1,
    };
    const next = cursorReducer(start, {
      type: "loadSucceeded",
      gen: 1,
      pageSize: 200,
      items: [makeEntry({ id: "z" })],
    });
    expect(next.hasMore).toBe(false);
    expect(next.loadingMore).toBe(false);
  });

  test("returns the same state reference when gen mismatches (stale response)", () => {
    const start: AuditPageState = {
      ...initialAuditPageState,
      fetchGen: 5,
      loadingMore: true,
    };
    const next = cursorReducer(start, {
      type: "loadSucceeded",
      gen: 4,
      pageSize: 200,
      items: [makeEntry({ id: "should-not-appear" })],
    });
    // Exact same object — Solid's signal equality short-circuits.
    expect(next).toBe(start);
    expect(next.olderItems).toEqual([]);
    expect(next.loadingMore).toBe(true);
  });

  test("filter mid-flight: a reset between startLoad and loadSucceeded discards the old response", () => {
    // Reproduce the canonical race: the user starts a load, changes
    // the filter mid-flight, and then the network finally returns. The
    // reducer must drop the response so it cannot leak entries that
    // belong to the previous filter into the new pool.
    let s: AuditPageState = initialAuditPageState;
    s = cursorReducer(s, {
      type: "reset",
      serverFilter: {},
      displayFilter: DEFAULT_DISPLAY,
    });
    s = cursorReducer(s, { type: "startLoad" });
    const genBeforeFilterChange = s.fetchGen;
    // Mid-flight filter change.
    s = cursorReducer(s, {
      type: "reset",
      serverFilter: { domain: "hostexec" },
      displayFilter: { ...DEFAULT_DISPLAY, domain: "hostexec" },
    });
    expect(s.fetchGen).toBeGreaterThan(genBeforeFilterChange);
    // Stale response from the original filter arrives after the reset.
    const stale = s;
    s = cursorReducer(s, {
      type: "loadSucceeded",
      gen: genBeforeFilterChange,
      pageSize: 200,
      items: [makeEntry({ id: "leak" })],
    });
    expect(s).toBe(stale);
    expect(s.olderItems).toEqual([]);
  });
});

describe("cursorReducer / loadFailed", () => {
  test("records the error and clears loadingMore on a gen match", () => {
    const start: AuditPageState = {
      ...initialAuditPageState,
      loadingMore: true,
      fetchGen: 2,
    };
    const next = cursorReducer(start, {
      type: "loadFailed",
      gen: 2,
      error: "network down",
    });
    expect(next.loadError).toBe("network down");
    expect(next.loadingMore).toBe(false);
    // Failure does not flip `hasMore` — the user can retry.
    expect(next.hasMore).toBe(true);
  });

  test("returns the same state reference when gen mismatches (stale failure)", () => {
    const start: AuditPageState = {
      ...initialAuditPageState,
      fetchGen: 5,
    };
    const next = cursorReducer(start, {
      type: "loadFailed",
      gen: 1,
      error: "stale",
    });
    expect(next).toBe(start);
    expect(next.loadError).toBeNull();
  });
});

describe("cursorReducer / loadEmpty", () => {
  test("flips hasMore=false on a gen match", () => {
    const start: AuditPageState = {
      ...initialAuditPageState,
      loadingMore: true,
      fetchGen: 7,
    };
    const next = cursorReducer(start, { type: "loadEmpty", gen: 7 });
    expect(next.hasMore).toBe(false);
    expect(next.loadingMore).toBe(false);
  });

  test("returns the same state reference when gen mismatches", () => {
    const start: AuditPageState = {
      ...initialAuditPageState,
      fetchGen: 3,
    };
    const next = cursorReducer(start, { type: "loadEmpty", gen: 1 });
    expect(next).toBe(start);
    expect(next.hasMore).toBe(true);
  });
});

describe("mergeAuditEntries", () => {
  test("dedupes by id, preferring the live entry when ids collide", () => {
    const older = [
      makeEntry({
        id: "shared",
        timestamp: "2026-04-20T09:00:00.000Z",
        reason: "older copy",
      }),
    ];
    const live = [
      makeEntry({
        id: "shared",
        timestamp: "2026-04-20T09:00:00.000Z",
        reason: "live copy",
      }),
    ];
    const merged = mergeAuditEntries(live, older);
    expect(merged.length).toBe(1);
    expect(merged[0]?.reason).toBe("live copy");
  });

  test("returns rows newest-first regardless of input order", () => {
    const merged = mergeAuditEntries(
      [makeEntry({ id: "a", timestamp: "2026-04-20T10:00:00.000Z" })],
      [
        makeEntry({ id: "b", timestamp: "2026-04-20T12:00:00.000Z" }),
        makeEntry({ id: "c", timestamp: "2026-04-20T11:00:00.000Z" }),
      ],
    );
    expect(merged.map((e) => e.id)).toEqual(["b", "c", "a"]);
  });

  test("returns an empty array when both inputs are empty", () => {
    expect(mergeAuditEntries([], [])).toEqual([]);
  });
});

describe("applyDisplayFilter", () => {
  const rows = [
    makeEntry({
      id: "n1",
      domain: "network",
      sessionId: "alpha-1",
    }),
    makeEntry({
      id: "h1",
      domain: "hostexec",
      sessionId: "alpha-2",
    }),
    makeEntry({
      id: "n2",
      domain: "network",
      sessionId: "beta-3",
    }),
  ];

  test("activeOnly=true keeps only entries whose sessionId is in the active set", () => {
    const filtered = applyDisplayFilter(
      rows,
      { ...DEFAULT_DISPLAY, activeOnly: true },
      new Set(["alpha-1", "alpha-2"]),
    );
    expect(filtered.map((r) => r.id)).toEqual(["n1", "h1"]);
  });

  test("activeOnly=false ignores the active set", () => {
    const filtered = applyDisplayFilter(
      rows,
      { ...DEFAULT_DISPLAY, activeOnly: false },
      new Set(),
    );
    expect(filtered.map((r) => r.id)).toEqual(["n1", "h1", "n2"]);
  });

  test("domain filter narrows to the chosen wire value", () => {
    const filtered = applyDisplayFilter(
      rows,
      { ...DEFAULT_DISPLAY, domain: "hostexec", activeOnly: false },
      new Set(),
    );
    expect(filtered.map((r) => r.id)).toEqual(["h1"]);
  });

  test("sessionContains is a case-sensitive substring match", () => {
    const filtered = applyDisplayFilter(
      rows,
      { ...DEFAULT_DISPLAY, sessionContains: "alpha", activeOnly: false },
      new Set(),
    );
    expect(filtered.map((r) => r.id)).toEqual(["n1", "h1"]);
    // Upper-case query does not match lower-case session ids.
    const none = applyDisplayFilter(
      rows,
      { ...DEFAULT_DISPLAY, sessionContains: "ALPHA", activeOnly: false },
      new Set(),
    );
    expect(none.length).toBe(0);
  });

  test("composes all three filters (domain + sessionContains + activeOnly)", () => {
    const filtered = applyDisplayFilter(
      rows,
      {
        domain: "network",
        sessionContains: "alpha",
        activeOnly: true,
      },
      new Set(["alpha-1"]),
    );
    expect(filtered.map((r) => r.id)).toEqual(["n1"]);
  });
});

describe("buildServerFilter", () => {
  test("omits domain when set to all", () => {
    const f = buildServerFilter(
      { domain: "all", sessionContains: "", activeOnly: false },
      new Set(),
    );
    expect(f).toEqual({});
  });

  test("forwards domain=network and a sorted sessions list when activeOnly is on", () => {
    const f = buildServerFilter(
      { domain: "network", sessionContains: "", activeOnly: true },
      new Set(["c", "a", "b"]),
    );
    expect(f.domain).toBe("network");
    expect(f.sessions).toEqual(["a", "b", "c"]);
  });

  test("omits sessions when activeOnly is off", () => {
    const f = buildServerFilter(
      { domain: "all", sessionContains: "abc", activeOnly: false },
      new Set(["x", "y"]),
    );
    expect(f.sessions).toBeUndefined();
    expect(f.sessionContains).toBe("abc");
  });

  test("omits sessionContains when the value is an empty string", () => {
    const f = buildServerFilter(
      { domain: "all", sessionContains: "", activeOnly: false },
      new Set(),
    );
    expect(f.sessionContains).toBeUndefined();
  });
});

describe("serverFilterKey", () => {
  test("two equivalent filters produce the same key regardless of session order", () => {
    const a: AuditServerFilter = {
      domain: "network",
      sessions: ["b", "a"],
    };
    const b: AuditServerFilter = {
      domain: "network",
      sessions: ["a", "b"],
    };
    expect(serverFilterKey(a)).toBe(serverFilterKey(b));
  });

  test("differing filters produce distinct keys", () => {
    const a: AuditServerFilter = { domain: "network" };
    const b: AuditServerFilter = { domain: "hostexec" };
    expect(serverFilterKey(a)).not.toBe(serverFilterKey(b));
  });

  test("two empty filters share a stable key", () => {
    expect(serverFilterKey({})).toBe(serverFilterKey({}));
  });
});

describe("oldestCursor", () => {
  test("returns the smallest ISO timestamp among the input rows", () => {
    const rows = [
      makeEntry({ id: "a", timestamp: "2026-04-20T10:00:00.000Z" }),
      makeEntry({ id: "b", timestamp: "2026-04-20T08:00:00.000Z" }),
      makeEntry({ id: "c", timestamp: "2026-04-20T09:00:00.000Z" }),
    ];
    expect(oldestCursor(rows)).toBe("2026-04-20T08:00:00.000Z");
  });

  test("returns undefined for an empty input", () => {
    expect(oldestCursor([])).toBeUndefined();
  });
});

describe("shouldResetFilter", () => {
  test("returns false when the display filter and activeIds produce the same server filter", () => {
    // Page reads `serverFilter` straight from the store state. When
    // `activeOnly` is off, mutating `activeIds` does not change the
    // wire-format filter, so the pool must survive.
    const display: AuditDisplayFilter = {
      domain: "network",
      sessionContains: "abc",
      activeOnly: false,
    };
    const current = buildServerFilter(display, new Set(["s1"]));
    expect(shouldResetFilter(display, new Set(["s2", "s3"]), current)).toBe(
      false,
    );
  });

  test("returns false when activeIds is reordered but serialises to the same sorted list", () => {
    const display: AuditDisplayFilter = {
      domain: "all",
      sessionContains: "",
      activeOnly: true,
    };
    const current = buildServerFilter(display, new Set(["a", "b", "c"]));
    // Same membership, different insertion order — `buildServerFilter`
    // sorts before serialising, so the keys must match.
    expect(shouldResetFilter(display, new Set(["c", "a", "b"]), current)).toBe(
      false,
    );
  });

  test("returns true when the display filter changes the wire-format filter", () => {
    const oldDisplay: AuditDisplayFilter = {
      domain: "all",
      sessionContains: "",
      activeOnly: false,
    };
    const newDisplay: AuditDisplayFilter = {
      domain: "network",
      sessionContains: "",
      activeOnly: false,
    };
    const current = buildServerFilter(oldDisplay, new Set());
    expect(shouldResetFilter(newDisplay, new Set(), current)).toBe(true);
  });

  test("returns true when activeOnly is on and activeIds membership changes", () => {
    const display: AuditDisplayFilter = {
      domain: "all",
      sessionContains: "",
      activeOnly: true,
    };
    const current = buildServerFilter(display, new Set(["s1"]));
    // `activeOnly` is on, so the new session id flows into the
    // `sessions` field of the wire filter and the key changes.
    expect(shouldResetFilter(display, new Set(["s1", "s2"]), current)).toBe(
      true,
    );
  });

  test("returns true when the initial empty server filter meets a non-trivial display filter on first mount", () => {
    // Mirrors the first user interaction after mount: the store's
    // `serverFilter` is `{}`, the user sets a real filter, and the
    // effect must dispatch `setFilter`.
    const display: AuditDisplayFilter = {
      domain: "hostexec",
      sessionContains: "",
      activeOnly: false,
    };
    expect(shouldResetFilter(display, new Set(), {})).toBe(true);
  });
});
