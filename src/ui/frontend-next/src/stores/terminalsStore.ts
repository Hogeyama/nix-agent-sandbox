/**
 * Solid store for the terminals (dtach) pane.
 *
 * Tracks three pieces of state:
 *
 *   - `dtachSessions`: the latest snapshot of dtach sockets pushed by the
 *     backend over SSE (`terminal:sessions`). Replaced wholesale on each
 *     push.
 *   - `activeId`: the sessionId the center pane should currently attach
 *     to. This is pure UI selection state and is intentionally kept out
 *     of `sessionsStore`, which carries agent metadata only.
 *   - `pendingActivateId`: a transient bridge used when the user issues
 *     a launch and we want the resulting terminal to auto-attach. The
 *     launch HTTP response can return before the next SSE snapshot
 *     arrives, so we record the desired sessionId here. When a
 *     subsequent `setDtachSessions` call observes that sessionId in the
 *     incoming list, the value is promoted to `activeId` and
 *     `pendingActivateId` is cleared back to null.
 *
 * Accessors are exposed as functions (not raw stores) so consumers
 * cannot mutate the underlying Solid store shape directly.
 */

import { createStore, produce } from "solid-js/store";
import type { DtachSessionLike } from "./types";

type TerminalsState = {
  dtachSessions: DtachSessionLike[];
  activeId: string | null;
  pendingActivateId: string | null;
};

export type TerminalsStore = {
  dtachSessions: () => DtachSessionLike[];
  activeId: () => string | null;
  pendingActivateId: () => string | null;
  /**
   * Replace the dtach session list with the latest SSE snapshot and
   * reconcile the selection:
   *   - If `pendingActivateId` is now present in the list, promote it
   *     to `activeId` and clear pending.
   *   - If the current `activeId` is no longer present in the list
   *     (the underlying session went away), clear it.
   */
  setDtachSessions: (items: DtachSessionLike[]) => void;
  /**
   * Express the intent to activate `sessionId`, typically called right
   * after a successful launch. If the session is already known, the
   * activation is applied immediately. Otherwise the id is stashed in
   * `pendingActivateId` until the next `setDtachSessions` snapshot
   * confirms it. Repeated calls overwrite pending so that the most
   * recent intent wins.
   */
  requestActivate: (sessionId: string) => void;
  /**
   * Set `activeId` directly without consulting the dtach list. Used by
   * the sessions row click handler to switch the center pane to an
   * already-known session.
   */
  setActive: (sessionId: string | null) => void;
};

export function createTerminalsStore(): TerminalsStore {
  const [state, setState] = createStore<TerminalsState>({
    dtachSessions: [],
    activeId: null,
    pendingActivateId: null,
  });

  return {
    dtachSessions: () => state.dtachSessions,
    activeId: () => state.activeId,
    pendingActivateId: () => state.pendingActivateId,
    setDtachSessions: (items) => {
      setState(
        produce((s) => {
          s.dtachSessions = items;
          const ids = new Set(items.map((it) => it.sessionId));
          if (s.pendingActivateId !== null && ids.has(s.pendingActivateId)) {
            s.activeId = s.pendingActivateId;
            s.pendingActivateId = null;
          }
          if (s.activeId !== null && !ids.has(s.activeId)) {
            s.activeId = null;
          }
        }),
      );
    },
    requestActivate: (sessionId) => {
      setState(
        produce((s) => {
          const present = s.dtachSessions.some(
            (it) => it.sessionId === sessionId,
          );
          if (present) {
            s.activeId = sessionId;
            // The latest intent is already reflected in activeId, so any
            // stale pending request from a previous call must be discarded
            // to prevent a future snapshot from resurrecting it.
            s.pendingActivateId = null;
          } else {
            s.pendingActivateId = sessionId;
          }
        }),
      );
    },
    setActive: (sessionId) => {
      setState("activeId", sessionId);
    },
  };
}
