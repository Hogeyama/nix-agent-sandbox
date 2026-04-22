import type { DtachSession } from "./api.ts";

/**
 * Pure-functional state container for the terminal modal UI: dtach session
 * list, open tabs, active tab, and modal visibility. The set-dtach-sessions
 * action also reconciles open/active/visible against the live set.
 */

export interface TerminalUiState {
  readonly dtachSessions: DtachSession[];
  readonly openSessionIds: string[];
  readonly activeSessionId: string | null;
  readonly visible: boolean;
}

export const initialTerminalUiState: TerminalUiState = {
  dtachSessions: [],
  openSessionIds: [],
  activeSessionId: null,
  visible: false,
};

export type TerminalUiAction =
  /**
   * Replace the live dtach session list (SSE `terminal:sessions` or initial
   * `GET /api/terminal/sessions`). Reconciles `openSessionIds`,
   * `activeSessionId`, and `visible` against the new live set so a separate
   * caller-side reconcile pass is unnecessary.
   */
  | { type: "set-dtach-sessions"; sessions: DtachSession[] }
  /**
   * User clicked "attach" on an existing live session. Idempotent w.r.t.
   * `openSessionIds`.
   */
  | { type: "attach"; sessionId: string }
  /**
   * Optimistic insert of a freshly started shell session before the SSE
   * `terminal:sessions` catch-up arrives. Idempotent against both
   * `dtachSessions` and `openSessionIds`.
   */
  | { type: "shell-started"; sessionId: string; createdAt: number }
  /** User selected a tab in the modal (also re-attaches if not currently open). */
  | { type: "select-tab"; sessionId: string }
  /** User closed a tab in the modal. */
  | { type: "close-tab"; sessionId: string }
  /** User minimized the modal. Open tabs are preserved. */
  | { type: "minimize" }
  /** User restored the modal from the minimized bar. */
  | { type: "restore" };

function dtachListEqual(a: DtachSession[], b: DtachSession[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.sessionId !== y.sessionId ||
      x.name !== y.name ||
      x.socketPath !== y.socketPath ||
      x.createdAt !== y.createdAt
    ) {
      return false;
    }
  }
  return true;
}

export function terminalUiReducer(
  state: TerminalUiState,
  action: TerminalUiAction,
): TerminalUiState {
  switch (action.type) {
    case "set-dtach-sessions": {
      const dtachUnchanged = dtachListEqual(
        state.dtachSessions,
        action.sessions,
      );
      const liveIds = new Set(action.sessions.map((s) => s.sessionId));

      const filteredOpen = state.openSessionIds.filter((id) => liveIds.has(id));
      const openUnchanged =
        filteredOpen.length === state.openSessionIds.length &&
        filteredOpen.every((id, i) => id === state.openSessionIds[i]);

      const nextActive =
        state.activeSessionId && liveIds.has(state.activeSessionId)
          ? state.activeSessionId
          : (filteredOpen[0] ?? null);

      const nextVisible = filteredOpen.length === 0 ? false : state.visible;

      // Reference-equality optimization: when nothing observable changes,
      // return the same `state` so child components (TerminalModal) skip
      // re-render via memo.
      if (
        dtachUnchanged &&
        openUnchanged &&
        nextActive === state.activeSessionId &&
        nextVisible === state.visible
      ) {
        return state;
      }

      return {
        dtachSessions: dtachUnchanged ? state.dtachSessions : action.sessions,
        openSessionIds: openUnchanged ? state.openSessionIds : filteredOpen,
        activeSessionId: nextActive,
        visible: nextVisible,
      };
    }

    case "attach": {
      const alreadyOpen = state.openSessionIds.includes(action.sessionId);
      if (
        alreadyOpen &&
        state.activeSessionId === action.sessionId &&
        state.visible
      ) {
        return state;
      }
      return {
        ...state,
        openSessionIds: alreadyOpen
          ? state.openSessionIds
          : [...state.openSessionIds, action.sessionId],
        activeSessionId: action.sessionId,
        visible: true,
      };
    }

    case "shell-started": {
      const dtachHasIt = state.dtachSessions.some(
        (s) => s.sessionId === action.sessionId,
      );
      const nextDtach = dtachHasIt
        ? state.dtachSessions
        : [
            ...state.dtachSessions,
            {
              name: action.sessionId,
              sessionId: action.sessionId,
              socketPath: "",
              createdAt: action.createdAt,
            },
          ];
      const openHasIt = state.openSessionIds.includes(action.sessionId);
      const nextOpen = openHasIt
        ? state.openSessionIds
        : [...state.openSessionIds, action.sessionId];
      return {
        dtachSessions: nextDtach,
        openSessionIds: nextOpen,
        activeSessionId: action.sessionId,
        visible: true,
      };
    }

    case "select-tab": {
      const alreadyOpen = state.openSessionIds.includes(action.sessionId);
      if (
        alreadyOpen &&
        state.activeSessionId === action.sessionId &&
        state.visible
      ) {
        return state;
      }
      return {
        ...state,
        openSessionIds: alreadyOpen
          ? state.openSessionIds
          : [...state.openSessionIds, action.sessionId],
        activeSessionId: action.sessionId,
        visible: true,
      };
    }

    case "close-tab": {
      const next = state.openSessionIds.filter((id) => id !== action.sessionId);
      // Two-branch behavior:
      //   - closing the active tab: fall back to next[0] ?? null
      //   - closing a non-active tab: keep current active if it survives,
      //     otherwise fall back to next[0] ?? null
      const activeCurrent = state.activeSessionId;
      let nextActive: string | null;
      if (activeCurrent === action.sessionId) {
        nextActive = next[0] ?? null;
      } else {
        nextActive =
          activeCurrent && next.includes(activeCurrent)
            ? activeCurrent
            : (next[0] ?? null);
      }
      const nextVisible = next.length === 0 ? false : state.visible;
      return {
        ...state,
        openSessionIds: next,
        activeSessionId: nextActive,
        visible: nextVisible,
      };
    }

    case "minimize": {
      if (!state.visible) return state;
      return { ...state, visible: false };
    }

    case "restore": {
      const nextActive =
        state.activeSessionId ?? state.openSessionIds[0] ?? null;
      if (nextActive === state.activeSessionId && state.visible) {
        return state;
      }
      return { ...state, activeSessionId: nextActive, visible: true };
    }

    default: {
      const _exhaustive: never = action;
      throw new Error(
        `Unknown TerminalUiAction: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}
