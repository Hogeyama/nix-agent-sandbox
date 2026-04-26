/**
 * Pure view-helpers for the sessions pane row.
 *
 * These functions translate a normalized `SessionRow` into the small
 * presentation values that the SessionsPane component renders. Keeping
 * them as pure functions (no Solid primitives, no DOM access) lets them
 * be unit-tested in isolation and reused if the markup is restructured.
 */

import type { SessionRow } from "../stores/types";

export type SessionRowDisplay = {
  /** Class string for the leading status dot. */
  dotClass: string;
  /** Trailing status badge, or `null` when no badge should render. */
  badge: { text: string; class: string } | null;
};

/**
 * Maps a session's `turn` value to the dot/badge presentation tuple.
 *
 * Unknown / unrecognized turn values fall through to the default state
 * (idle dot, no badge) rather than throwing, so the UI stays robust to
 * future server-side turn values.
 */
export function describeSessionRow(row: SessionRow): SessionRowDisplay {
  switch (row.turn) {
    case "user-turn":
      return {
        dotClass: "session-dot turn",
        badge: { text: "Turn", class: "badge badge-turn" },
      };
    case "agent-turn":
      return {
        dotClass: "session-dot busy",
        badge: { text: "Busy", class: "badge badge-busy" },
      };
    default:
      return { dotClass: "session-dot", badge: null };
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
