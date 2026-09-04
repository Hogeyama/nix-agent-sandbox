/**
 * SSE エンドポイント — 2秒間隔ポーリングで差分送出
 */

import type { AuditLogEntry } from "../../audit/types.ts";
import type { UiDataContext } from "../data.ts";
import {
  getAuditLogs,
  getHostExecPending,
  getNasContainers,
  getNetworkPending,
  getPortBindings,
  getSessions,
  getTerminalSessions,
} from "../data.ts";
import { Router } from "../router.ts";
import { diffSnapshots, initialSnapshotState } from "./sse_diff.ts";

/**
 * How many audit entries the live SSE feed carries.
 *
 * This is a live activity view, not the history browser: paging into
 * older entries is what `/api/audit` and the audit page are for.
 *
 * The bound is not cosmetic. Unbounded, this array is re-read, diffed
 * and serialised on every poll — on the same event loop that relays
 * terminal I/O — and pushed to every connected browser to parse. On a
 * long-lived install the audit table reaches hundreds of thousands of
 * rows, which measured as ~390 ms of synchronous work per 2 s round and
 * a ~43 MiB SSE frame, felt as keystrokes freezing in the terminal.
 */
export const LIVE_AUDIT_LIMIT = 200;

export function createSseRoutes(ctx: UiDataContext): Router {
  const app = new Router();

  app.get("/events", () => {
    let closed = false;
    let timerId: number | undefined;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        function send(event: string, data: unknown): void {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          } catch {
            closed = true;
          }
        }

        // Per-connection snapshot state. Lives strictly inside this
        // `start(controller)` closure so that concurrent SSE clients do not
        // share diff state. Do NOT lift to module scope.
        let state = initialSnapshotState();

        async function poll(): Promise<void> {
          if (closed) return;

          try {
            const [
              networkPending,
              hostExecPending,
              sessions,
              terminalSessions,
              containers,
              portBindings,
            ] = await Promise.all([
              getNetworkPending(ctx).catch(() => []),
              getHostExecPending(ctx).catch(() => []),
              getSessions(ctx).catch(() => ({ network: [], hostexec: [] })),
              getTerminalSessions(ctx).catch(() => []),
              getNasContainers(ctx).catch(() => []),
              getPortBindings(ctx).catch(() => []),
            ]);

            // Audit logs — fetched separately so a failure does not affect
            // the other 6 snapshots. `undefined` is a sentinel for
            // `diffSnapshots` to suppress the audit:logs event.
            let auditLogs: AuditLogEntry[] | undefined;
            try {
              auditLogs = await getAuditLogs(ctx, {}, LIVE_AUDIT_LIMIT);
            } catch {
              auditLogs = undefined;
            }

            const { events, nextState } = diffSnapshots(state, {
              network: networkPending,
              hostexec: hostExecPending,
              sessions,
              terminalSessions,
              containers,
              portBindings,
              audit: auditLogs,
            });
            state = nextState;

            for (const ev of events) {
              if (closed) return;
              send(ev.event, ev.data);
            }
          } catch {
            // ignore polling errors
          }

          if (!closed) {
            timerId = setTimeout(poll, 2000) as unknown as number;
          }
        }

        // Initial data push
        poll();
      },
      cancel() {
        closed = true;
        if (timerId !== undefined) clearTimeout(timerId);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return app;
}
