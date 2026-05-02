/**
 * History SSE endpoints — three streams backed by per-connection
 * poll-and-diff over the read-only history db handle.
 *
 * - `GET /history/conversations/events` — conversation list snapshot
 * - `GET /history/conversation/:id/events` — single conversation detail
 * - `GET /history/invocation/:id/events` — single invocation detail
 *
 * Each endpoint runs its own poll loop in the `start(controller)` closure
 * and emits one event whenever the JSON-encoded snapshot differs from
 * what was last sent on that specific connection. The default 5-second
 * interval matches the OTEL batch flush cadence (ADR §"UI reader") so a
 * fresh trace has at most one flush worth of latency before surfacing.
 *
 * Per-connection state must stay inside the closure: lifting it to module
 * scope would mix diff state across concurrent SSE clients.
 */

import type { UiDataContext } from "../data.ts";
import { Router } from "../router.ts";
import { diffHistorySnapshot } from "./history_sse_diff.ts";
import type { HistorySseEventName } from "./history_sse_events.ts";
import { isSafeId } from "./validate_ids.ts";

export {
  HISTORY_SSE_EVENT_NAMES,
  type HistorySseEventName,
} from "./history_sse_events.ts";

export interface HistorySseRouteOptions {
  /**
   * Polling interval in ms. Default 5000 — matches the OTEL batch flush
   * window so an in-flight invocation surfaces within one cycle. Tests
   * override this to keep wall time low.
   */
  readonly pollIntervalMs?: number;
}

export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Window for the per-model token totals payload accompanying the list event.
 * 30 days matches the dashboard "last 30 days" label rendered by the frontend.
 * See the list-route handler for why the resulting `since` is computed once
 * per SSE connection on the daemon clock rather than every poll.
 */
const MODEL_TOKEN_TOTALS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function formatSseEvent(event: HistorySseEventName, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

/**
 * Pre-encoded SSE comment line. Sent on every poll tick to keep bytes
 * flowing on otherwise-silent streams; without it `Bun.serve`'s default
 * 10s idle timeout kills the socket between data changes (poll cadence
 * is 5s but most polls produce no diff), and the browser reports a
 * spurious "connection lost" while it auto-reconnects.
 *
 * SSE comments are lines that start with `:` per the HTML spec. The
 * EventSource API silently discards them, so this never triggers a
 * frontend handler.
 */
const SSE_KEEPALIVE_BYTES = new TextEncoder().encode(`: keepalive\n\n`);

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

/**
 * Build a `ReadableStream` that drives a per-connection poll loop. The
 * `read()` callback is invoked every `pollIntervalMs` and the first time
 * synchronously after open. Each invocation produces an `{event, payload}`
 * tuple, which is diffed against the last JSON we sent on this connection.
 */
function createPollingStream(args: {
  pollIntervalMs: number;
  read: () => { event: HistorySseEventName; payload: unknown };
}): ReadableStream {
  const { pollIntervalMs, read } = args;
  let closed = false;
  let timerId: ReturnType<typeof setTimeout> | undefined;

  return new ReadableStream({
    start(controller) {
      // Per-connection diff state — scoped strictly to this closure so
      // concurrent SSE clients keep independent histories.
      let prevJson: string | null = null;
      let prevEvent: HistorySseEventName | null = null;

      function send(event: HistorySseEventName, data: unknown): void {
        if (closed) return;
        try {
          controller.enqueue(formatSseEvent(event, data));
        } catch {
          closed = true;
        }
      }

      function sendKeepalive(): void {
        if (closed) return;
        try {
          controller.enqueue(SSE_KEEPALIVE_BYTES);
        } catch {
          closed = true;
        }
      }

      function poll(): void {
        if (closed) return;
        // Always tick the wire first. Bun.serve's idle timeout would
        // otherwise drop the socket after 10s of silence on streams that
        // mostly produce no diff between polls.
        sendKeepalive();
        try {
          const { event, payload } = read();
          // Treat an event-name change as a change too, so a transition
          // between e.g. `history:not-found` and `history:conversation`
          // always emits even if the JSON payload incidentally matches.
          const eventChanged = prevEvent !== event;
          const diff = diffHistorySnapshot(prevJson, payload);
          if (diff.changed) {
            send(event, payload);
            prevJson = diff.nextJson;
            prevEvent = event;
          } else if (eventChanged) {
            send(event, payload);
            // Also refresh prevJson so the next diff compares against the
            // payload we just sent on the new event, not the JSON tied to
            // the previous (different) event name.
            prevJson = JSON.stringify(payload);
            prevEvent = event;
          }
        } catch {
          // Reader failures are non-fatal — keep the connection open and
          // try again on the next tick. The reader functions in
          // history_data.ts already swallow db errors and degrade to
          // empty/null, so reaching this catch would be unexpected.
        }
        if (!closed) {
          timerId = setTimeout(poll, pollIntervalMs);
        }
      }

      poll();
    },
    cancel() {
      closed = true;
      if (timerId !== undefined) clearTimeout(timerId);
    },
  });
}

export function createHistorySseRoutes(
  ctx: UiDataContext,
  opts?: HistorySseRouteOptions,
): Router {
  const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const app = new Router();

  app.get("/history/conversations/events", () => {
    // `since` is computed ONCE per connection rather than per poll. The
    // diff hashing layer (history_sse_diff) compares the JSON of the whole
    // payload, so a `since` value that advanced every 5 s tick would force
    // an emit on every poll even when neither the conversation list nor
    // the per-model totals had changed — defeating the silence-when-quiet
    // contract that lets idle clients hold a stream open cheaply. Holding
    // `since` constant for the life of a connection keeps the diff stable;
    // the frontend reconnects often enough (route navigation, page reload)
    // that the window naturally tracks "the last 30 days".
    //
    // The clock source is intentionally the daemon — keeping `since` in
    // the payload means the badge label and the SUM aggregate it
    // describes are always derived from the same instant.
    const sinceIso = new Date(
      Date.now() - MODEL_TOKEN_TOTALS_WINDOW_MS,
    ).toISOString();
    const stream = createPollingStream({
      pollIntervalMs,
      read: () => ({
        event: "history:list",
        payload: {
          conversations: ctx.history.readConversationList(),
          modelTokenTotals: ctx.history.readModelTokenTotals(sinceIso),
          since: sinceIso,
        },
      }),
    });
    return sseResponse(stream);
  });

  app.get("/history/conversation/:id/events", ({ params }) => {
    const id = params.id;
    if (!isSafeId(id)) {
      return new Response("invalid id", { status: 400 });
    }
    const stream = createPollingStream({
      pollIntervalMs,
      read: () => {
        const detail = ctx.history.readConversationDetail(id);
        if (detail === null) {
          return { event: "history:not-found", payload: { id } };
        }
        return { event: "history:conversation", payload: detail };
      },
    });
    return sseResponse(stream);
  });

  app.get("/history/invocation/:id/events", ({ params }) => {
    const id = params.id;
    if (!isSafeId(id)) {
      return new Response("invalid id", { status: 400 });
    }
    const stream = createPollingStream({
      pollIntervalMs,
      read: () => {
        const detail = ctx.history.readInvocationDetail(id);
        if (detail === null) {
          return { event: "history:not-found", payload: { id } };
        }
        return { event: "history:invocation", payload: detail };
      },
    });
    return sseResponse(stream);
  });

  return app;
}
