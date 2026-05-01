/**
 * Solid hook that subscribes to one of the history SSE streams.
 *
 * Each history page (`#/history`, `#/history/conversation/:id`,
 * `#/history/invocation/:id`) opens its own EventSource and listens
 * for one positive-payload event name plus an optional `not-found`
 * event. The hook is intentionally per-page (no module-scope state)
 * so two pages mounted side-by-side keep independent diffs and
 * neither leaks past `onCleanup`.
 *
 * Lifecycle:
 *   - Open the EventSource immediately on call. Solid's reactive root
 *     owns the cleanup; `onCleanup` closes the socket.
 *   - JSON parse failures on a payload event are reported via
 *     `console.warn` and skipped — the next event still updates the
 *     signal.
 *   - The EventSource's built-in reconnect handles transient drops.
 *     We surface a connection error message via the `error` accessor
 *     so the page can render a banner; a successful reopen clears it
 *     by way of the next payload event arriving and the listener
 *     firing again.
 */

import { type Accessor, createSignal, onCleanup } from "solid-js";

export interface HistoryStreamState<T> {
  /** Latest parsed payload. `null` until the first event arrives. */
  data: Accessor<T | null>;
  /** True after a `notFoundEventName` event has been received. */
  notFound: Accessor<boolean>;
  /** Connection error message, or `null` while the socket looks healthy. */
  error: Accessor<string | null>;
}

export interface UseHistoryStreamOptions {
  /** Endpoint to open the EventSource against. */
  url: string;
  /** Event name that carries a positive JSON payload. */
  payloadEventName: string;
  /** Optional event name that flips `notFound` to true. */
  notFoundEventName?: string;
  /**
   * Injected EventSource constructor. Defaults to the global one in
   * production; tests pass a fake to drive the lifecycle without a
   * real network.
   */
  createEventSource?: (url: string) => EventSource;
}

/**
 * Open an EventSource against `url`, publish parsed payloads via Solid
 * signals, and close the socket on cleanup. The caller decides which
 * event names to listen for via `payloadEventName` / `notFoundEventName`
 * — strings are passed through verbatim so the backend's wire vocabulary
 * stays the single source of truth.
 */
export function useHistoryStream<T>(
  opts: UseHistoryStreamOptions,
): HistoryStreamState<T> {
  const [data, setData] = createSignal<T | null>(null);
  const [notFound, setNotFound] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const factory =
    opts.createEventSource ?? ((url: string) => new EventSource(url));

  let es: EventSource | null = null;
  try {
    es = factory(opts.url);
  } catch (e) {
    // Surface the open failure rather than swallowing it. The page can
    // render a banner; there is no retry path here because the browser
    // EventSource constructor only throws on programmer error (bad URL),
    // not on transport failure.
    console.error("[useHistoryStream] failed to open EventSource", e);
    setError(e instanceof Error ? e.message : String(e));
    return { data, notFound, error };
  }

  const handlePayload = (e: Event) => {
    const msg = e as MessageEvent<string>;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.data);
    } catch (parseErr) {
      console.warn(
        `[useHistoryStream] failed to parse '${opts.payloadEventName}' payload:`,
        parseErr,
      );
      return;
    }
    // A payload arrival means the underlying entity is present; clear
    // any previous not-found flag so the page transitions back to the
    // populated view if the row reappears.
    setNotFound(false);
    setError(null);
    setData(() => parsed as T);
  };

  const handleNotFound = () => {
    setNotFound(true);
    setError(null);
  };

  es.addEventListener(opts.payloadEventName, handlePayload);
  if (opts.notFoundEventName !== undefined) {
    es.addEventListener(opts.notFoundEventName, handleNotFound);
  }

  // EventSource fires `onerror` on transient transport blips and on
  // permanent failures alike, then reconnects on its own. We surface
  // a generic message so the page can render a banner; the next
  // successful payload arrival clears it.
  es.onerror = () => {
    setError("connection lost");
  };

  onCleanup(() => {
    es?.close();
    es = null;
  });

  return { data, notFound, error };
}
