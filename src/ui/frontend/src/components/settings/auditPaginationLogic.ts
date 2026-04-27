/**
 * Pure helpers backing the Audit settings page.
 *
 * The page combines two streams of audit entries:
 *
 *   - A live window of the most recent entries delivered over SSE
 *     (`auditStore.entries()`).
 *   - An older-history pool fetched in pages from `GET /api/audit`
 *     when the user scrolls toward the bottom of the table.
 *
 * The reducer here is responsible for the older-history pool only: the
 * live window is owned by `auditStore` and is composed in at render
 * time via `mergeAuditEntries`.
 *
 * Stale-response handling
 * -----------------------
 *
 * Every state transition that initiates work (`reset`, `startLoad`)
 * bumps a generation counter (`fetchGen`). The async actions that
 * report results (`loadSucceeded`, `loadFailed`, `loadEmpty`) carry the
 * generation that issued them; the reducer compares against the
 * current `fetchGen` and discards mismatches outright. This is the
 * mechanism that prevents an in-flight response from a previous filter
 * from clobbering the older-history pool after the user changes the
 * filter mid-flight.
 *
 * Scope
 * -----
 *
 * The reducer is intentionally pure: it never calls `fetch` and never
 * touches the network. Callers wire it up to the network through
 * `auditPageStore.ts`, which dispatches actions while owning the
 * lifetime of in-flight requests.
 */

import type { AuditLogEntryLike } from "../../stores/types";

/**
 * Subset of the display filter that maps onto the backend's
 * `GET /api/audit` query parameters. Pinning this as a separate type
 * keeps "what gets sent on the wire" decoupled from "what the user
 * sees in the filter bar".
 */
export type AuditServerFilter = {
  domain?: "network" | "hostexec";
  sessions?: string[];
  sessionContains?: string;
};

/**
 * UI-facing filter state owned by the settings page. The three fields
 * mirror the three filter controls and are the source of truth for
 * both the server query (`buildServerFilter`) and the client-side
 * post-filter (`applyDisplayFilter`).
 *
 * `domain` carries an extra `"all"` sentinel that the server filter
 * does not accept; the conversion happens in `buildServerFilter`.
 */
export type AuditDisplayFilter = {
  domain: "all" | "network" | "hostexec";
  sessionContains: string;
  activeOnly: boolean;
};

/**
 * Reducer state for the older-history pool of the Audit page.
 *
 * `serverFilter` is held inside the state so the async loader can
 * snapshot the filter that was current when its `startLoad` ran; the
 * generation counter alone is enough to discard stale responses, but
 * keeping the filter in state lets the loader build its query without
 * round-tripping through component-level signals.
 */
export type AuditPageState = {
  serverFilter: AuditServerFilter;
  displayFilter: AuditDisplayFilter;
  olderItems: AuditLogEntryLike[];
  hasMore: boolean;
  loadingMore: boolean;
  loadError: string | null;
  fetchGen: number;
};

/**
 * Action union dispatched into `cursorReducer`.
 *
 * `loadSucceeded` / `loadFailed` / `loadEmpty` carry the generation
 * that issued the request so the reducer can compare against
 * `fetchGen` and drop responses that arrived after the user changed
 * the filter (or otherwise bumped the generation).
 *
 * `startLoad` bumps `fetchGen` itself, which means it also invalidates
 * any in-flight load issued by an earlier `startLoad` from the same
 * caller. The store's `loadingMore` guard normally prevents that
 * reentry, but the bump is the belt-and-braces guarantee: if a
 * re-entrant call ever slipped past the guard, the older in-flight
 * response would still be discarded when its
 * `loadSucceeded`/`loadFailed`/`loadEmpty` arrived carrying the
 * pre-bump generation.
 */
export type AuditPageAction =
  | {
      type: "reset";
      serverFilter: AuditServerFilter;
      displayFilter: AuditDisplayFilter;
    }
  | { type: "startLoad" }
  | {
      type: "loadSucceeded";
      gen: number;
      items: AuditLogEntryLike[];
      pageSize: number;
    }
  | { type: "loadFailed"; gen: number; error: string }
  | { type: "loadEmpty"; gen: number };

