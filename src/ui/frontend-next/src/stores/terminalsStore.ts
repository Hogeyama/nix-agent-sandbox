/**
 * Solid store for the terminals (dtach) pane.
 *
 * Tracks five pieces of state:
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
 *     `pendingActivateId` is cleared back to null. The same bridge is
 *     reused by the shell-spawn flow.
 *   - `viewBySession`: the per-agent toggle position between the agent
 *     terminal and the spawned shell. `selectSession(agentId)` consults
 *     this map so re-entering an agent restores the view the user left
 *     it on. `setDtachSessions` reconciles the map against the snapshot
 *     so dead agents and exited shells cannot leak entries.
 *   - `inFlightShellSpawn`: the set of agent session ids whose shell
 *     spawn request is currently outstanding. Acts as a per-agent guard
 *     so a double-click cannot issue two `POST /shell` requests in
 *     parallel for the same container.
 *
 * Accessors are exposed as functions (not raw stores) so consumers
 * cannot mutate the underlying Solid store shape directly.
 */

import { createStore, produce } from "solid-js/store";
import { parseShellSessionId } from "../../../shell_session_id";
import {
  findShellForAgent,
  reconcileViewState,
  type ShellView,
} from "./shellMapping";
import type { DtachSessionLike } from "./types";

type TerminalsState = {
  dtachSessions: DtachSessionLike[];
  activeId: string | null;
  pendingActivateId: string | null;
  viewBySession: Record<string, ShellView>;
  inFlightShellSpawn: Record<string, true>;
};

export type TerminalsStore = {
  dtachSessions: () => DtachSessionLike[];
  activeId: () => string | null;
  pendingActivateId: () => string | null;
  /**
   * Replace the dtach session list with the latest SSE snapshot and
   * reconcile selection + view map:
   *   - If `pendingActivateId` is now present in the list, promote it
   *     to `activeId` and clear pending.
   *   - If the current `activeId` is no longer present in the list
   *     (the underlying session went away), clear it.
   *   - Drop view entries for agents that are no longer in the snapshot
   *     and revert "shell" entries to "agent" when their shell session
   *     has exited. When a shell exit drops the active id, fall back
   *     to the agent's session id so the center pane stays attached
   *     to the same conceptual session.
   */
  setDtachSessions: (items: DtachSessionLike[]) => void;
  /**
   * Express the intent to activate `sessionId`, typically called right
   * after a successful launch or shell spawn. If the session is already
   * known, the activation is applied immediately. Otherwise the id is
   * stashed in `pendingActivateId` until the next `setDtachSessions`
   * snapshot confirms it. Repeated calls overwrite pending so that the
   * most recent intent wins.
   */
  requestActivate: (sessionId: string) => void;
  /**
   * Set `activeId` directly without consulting the dtach list. Used by
   * the row click handler for already-known sessions and by the shell
   * toggle path when switching back to an existing agent or shell id.
   */
  setActive: (sessionId: string | null) => void;
  /**
   * Switch the center pane to the given agent session, restoring the
   * agent's last-viewed terminal kind. When `viewBySession[agentId]`
   * is "shell" and the live snapshot still carries that agent's shell,
   * the active id resolves to the shell session id; otherwise the
   * active id resolves to the agent id and the view map is rolled
   * back to "agent" so the next snapshot does not flicker.
   */
  selectSession: (agentId: string) => void;
  /**
   * Per-agent view-position accessors. `getViewFor` returns `undefined`
   * when the user has not interacted with the toggle for the given
   * agent yet; consumers default to "agent" in that case.
   */
  setViewFor: (agentId: string, view: ShellView) => void;
  getViewFor: (agentId: string) => ShellView | undefined;
  /**
   * Atomic check-and-set guard for the shell spawn request. Returns
   * true on the first call for a given agent id and false on every
   * subsequent call until `clearShellSpawnInFlight` runs. The caller
   * starts the HTTP request only when the return value is true.
   */
  tryBeginShellSpawn: (agentId: string) => boolean;
  clearShellSpawnInFlight: (agentId: string) => void;
  isShellSpawnInFlight: (agentId: string) => boolean;
};

export function createTerminalsStore(): TerminalsStore {
  const [state, setState] = createStore<TerminalsState>({
    dtachSessions: [],
    activeId: null,
    pendingActivateId: null,
    viewBySession: {},
    inFlightShellSpawn: {},
  });

  function setActive(sessionId: string | null): void {
    setState("activeId", sessionId);
  }

  function deriveAgentSessionIds(
    items: readonly DtachSessionLike[],
  ): Set<string> {
    // An agent dtach session is any entry whose id does not parse as a
    // shell id; the parser owns the grammar so this stays consistent
    // with the daemon's view of "is this id a shell?".
    const out = new Set<string>();
    for (const it of items) {
      if (parseShellSessionId(it.sessionId) === null) {
        out.add(it.sessionId);
      }
    }
    return out;
  }

  return {
    dtachSessions: () => state.dtachSessions,
    activeId: () => state.activeId,
    pendingActivateId: () => state.pendingActivateId,
    setDtachSessions: (items) => {
      const agentSessionIds = deriveAgentSessionIds(items);
      const reconciled = reconcileViewState({
        prevView: state.viewBySession,
        agentSessionIds,
        dtachSessions: items,
      });
      setState(
        produce((s) => {
          s.dtachSessions = items;
          s.viewBySession = reconciled.nextView;
          const ids = new Set(items.map((it) => it.sessionId));
          if (s.pendingActivateId !== null && ids.has(s.pendingActivateId)) {
            s.activeId = s.pendingActivateId;
            s.pendingActivateId = null;
          }
          if (s.activeId !== null && !ids.has(s.activeId)) {
            // If the gone-away active id was a shell whose parent agent
            // is still alive and just had its view reverted to agent,
            // attach to the agent so the center pane does not blank.
            const parsed = parseShellSessionId(s.activeId);
            if (
              parsed !== null &&
              reconciled.shellsExited.includes(parsed.parentSessionId) &&
              ids.has(parsed.parentSessionId)
            ) {
              s.activeId = parsed.parentSessionId;
            } else {
              s.activeId = null;
            }
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
    setActive,
    selectSession: (agentId) => {
      const view = state.viewBySession[agentId];
      if (view === "shell") {
        const shell = findShellForAgent(agentId, state.dtachSessions);
        if (shell !== null) {
          setActive(shell.sessionId);
          return;
        }
        // The shell that was being viewed has exited; fall back to the
        // agent and roll the view map back so the next selectSession
        // call does not chase a non-existent shell again.
        setState(
          produce((s) => {
            s.viewBySession[agentId] = "agent";
          }),
        );
      }
      setActive(agentId);
    },
    setViewFor: (agentId, view) => {
      setState(
        produce((s) => {
          s.viewBySession[agentId] = view;
        }),
      );
    },
    getViewFor: (agentId) => state.viewBySession[agentId],
    tryBeginShellSpawn: (agentId) => {
      if (state.inFlightShellSpawn[agentId] === true) return false;
      setState(
        produce((s) => {
          s.inFlightShellSpawn[agentId] = true;
        }),
      );
      return true;
    },
    clearShellSpawnInFlight: (agentId) => {
      setState(
        produce((s) => {
          delete s.inFlightShellSpawn[agentId];
        }),
      );
    },
    isShellSpawnInFlight: (agentId) =>
      state.inFlightShellSpawn[agentId] === true,
  };
}
