/**
 * SSE エンドポイント — 2秒間隔ポーリングで差分送出
 *
 * 監査ログは容易に数万件まで膨らむので、ライブストリームは直近
 * `AUDIT_STREAM_LIMIT` 件だけに制限する。それ以上掘りたいときは
 * フィルタ付きで REST (/api/audit) を叩く想定。
 */

const AUDIT_STREAM_LIMIT = 500;

import type { UiDataContext } from "../data.ts";
import {
  getAuditLogs,
  getHostExecPending,
  getNetworkPending,
  getSessions,
} from "../data.ts";
import { Router } from "../router.ts";

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

        let prevNetworkJson = "";
        let prevHostExecJson = "";
        let prevSessionsJson = "";
        let prevAuditJson = "";

        async function poll(): Promise<void> {
          if (closed) return;

          try {
            const [networkPending, hostExecPending, sessions] =
              await Promise.all([
                getNetworkPending(ctx).catch(() => []),
                getHostExecPending(ctx).catch(() => []),
                getSessions(ctx).catch(() => ({ network: [], hostexec: [] })),
              ]);

            const networkJson = JSON.stringify(networkPending);
            if (networkJson !== prevNetworkJson) {
              prevNetworkJson = networkJson;
              send("network:pending", { items: networkPending });
            }

            const hostExecJson = JSON.stringify(hostExecPending);
            if (hostExecJson !== prevHostExecJson) {
              prevHostExecJson = hostExecJson;
              send("hostexec:pending", { items: hostExecPending });
            }

            const sessionsJson = JSON.stringify(sessions);
            if (sessionsJson !== prevSessionsJson) {
              prevSessionsJson = sessionsJson;
              send("sessions", sessions);
            }

            // Audit logs — stream only the tail to keep the payload bounded.
            // Older history is fetched on demand by the frontend via
            // GET /api/audit?before=<cursor>.
            try {
              const auditLogs = await getAuditLogs(ctx, {}, AUDIT_STREAM_LIMIT);
              const auditJson = JSON.stringify(auditLogs);
              if (auditJson !== prevAuditJson) {
                prevAuditJson = auditJson;
                send("audit:logs", { items: auditLogs });
              }
            } catch {
              // ignore audit log read errors
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