const INITIAL_DISPLAY_FILTER: AuditDisplayFilter = {
  domain: "all",
  sessionContains: "",
  activeOnly: true,
};

export const initialAuditPageState: AuditPageState = {
  serverFilter: {},
  displayFilter: INITIAL_DISPLAY_FILTER,
  olderItems: [],
  hasMore: true,
  loadingMore: false,
  loadError: null,
  fetchGen: 0,
};

/**
 * Pure reducer for the older-history pool.
 *
 * Each of the async-result actions starts with a generation check. A
 * mismatched generation returns the state object unchanged (referential
 * equality holds), which lets Solid's signal equality short-circuit
 * downstream effects.
 */
export function cursorReducer(
  state: AuditPageState,
  action: AuditPageAction,
): AuditPageState {
  switch (action.type) {
    case "reset":
      // Drop the older-history pool, bump the generation so any
      // in-flight loader's response is discarded, and pick up the new
      // server / display filter pair.
      return {
        serverFilter: action.serverFilter,
        displayFilter: action.displayFilter,
        olderItems: [],
        hasMore: true,
        loadingMore: false,
        loadError: null,
        fetchGen: state.fetchGen + 1,
      };
    case "startLoad":
      // Bump the generation so two classes of stale response are
      // discarded when their `loadSucceeded` / `loadFailed` /
      // `loadEmpty` arrives carrying the pre-bump gen:
      //   1. A fresh `reset` that lands between this action and the
      //      eventual response (the canonical mid-flight filter
      //      change).
      //   2. A re-entrant `startLoad` from the same caller — the
      //      store's `loadingMore` guard normally prevents this, but
      //      the bump is the belt-and-braces guarantee that any prior
      //      in-flight response is invalidated even if a re-entrant
      //      call ever slipped past the guard.
      return {
        ...state,
        loadingMore: true,
        loadError: null,
        fetchGen: state.fetchGen + 1,
      };
    case "loadSucceeded": {
      if (action.gen !== state.fetchGen) return state;
      const merged = mergeAuditEntries(state.olderItems, action.items);
      // Fewer items than the requested page size means the backend has
      // run out of matching history; stop chaining further loads.
      const exhausted = action.items.length < action.pageSize;
      return {
        ...state,
        olderItems: merged,
        loadingMore: false,
        hasMore: !exhausted,
        loadError: null,
      };
    }
    case "loadFailed": {
      if (action.gen !== state.fetchGen) return state;
      return {
        ...state,
        loadingMore: false,
        loadError: action.error,
      };
    }
    case "loadEmpty": {
      if (action.gen !== state.fetchGen) return state;
      return {
        ...state,
        loadingMore: false,
        hasMore: false,
        loadError: null,
      };
    }
  }
}

/**
 * Merge two audit-entry lists, dedupe by `id`, and return them sorted
 * newest-first by ISO timestamp.
 *
 * Comparing ISO-8601 timestamps lexicographically matches numeric
 * ordering as long as every entry uses the same format (which the
 * daemon guarantees). Deduplication handles the case where the live
 * SSE window and the older-history pool overlap by a few entries: the
 * later occurrence wins, matching the order the entries are merged.
 */
export function mergeAuditEntries(
  live: AuditLogEntryLike[],
  older: AuditLogEntryLike[],
): AuditLogEntryLike[] {
  const byId = new Map<string, AuditLogEntryLike>();
  for (const e of older) byId.set(e.id, e);
  for (const e of live) byId.set(e.id, e);
  const merged = Array.from(byId.values());
  merged.sort((a, b) => {
    if (a.timestamp < b.timestamp) return 1;
    if (a.timestamp > b.timestamp) return -1;
    return 0;
  });
  return merged;
}

