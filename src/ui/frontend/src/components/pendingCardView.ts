/**
 * Pure view-helpers for the pending pane's network and host-exec cards.
 *
 * These functions translate normalized pending rows into the small
 * presentation strings rendered by `PendingPane`. Keeping them as pure
 * functions (no Solid primitives, no DOM access, `now` taken as an
 * argument) lets them be unit-tested in isolation and lets the caller
 * drive re-renders by ticking a clock signal.
 */

/**
 * Format the difference between `targetMs` and `nowMs` as a coarse-grained
 * relative time string (e.g. `"5s ago"`, `"3m ago"`, `"2h ago"`).
 *
 * - `targetMs === null` (ISO parse failure upstream) returns the em dash
 *   placeholder `"—"` so the caller does not need to guard at the call
 *   site.
 * - `nowMs - targetMs` is clamped at zero, so a future `targetMs`
 *   (clock skew, server slightly ahead) renders as `"0s ago"` rather
 *   than a negative count.
 * - The largest unit shown is days; longer ages still render in days.
 */
export function formatRelativeTime(
  targetMs: number | null,
  nowMs: number,
): string {
  if (targetMs === null) return "—";
  const deltaSec = Math.max(0, Math.round((nowMs - targetMs) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  return `${deltaDay}d ago`;
}

/**
 * Pick the human-friendly label for the chip on a pending card.
 *
 * Prefers `sessionName` when present so users see the session they
 * named (e.g. `"feature-auth"`); falls back to the short id derived
 * from the raw session id (e.g. `"s_7a3f12"`) when no name is set.
 */
export function sessionLabel(row: {
  sessionShortId: string;
  sessionName: string | null;
}): string {
  return row.sessionName ?? row.sessionShortId;
}
