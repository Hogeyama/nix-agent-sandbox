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
 * vanilla DOM, or a fake-timer test harness without touching framework
 * code.
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
 * Sink for named SSE events (e.g. `containers`, `network:pending`).
 * Each event payload arrives as the JSON-parsed `data` field; parse
 * failures are surfaced via `console.warn` and the sink is not invoked
 * for that event.
 */
type OnEvent = (name: string, data: unknown) => void;

export interface ConnectionDeps {
  setConnected: SetConnected;
  createEventSource: CreateEventSource;
  setTimeout: SetTimeoutFn;
  clearTimeout: ClearTimeoutFn;
  /**
   * Optional named-event sink. When omitted, the controller does not
   * register any `addEventListener` handlers, keeping side-effects
   * minimal for callers that only need the connected/offline signal.
   */
  onEvent?: OnEvent;
  /**
   * Names of SSE events to subscribe to. The controller is intentionally
   * agnostic about which events the application defines: when this is
   * omitted (or empty), no `addEventListener` calls are made even if
   * `onEvent` is provided. Callers own their event vocabulary and pass
   * it in explicitly.
   */
  eventNames?: readonly string[];
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

    // Named-event subscriptions. Listeners are owned by `nextEs`; when
    // `dispose()` (or the onerror branch) calls `es.close()`, the
    // EventSource stops delivering events to its listeners, so no
    // manual `removeEventListener` is required here.
    if (deps.onEvent) {
      const names = deps.eventNames ?? [];
      const sink = deps.onEvent;
      for (const name of names) {
        nextEs.addEventListener(name, (e: Event) => {
          if (disposed) return;
          const msgEvent = e as MessageEvent<string>;
          let data: unknown;
          try {
            data = JSON.parse(msgEvent.data);
          } catch (parseErr) {
            console.warn(
              `[useConnection] failed to parse event '${name}':`,
              parseErr,
            );
            return;
          }
          sink(name, data);
        });
      }
    }
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
