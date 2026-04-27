/**
 * Pure view-helpers for the sessions pane row.
 *
 * These functions translate a normalized `SessionRow` into the small
 * presentation values that the SessionsPane component renders. Keeping
 * them as pure functions (no Solid primitives, no DOM access) lets them
 * be unit-tested in isolation and reused if the markup is restructured.
 */

import type { SessionRow } from "../stores/types";
import type { PendingCount } from "./sessionPendingSummary";

export type SessionRowDisplay = {
  /** Class string for the leading status dot. */
  dotClass: string;
  /** Trailing status badge, or `null` when no badge should render. */
  badge: { text: string; class: string } | null;
};

/**
 * Maps a session's `turn` value plus its outstanding pending counts to
 * the dot/badge presentation tuple.
 *
 * Dot precedence mirrors the favicon lamp ladder
 * (`pending > user-turn > agent-turn > idle`): when any approval is
 * pending the dot switches to the rose `pending` variant regardless of
 * the underlying turn, so the row visibly signals user intervention is
 * needed. The badge still tracks the raw turn (Turn / Busy / none), so
 * a pending agent-turn row reads as "rose dot + Busy badge" rather than
 * collapsing the turn information.
 *
 * Unknown / unrecognized turn values fall through to the default state
 * (idle dot, no badge) rather than throwing, so the UI stays robust to
 * future server-side turn values.
 */
export function describeSessionRow(
  row: SessionRow,
  pendingCount: PendingCount,
): SessionRowDisplay {
  const hasPending = pendingCount.network + pendingCount.hostexec > 0;
  switch (row.turn) {
    case "user-turn":
      return {
        dotClass: hasPending ? "session-dot pending" : "session-dot turn",
        badge: { text: "Turn", class: "badge badge-turn" },
      };
    case "agent-turn":
      return {
        dotClass: hasPending ? "session-dot pending" : "session-dot busy",
        badge: { text: "Busy", class: "badge badge-busy" },
      };
    default:
      return {
        dotClass: hasPending ? "session-dot pending" : "session-dot",
        badge: null,
      };
  }
}

export type SessionTreeDisplay = {
  /** Pre-formatted text shown in the `tree` row. */
  text: string;
  /** When true, render the dd with the `dim` class. */
  dim: boolean;
};

/**
 * Formats a session's worktree/baseBranch pair for the meta row.
 *
 * - With a worktree: `"<wt> ← <base>"` and `dim: false`.
 * - Without a worktree: `"— direct on <base>"` and `dim: true` so the
 *   row visually recedes.
 *
 * `baseBranch` defaults to `"main"` when null/undefined.
 */
export function formatSessionTree(row: SessionRow): SessionTreeDisplay {
  const base = row.baseBranch ?? "main";
  if (row.worktreeName !== null) {
    return { text: `${row.worktreeName} ← ${base}`, dim: false };
  }
  return { text: `— direct on ${base}`, dim: true };
}
