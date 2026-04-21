/**
 * SSE エンドポイント — 2秒間隔ポーリングで差分送出
 */

import type { UiDataContext } from "../data.ts";
import {
  getAuditLogs,
  getHostExecPending,
  getNasContainers,
  getNetworkPending,
  getSessions,
  getTerminalSessions,
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
        let prevTerminalSessionsJson = "";
        let prevContainersJson = "";
        let prevAuditJson = "";

        async function poll(): Promise<void> {
          if (closed) return;

          try {
            const [
              networkPending,
              hostExecPending,
              sessions,
              terminalSessions,
              containers,
            ] = await Promise.all([
              getNetworkPending(ctx).catch(() => []),
              getHostExecPending(ctx).catch(() => []),
              getSessions(ctx).catch(() => ({ network: [], hostexec: [] })),
              getTerminalSessions(ctx).catch(() => []),
              getNasContainers(ctx).catch(() => []),
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

            const terminalSessionsJson = JSON.stringify(terminalSessions);
            if (terminalSessionsJson !== prevTerminalSessionsJson) {
              prevTerminalSessionsJson = terminalSessionsJson;
              send("terminal:sessions", { items: terminalSessions });
            }

            const containersJson = JSON.stringify(containers);
            if (containersJson !== prevContainersJson) {
              prevContainersJson = containersJson;
              send("containers", { items: containers });
            }

            // Audit logs — send delta since last poll
            try {
              const auditLogs = await getAuditLogs(ctx);
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
