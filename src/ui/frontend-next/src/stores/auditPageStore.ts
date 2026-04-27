/**
 * Solid store backing the Audit settings page.
 *
 * The store wraps `cursorReducer` (in
 * `src/ui/frontend-next/src/components/settings/auditPaginationLogic.ts`)
 * with the network plumbing the reducer intentionally avoids:
 *
 *   - `setFilter` rebuilds the server filter from the new display
 *     filter and dispatches `reset`, which clears the older-history
 *     pool and bumps the generation counter.
 *   - `loadOlder` snapshots the current generation, fires off
 *     `getAuditLogs`, and dispatches `loadSucceeded` / `loadFailed` /
 *     `loadEmpty` carrying the captured generation. The reducer then
 *     drops responses that arrived after a competing `reset` /
 *     `startLoad` bumped the counter.
 *
 * The store is independent of `auditStore.ts`, which feeds the
 * recent-50 accordion in the pending pane. The two paths share only
 * the wire shape (`AuditLogEntryLike`); their state machines, render
 * paths, and SSE subscriptions are disjoint.
 */

import { createStore } from "solid-js/store";
import type { getAuditLogs } from "../api/client";
import {
  type AuditDisplayFilter,
  type AuditPageState,
  buildServerFilter,
  cursorReducer,
  initialAuditPageState,
  oldestCursor,
} from "../components/settings/auditPaginationLogic";
import type { AuditLogEntryLike } from "./types";

/**
 * Default page size for `loadOlder`. Matches the existing audit
 * scroller so the two frontends request batches of the same shape
 * from the daemon.
 */
export const DEFAULT_AUDIT_PAGE_SIZE = 200;

export type AuditPageStore = {
  /** Reactive accessor for the current reducer state. */
  state: () => AuditPageState;
  /**
   * Apply a new display filter. The store derives the server-side
   * filter from `filter` + `activeIds` and dispatches a `reset`,
   * which clears the older-history pool and invalidates any
   * in-flight loader.
   */
  setFilter: (
    filter: AuditDisplayFilter,
    activeIds: ReadonlySet<string>,
  ) => void;
  /**
   * Fetch the next page of older entries, using the oldest known
   * timestamp (across the live window and the current older pool) as
   * the `before` cursor. Re-entrant calls and calls after the backend
   * has signalled exhaustion (`hasMore === false`) are no-ops.
   *
   * Errors from `fetchAuditLogs` surface through `state().loadError`
   * so the UI can render a retry button; failures are never
   * swallowed.
   */
  loadOlder: (deps: {
    fetchAuditLogs: typeof getAuditLogs;
    live: () => AuditLogEntryLike[];
    pageSize?: number;
  }) => Promise<void>;
};

export function createAuditPageStore(): AuditPageStore {
  // `createStore` wraps the seed object in a reactive proxy that
  // observes — and may mutate — every nested property. Sharing a
  // module-level constant as the seed would cause two stores
  // constructed in the same process to read each other's state, so
  // the seed is always a fresh copy of `initialAuditPageState` with
  // its own array allocation for `olderItems`.
  const [state, setState] = createStore<{ value: AuditPageState }>({
    value: { ...initialAuditPageState, olderItems: [] },
  });
  const dispatch = (action: Parameters<typeof cursorReducer>[1]) => {
    setState("value", (prev) => cursorReducer(prev, action));
  };

  return {
    state: () => state.value,
    setFilter: (filter, activeIds) => {
      dispatch({
        type: "reset",
        serverFilter: buildServerFilter(filter, activeIds),
        displayFilter: filter,
      });
    },
    loadOlder: async ({ fetchAuditLogs, live, pageSize }) => {
      const size = pageSize ?? DEFAULT_AUDIT_PAGE_SIZE;
      const current = state.value;
      // Re-entrancy and exhaustion guards: the sentinel can fire
      // multiple times in quick succession while a load is already in
      // flight, and once the backend has signalled exhaustion any
      // further call would just confirm the empty page.
      if (current.loadingMore || !current.hasMore) return;

      // Compute the cursor from the union of the live SSE window and
      // the older pool — using just one of them would miss a row when
      // the live window is shorter than the older pool's tail (or
      // vice-versa) and the user scrolls fast.
      const before = oldestCursor([...live(), ...current.olderItems]);
      if (before === undefined) return;

      // Snapshot the filter that was current when the load started.
      // The reducer's `startLoad` bumps `fetchGen`; the post-await
      // dispatch carries this snapshot back so the reducer can drop
      // the response if a competing `reset` / `startLoad` bumped the
      // counter while the request was in flight.
      const filterSnapshot = current.serverFilter;
      dispatch({ type: "startLoad" });
      const gen = state.value.fetchGen;

      try {
        const res = await fetchAuditLogs({
          ...filterSnapshot,
          before,
          limit: size,
        });
        const items = res.items;
        if (items.length === 0) {
          dispatch({ type: "loadEmpty", gen });
        } else {
          dispatch({
            type: "loadSucceeded",
            gen,
            items,
            pageSize: size,
          });
        }
      } catch (err) {
        // Surface the failure verbatim. `Error.message` covers both
        // `HttpError` (which carries the daemon's JSON error body or
        // the HTTP statusText) and any other exception thrown from
        // `fetch`; `String(err)` is the safety net for thrown
        // non-Error values so the failure is never silently dropped.
        const message = err instanceof Error ? err.message : String(err);
        dispatch({ type: "loadFailed", gen, error: message });
      }
    },
  };
}
