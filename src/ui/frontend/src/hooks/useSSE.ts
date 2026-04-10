import { useEffect, useRef, useState } from "preact/hooks";

export type SSEHandler = (event: string, data: unknown) => void;

/**
 * Subscribe to a server-sent-events endpoint.
 *
 * Returns `connected = true` only while the underlying EventSource is in the
 * OPEN state. On network error or server shutdown, EventSource fires `onerror`
 * and we flip back to `false` immediately, so callers can render live/offline
 * indicators that reflect reality (not just "we got a message once").
 */
export function useSSE(url: string, onEvent: SSEHandler): { connected: boolean } {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: number | undefined;
    let disposed = false;

    function connect(): void {
      if (disposed) return;

      es = new EventSource(url);

      es.onopen = () => {
        if (!disposed) setConnected(true);
      };

      const events = [
        "network:pending",
        "hostexec:pending",
        "sessions",
        "audit:logs",
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
        if (!disposed) {
          setConnected(false);
          reconnectTimer = setTimeout(connect, 3000) as unknown as number;
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      setConnected(false);
      es?.close();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    };
  }, [url]);

  return { connected };
}
