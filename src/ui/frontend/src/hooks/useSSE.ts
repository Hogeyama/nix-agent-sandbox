import { useEffect, useRef, useState } from "preact/hooks";

export type SSEHandler = (event: string, data: unknown) => void;

/**
 * How long a dropped connection may stay in the "still maybe-online" state
 * before the UI flips to offline. EventSource fires `onerror` for all sorts
 * of transient conditions (proxy idle timeouts, brief network hiccups, tab
 * throttling) even when the server is perfectly healthy, so we only
 * surface offline if a full reconnect cycle hasn't succeeded within this
 * window.
 */
const OFFLINE_GRACE_MS = 5000;

/** Backoff before re-opening the EventSource after an error. */
const RECONNECT_BACKOFF_MS = 3000;

/**
 * Subscribe to a server-sent-events endpoint.
 *
 * Returns `connected`, which flips to `true` on `onopen` and to `false`
 * only after `OFFLINE_GRACE_MS` has elapsed without a successful reconnect.
 * This smooths over the constant-onerror chatter that EventSource exhibits
 * in practice and keeps the UI indicator steady while reconnection is in
 * progress.
 */
export function useSSE(
  url: string,
  onEvent: SSEHandler,
): { connected: boolean } {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: number | undefined;
    let offlineTimer: number | undefined;
    let disposed = false;

    function scheduleOfflineFlip(): void {
      if (disposed) return;
      if (offlineTimer !== undefined) return; // already pending
      offlineTimer = setTimeout(() => {
        offlineTimer = undefined;
        if (!disposed) setConnected(false);
      }, OFFLINE_GRACE_MS) as unknown as number;
    }

    function cancelOfflineFlip(): void {
      if (offlineTimer !== undefined) {
        clearTimeout(offlineTimer);
        offlineTimer = undefined;
      }
    }

    function connect(): void {
      if (disposed) return;

      es = new EventSource(url);

      es.onopen = () => {
        if (disposed) return;
        cancelOfflineFlip();
        setConnected(true);
      };

      const events = [
        "network:pending",
        "hostexec:pending",
        "sessions",
        "audit:logs",
        "containers",
      ];
      for (const eventName of events) {
        es.addEventListener(eventName, (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            handlerRef.current(eventName, data);
          } catch {
            // ignore parse errors
          }
        });
      }

      es.onerror = () => {
        es?.close();
        if (disposed) return;
        // Don't flip to offline yet — give the reconnect below a chance
        // to succeed within the grace window. If it doesn't, the
        // scheduled flip fires and the UI goes red.
        scheduleOfflineFlip();
        reconnectTimer = setTimeout(
          connect,
          RECONNECT_BACKOFF_MS,
        ) as unknown as number;
      };
    }

    connect();

    return () => {
      disposed = true;
      es?.close();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (offlineTimer !== undefined) clearTimeout(offlineTimer);
    };
  }, [url]);

  return { connected };
}
