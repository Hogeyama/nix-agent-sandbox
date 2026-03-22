/**
 * SSE エンドポイント — 2秒間隔ポーリングで差分送出
 */

import { Hono } from "hono";
import type { UiDataContext } from "../data.ts";
import { getHostExecPending, getNetworkPending, getSessions } from "../data.ts";

export function createSseRoutes(ctx: UiDataContext): Hono {
  const app = new Hono();

  app.get("/events", (_c) => {
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

        async function poll(): Promise<void> {
          if (closed) return;

          try {
            const [networkPending, hostExecPending, sessions] = await Promise
              .all([
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
        "Connection": "keep-alive",
      },
    });
  });

  return app;
}
