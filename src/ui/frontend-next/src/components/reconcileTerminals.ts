/**
 * Pure reducer for the keep-alive terminal pane.
 *
 * The center pane needs to keep multiple xterm handles + DOM nodes alive
 * across session switches: re-attaching a fresh WebSocket every time the
 * user toggles between sessions throws away scrollback, the dtach state
 * machine, and any in-flight bytes. To express the lifecycle without
 * coupling it to a Solid effect, this module reduces four inputs:
 *
 *   - `prevActiveId` — the id the pane previously displayed.
 *   - `nextActiveId` — the id the pane should now display.
 *   - `liveSessionIds` — sessionIds present in the latest
 *     `terminal:sessions` SSE snapshot. A handle for an id missing from
 *     this set must be torn down because the underlying socket is gone.
 *   - `mountedSessionIds` — sessionIds the pane currently has a mounted
 *     handle for.
 *
 * …into a list of discrete actions (`mount` / `show` / `hide` /
 * `dispose`) which the caller dispatches via `applyTerminalActions`.
 *
 * Invariants enforced by this reducer:
 *   - For any one sessionId, the result emits at most one of
 *     {`hide`, `dispose`} and at most one of {`mount`, `show`}.
 *   - `dispose` and `hide` never co-occur for the same sessionId in one
 *     reconciliation: a session that vanished from `liveSessionIds` is
 *     disposed, not hidden.
 *   - The function is idempotent in input — calling it twice with the
 *     same arguments yields equal output, with no side effects.
 *
 * No Solid signal, DOM API, or environmental clock is touched here.
 */

export type TerminalAction =
  | { type: "mount"; sessionId: string }
  | { type: "show"; sessionId: string }
  | { type: "hide"; sessionId: string }
  | { type: "dispose"; sessionId: string };

/**
 * Compute the actions needed to move from `prevActiveId`/`mountedSessionIds`
 * to `nextActiveId` while respecting `liveSessionIds`.
 *
 * Action ordering:
 *   1. Tear down (`hide` previous active or `dispose` removed sessions),
 *      so subsequent show/mount operate on a quiet pane.
 *   2. Mount a fresh handle for the new active id when it is live but
 *      not yet mounted.
 *   3. Show the new active id.
 *
 * Sessions that vanished from `liveSessionIds` but are not active are
 * disposed too — leaving a stale handle around would leak the WebSocket.
 */
export function reconcileTerminals(
  prevActiveId: string | null,
  nextActiveId: string | null,
  liveSessionIds: ReadonlySet<string>,
  mountedSessionIds: ReadonlySet<string>,
): TerminalAction[] {
  const actions: TerminalAction[] = [];

  // 1. Dispose every mounted id that no longer appears in the latest
  //    snapshot, regardless of whether it is the active id. The handle
  //    cannot stay mounted because its underlying socket is gone.
  const disposed = new Set<string>();
  for (const id of mountedSessionIds) {
    if (!liveSessionIds.has(id)) {
      actions.push({ type: "dispose", sessionId: id });
      disposed.add(id);
    }
  }

  // 2. If the previously-active id is still live and still mounted, hide
  //    it whenever the active selection moves to a different id (or to
  //    null). When it has been disposed in step 1, the hide is redundant
  //    and skipped — disposed nodes have no DOM to flip.
  if (
    prevActiveId !== null &&
    prevActiveId !== nextActiveId &&
    !disposed.has(prevActiveId) &&
    mountedSessionIds.has(prevActiveId)
  ) {
    actions.push({ type: "hide", sessionId: prevActiveId });
  }

  // 3. Bring the new active id on screen. If it is not yet mounted (and
  //    is live), mount it first; then unconditionally show. When the
  //    active id has not changed and the handle is still mounted, no
  //    show is needed — the node is already visible.
  if (nextActiveId !== null && liveSessionIds.has(nextActiveId)) {
    const alreadyMounted = mountedSessionIds.has(nextActiveId);
    if (!alreadyMounted) {
      actions.push({ type: "mount", sessionId: nextActiveId });
      actions.push({ type: "show", sessionId: nextActiveId });
    } else if (prevActiveId !== nextActiveId) {
      actions.push({ type: "show", sessionId: nextActiveId });
    }
  }

  return actions;
}
