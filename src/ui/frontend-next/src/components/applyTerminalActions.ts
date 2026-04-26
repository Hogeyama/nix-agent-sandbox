/**
 * Solid-free dispatcher for the terminal lifecycle actions produced by
 * `reconcileTerminals`.
 *
 * The reducer answers *what* to do; this helper answers *how*. By
 * isolating side effects behind an injected `deps` bag, the dispatch
 * order, the rAF-scheduled refit after `show`, and the dispose protocol
 * are all unit-testable without a Solid runtime, a real DOM, or
 * `window.requestAnimationFrame`.
 *
 * The `show` action is special: when the previous active terminal was
 * hidden via `display: none`, xterm's fit addon reads a 0×0 viewport
 * and returns garbage dimensions. Schedule the refit on the next
 * animation frame so layout has a chance to settle before fit runs.
 */

import type { TerminalAction } from "./reconcileTerminals";

/**
 * Narrow surface of a terminal handle consumed by the dispatcher. Only
 * `refit` is needed during dispatch — `dispose`, `focus`, etc. are
 * driven via the corresponding action callbacks on `ApplyTerminalDeps`.
 */
export interface TerminalHandleLike {
  refit(): void;
}

/**
 * Side-effect channels the dispatcher routes actions through. Each
 * action type maps to one callback; `requestAnimationFrame` and
 * `getHandle` cooperate to schedule the post-show refit.
 */
export interface ApplyTerminalDeps {
  mount(sessionId: string): void;
  dispose(sessionId: string): void;
  show(sessionId: string): void;
  hide(sessionId: string): void;
  requestAnimationFrame(cb: () => void): number;
  getHandle(sessionId: string): TerminalHandleLike | undefined;
}

/**
 * Dispatch `actions` to `deps` in order. Mount/dispose/hide are forwarded
 * synchronously; show is forwarded synchronously and additionally
 * schedules a refit on the next animation frame so the freshly-visible
 * terminal sees a non-zero viewport.
 */
export function applyTerminalActions(
  actions: TerminalAction[],
  deps: ApplyTerminalDeps,
): void {
  for (const action of actions) {
    switch (action.type) {
      case "mount":
        deps.mount(action.sessionId);
        break;
      case "dispose":
        deps.dispose(action.sessionId);
        break;
      case "hide":
        deps.hide(action.sessionId);
        break;
      case "show": {
        const sessionId = action.sessionId;
        deps.show(sessionId);
        deps.requestAnimationFrame(() => {
          deps.getHandle(sessionId)?.refit();
        });
        break;
      }
    }
  }
}
