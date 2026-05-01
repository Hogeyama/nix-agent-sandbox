/**
 * Snapshot diffing for history SSE poll loops.
 *
 * The three history endpoints (`/api/history/conversations/events`,
 * `/api/history/conversation/:id/events`, `/api/history/invocation/:id/events`)
 * each maintain per-connection state in their `start(controller)` closure.
 * On every poll they call this helper with the previous JSON payload and
 * the freshly-read snapshot; the helper returns whether a wire event should
 * be emitted along with the new JSON to thread into the next poll.
 *
 * Equality is `JSON.stringify` based: the underlying queries return
 * deterministic row orderings (matching the `history_data.ts` reader
 * contract) so a strict string compare is sufficient. Pure (input →
 * output) — no IO, no timers, no module-level mutable state.
 */

/**
 * Compare a previously-emitted JSON payload against a fresh snapshot value.
 *
 * - `prevJson === null` (initial connect) is treated as "always changed",
 *   so the first poll of a connection always emits one event.
 * - When unchanged, the caller keeps using the same `prevJson` — the next
 *   poll feeds it back in, and the cycle continues without enqueuing.
 */
export function diffHistorySnapshot<T>(
  prevJson: string | null,
  next: T,
): { changed: true; nextJson: string } | { changed: false } {
  const nextJson = JSON.stringify(next);
  if (prevJson === nextJson) {
    return { changed: false };
  }
  return { changed: true, nextJson };
}
