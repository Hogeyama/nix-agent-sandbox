/**
 * Pure transition helper for `TerminalPane`.
 *
 * Solid `createEffect` re-runs whenever `terminals.activeId()` changes,
 * but the side-effect we need to perform — mount, dispose, or swap an
 * xterm session — depends on *both* the previous and the next id. This
 * helper takes both ids and reduces them to one of four discrete
 * actions, so the effect body becomes a single `switch` rather than a
 * nest of `if`s, and so the branching logic itself is testable without
 * a Solid runtime.
 *
 * Cases:
 *   - both null         → `noop`     (nothing was attached, nothing to attach)
 *   - same id           → `noop`     (the effect re-fired but the selection did not change)
 *   - null → id         → `mount`    (first attach)
 *   - id → null         → `unmount`  (selection cleared)
 *   - id → other id     → `remount`  (swap to a different session)
 */
export type TerminalPaneAction = "noop" | "mount" | "remount" | "unmount";

export function pickTerminalAction(
  prevId: string | null,
  nextId: string | null,
): TerminalPaneAction {
  if (prevId === nextId) return "noop";
  if (prevId === null) return "mount";
  if (nextId === null) return "unmount";
  return "remount";
}
