import { useEffect, useRef } from "preact/hooks";

export type SSEHandler = (event: string, data: unknown) => void;

export function useSSE(url: string, onEvent: SSEHandler): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: number | undefined;
    let disposed = false;

    function connect(): void {
      if (disposed) return;

      es = new EventSource(url);

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
          reconnectTimer = setTimeout(connect, 3000) as unknown as number;
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      es?.close();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    };
  }, [url]);
}