/**
 * Apply the user-facing display filter to a list of audit entries.
 *
 * The live SSE window arrives unfiltered, so this helper applies the
 * three controls client-side. The `sessionContains` match is
 * case-sensitive on purpose: the backend uses the same semantics
 * (`src/audit/store.ts`), so the two filters agree on what counts as
 * a match across the live window and the older-history pool.
 *
 * `activeIds` carries the union of running-container session ids and
 * pending-approval session ids; the page recomputes that set on every
 * change to either source so this helper can stay pure.
 */
export function applyDisplayFilter(
  rows: AuditLogEntryLike[],
  filter: AuditDisplayFilter,
  activeIds: ReadonlySet<string>,
): AuditLogEntryLike[] {
  let result = rows;
  if (filter.activeOnly) {
    result = result.filter((e) => activeIds.has(e.sessionId));
  }
  if (filter.domain !== "all") {
    const domain = filter.domain;
    result = result.filter((e) => e.domain === domain);
  }
  if (filter.sessionContains !== "") {
    const needle = filter.sessionContains;
    result = result.filter((e) => e.sessionId.includes(needle));
  }
  return result;
}

/**
 * Translate the user-facing display filter into the wire-format the
 * backend's `GET /api/audit` accepts.
 *
 * `activeIds` becomes the `sessions` membership filter when
 * `activeOnly` is on; the set is sorted before serialization so the
 * resulting `serverFilterKey` is stable across permutations of the
 * input. When `activeOnly` is off the field is omitted, which the
 * backend treats as "every session".
 */
export function buildServerFilter(
  filter: AuditDisplayFilter,
  activeIds: ReadonlySet<string>,
): AuditServerFilter {
  const out: AuditServerFilter = {};
  if (filter.domain !== "all") out.domain = filter.domain;
  if (filter.sessionContains !== "") {
    out.sessionContains = filter.sessionContains;
  }
  if (filter.activeOnly) {
    out.sessions = Array.from(activeIds).sort();
  }
  return out;
}

/**
 * Stable string identity for an `AuditServerFilter`.
 *
 * Two filters that differ only in the order of `sessions` or in the
 * insertion order of optional fields produce the same key. The output
 * is suitable for use as a `createEffect` dependency or as a
 * `Map`/`Set` key.
 */
export function serverFilterKey(filter: AuditServerFilter): string {
  return JSON.stringify({
    domain: filter.domain ?? null,
    sessions:
      filter.sessions !== undefined ? [...filter.sessions].sort() : null,
    sessionContains: filter.sessionContains ?? null,
  });
}

/**
 * Decide whether a fresh `(displayFilter, activeIds)` pair represents
 * a real change to the wire-format filter that should clear the
 * older-history pool, or merely an `activeIds` mutation that does not
 * affect the server query.
 *
 * The Audit page's filter effect runs every time `activeIds` changes
 * (because `activeIds` is a reactive dependency of the SSE-driven
 * sessions and pending stores). Without this guard, an SSE update
 * that just adds or removes a session from `activeIds` while
 * `activeOnly` is off — or while it leaves the resulting `sessions`
 * list unchanged — would still trigger a `reset` and discard the
 * loaded older pool.
 *
 * Two server filters are considered equal when their `serverFilterKey`
 * strings match; this is the same identity the rest of the module
 * uses for `Map`/`Set` keys and `createEffect` dependencies.
 */
export function shouldResetFilter(
  nextDisplayFilter: AuditDisplayFilter,
  nextActiveIds: ReadonlySet<string>,
  currentServerFilter: AuditServerFilter,
): boolean {
  const nextServerFilter = buildServerFilter(nextDisplayFilter, nextActiveIds);
  return (
    serverFilterKey(nextServerFilter) !== serverFilterKey(currentServerFilter)
  );
}

/**
 * Return the oldest timestamp among the given rows, suitable as a
 * `before` cursor for the next `GET /api/audit` page. Returns
 * `undefined` when the list is empty so callers can branch on "no
 * cursor yet" without inspecting timestamps.
 */
export function oldestCursor(rows: AuditLogEntryLike[]): string | undefined {
  let oldest: string | undefined;
  for (const row of rows) {
    if (oldest === undefined || row.timestamp < oldest) {
      oldest = row.timestamp;
    }
  }
  return oldest;
}
