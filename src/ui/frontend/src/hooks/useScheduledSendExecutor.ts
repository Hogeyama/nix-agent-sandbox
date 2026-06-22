/**
 * Scheduled-send executor hook.
 *
 * Periodically scans the `ScheduledSendStore` and sends any due
 * messages to the terminal that was active when the message was
 * scheduled, looked up via `getHandle(sessionId)`. A trailing newline
 * is appended automatically so the message is submitted as if the user
 * pressed Enter. If the target session's handle is unavailable, the
 * entry is skipped (kept in the store) and retried on the next tick.
 *
 * Testability: both `now` (clock) and `intervalMs` (poll cadence) are
 * injectable so tests can drive time deterministically without fake
 * timers.
 */

import type { ScheduledSendStore } from "../stores/scheduledSendStore";
import type { TerminalHandle } from "../terminal/attachTerminalSession";
import { isScheduledSendDue } from "../terminal/scheduledSendLogic";

export interface ScheduledSendExecutorDeps {
  store: ScheduledSendStore;
  getHandle: (sessionId: string) => TerminalHandle | null;
  /** Poll interval in milliseconds. Defaults to 1000. */
  intervalMs?: number;
  /** Injectable clock for deterministic testing. */
  now?: () => Date;
}

/**
 * Start the scheduled-send executor. Returns a `dispose` function that
 * clears the polling interval.
 *
 * This is a plain function (not a Solid `createEffect`) so it works in
 * any context — including test harnesses that lack Solid's reactive
 * runtime.
 */
export function useScheduledSendExecutor(deps: ScheduledSendExecutorDeps): {
  dispose: () => void;
} {
  const { store, getHandle, intervalMs = 1000, now = () => new Date() } = deps;

  const id = setInterval(() => {
    const current = now();
    const due = store
      .entries()
      .filter((entry) => isScheduledSendDue(entry, current));
    for (const entry of due) {
      const handle = getHandle(entry.sessionId);
      if (handle === null) continue;
      handle.sendInput(`${entry.message}\r`);
      store.remove(entry.id);
    }
  }, intervalMs);

  return {
    dispose() {
      clearInterval(id);
    },
  };
}
