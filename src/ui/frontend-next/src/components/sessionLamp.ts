/**
 * Pure aggregation of per-session lamp states for the favicon badge.
 *
 * The favicon shows a single dot whose colour reflects the most urgent
 * lamp across all visible sessions. The lamp ladder is ordered so that
 * an outstanding pending approval always wins over a session that is
 * merely waiting on the user, which in turn wins over an idle agent:
 *
 *   pending > user-turn > none
 *
 * Splitting the per-session lamp (`lampOf`) from the fold (`maxLamp`)
 * keeps both functions trivially testable without a Solid runtime, and
 * lets the hook layer (`useFaviconBadge`) consume a single `Lamp` value
 * via a memoized accessor.
 */

import type { PendingCount } from "./sessionPendingSummary";

export type Lamp = "pending" | "user-turn" | "none";

/**
 * Lamp for a single session. The session shape is intentionally a
 * structural subset (`{ sessionId, turn }`) so test fixtures and the
 * production `SessionRow` (`{id, turn, ...}`) can both feed in via a
 * tiny adaptor at the call site without leaking the full row shape.
 *
 * `pendingFor` mirrors the accessor created in `App.tsx` from
 * `summarizePendingBySession`; it must return a zero record (rather
 * than `undefined`) for sessions with no pending entries so the
 * `network + hostexec > 0` guard does not need to special-case it.
 */
export function lampOf(
  session: { sessionId: string; turn: string | null | undefined },
  pendingFor: (sessionId: string) => PendingCount,
): Lamp {
  const counts = pendingFor(session.sessionId);
  if (counts.network + counts.hostexec > 0) return "pending";
  if (session.turn === "user-turn") return "user-turn";
  return "none";
}

/**
 * Maximum lamp across `sessions`. Returns `"pending"` as soon as the
 * first pending session is seen so the common case (most sessions
 * idle, one with a pending approval) does not pay for a second pass.
 */
export function maxLamp(
  sessions: readonly { sessionId: string; turn: string | null | undefined }[],
  pendingFor: (sessionId: string) => PendingCount,
): Lamp {
  let best: Lamp = "none";
  for (const s of sessions) {
    const lamp = lampOf(s, pendingFor);
    if (lamp === "pending") return "pending";
    if (lamp === "user-turn") best = "user-turn";
  }
  return best;
}
