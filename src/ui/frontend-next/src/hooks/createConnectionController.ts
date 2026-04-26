/**
 * Framework-agnostic SSE connection controller.
 *
 * Drives a "connected" boolean signal off an EventSource lifecycle, with
 * an offline-grace window that absorbs the constant `onerror` chatter
 * EventSource emits in practice (proxy idle resets, brief network
 * hiccups, tab throttling). `setConnected(false)` only fires if a full
 * reconnect cycle fails to land an `onopen` within `OFFLINE_GRACE_MS`.
 *
 * This module is pure: every side-effect channel (timer scheduling, DOM
 * `EventSource` construction, the connected setter) is injected through
 * `ConnectionDeps`, which lets the same controller drive Solid signals,
 * Preact `useState`, vanilla DOM, or a fake-timer test harness without
 * touching framework code.
 */

/** Grace window before a dropped SSE link is surfaced as offline. */
export const OFFLINE_GRACE_MS = 5000;

/** Backoff before re-opening the EventSource after an error. */
export const RECONNECT_BACKOFF_MS = 3000;

type SetConnected = (connected: boolean) => void;
type CreateEventSource = (url: string) => EventSource;
type SetTimeoutFn = (callback: () => void, ms: number) => number;
type ClearTimeoutFn = (handle: number) => void;

/**
 * Hook for named SSE events (e.g. `sessions`, `audit:logs`). The
 * controller defines the type and accepts it through `ConnectionDeps`,
 * but does not invoke `onEvent` itself; named-event dispatch is layered
 * on top of this controller by callers that need it. Declaring the slot
 * here keeps the DI surface stable for callers that wire such dispatch.
 */
type OnEvent = (name: string, data: unknown) => void;

export interface ConnectionDeps {
  setConnected: SetConnected;
  createEventSource: CreateEventSource;
  setTimeout: SetTimeoutFn;
  clearTimeout: ClearTimeoutFn;
  /**
   * Optional named-event sink. This controller does not invoke onEvent.
   * It is accepted as a structural extension point so callers can wire
   * named-event dispatch without changing the controller's signature.
   */
  onEvent?: OnEvent;
}

export interface ConnectionController {
  start(url: string): void;
  dispose(): void;
}

/**
 * Build a connection controller bound to the given dependency set.
 *
 * `start(url)` opens an EventSource and arms the open/error handlers.
 * On `onerror` the controller closes the socket, schedules a single
 * (non-renewing) offline-flip timer if one is not already pending, and
 * schedules a reconnect attempt against the same `url`. A subsequent
 * `onopen` cancels the pending offline-flip and flips connected to
 * `true` immediately.
 *
 * `dispose()` clears all pending timers, closes the live socket, and
 * silences any in-flight callbacks via the internal `disposed` flag.
 */
export function createConnectionController(
  deps: ConnectionDeps,
): ConnectionController {
  let es: EventSource | null = null;
  let reconnectTimer: number | undefined;
  let offlineTimer: number | undefined;
  let disposed = false;
  let currentUrl: string | null = null;

  function cancelOfflineFlip(): void {
    if (offlineTimer !== undefined) {
      deps.clearTimeout(offlineTimer);
      offlineTimer = undefined;
    }
  }

  function scheduleOfflineFlip(): void {
    // Repeated `onerror` events MUST NOT renew the grace timer. If they
    // did, a flapping connection would defer the offline flip forever
    // and the UI would never tell the user the daemon is down.
    if (offlineTimer !== undefined) return;
    offlineTimer = deps.setTimeout(() => {
      offlineTimer = undefined;
      if (disposed) return;
      deps.setConnected(false);
    }, OFFLINE_GRACE_MS);
  }

  function scheduleReconnect(): void {
    reconnectTimer = deps.setTimeout(() => {
      reconnectTimer = undefined;
      if (disposed) return;
      if (currentUrl === null) return;
      start(currentUrl);
    }, RECONNECT_BACKOFF_MS);
  }

  function start(url: string): void {
    if (disposed) return;
    currentUrl = url;

    let nextEs: EventSource;
    try {
      nextEs = deps.createEventSource(url);
    } catch (e) {
      // Surface the failure rather than swallowing it, then enter the
      // same recovery path as a runtime `onerror`: schedule the offline
      // flip (subject to grace) and a reconnect attempt.
      console.error("[useConnection] failed to open EventSource", e);
      scheduleOfflineFlip();
      scheduleReconnect();
      return;
    }

    es = nextEs;

    nextEs.onopen = () => {
      if (disposed) return;
      cancelOfflineFlip();
      deps.setConnected(true);
    };

    nextEs.onerror = () => {
      nextEs.close();
      if (disposed) return;
      scheduleOfflineFlip();
      scheduleReconnect();
    };
  }

  function dispose(): void {
    disposed = true;
    if (reconnectTimer !== undefined) {
      deps.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (offlineTimer !== undefined) {
      deps.clearTimeout(offlineTimer);
      offlineTimer = undefined;
    }
    es?.close();
    es = null;
  }

  return { start, dispose };
}
