/**
 * REST API ルート
 */

import type { AuditDomain, AuditLogFilter } from "../../audit/types.ts";
import type { UiDataContext } from "../data.ts";
import {
  acknowledgeSessionTurn,
  approveHostExec,
  approveNetwork,
  cleanContainers,
  denyHostExec,
  denyNetwork,
  getAuditLogs,
  getHostExecPending,
  getNasContainers,
  getNetworkPending,
  getSessions,
  getTerminalSessions,
  renameSession,
  stopContainer,
} from "../data.ts";
import {
  getLaunchInfo,
  type LaunchRequest,
  LaunchValidationError,
  launchSession,
} from "../launch.ts";
import { json, Router } from "../router.ts";

export function createApiRoutes(ctx: UiDataContext): Router {
  const api = new Router();

  // --- Health ---

  api.get("/health", () => {
    return json({ ok: true });
  });

  // --- Launch ---

  api.get("/launch/info", async () => {
    try {
      const info = await getLaunchInfo(ctx);
      return json(info);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/launch", async ({ req }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    try {
      const result = await launchSession(body as LaunchRequest);
      return json(result);
    } catch (e) {
      if (e instanceof LaunchValidationError) {
        return json({ error: e.message }, 400);
      }
      return json({ error: (e as Error).message }, 500);
    }
  });

  // --- Network ---

  api.get("/network/pending", async () => {
    try {
      const items = await getNetworkPending(ctx);
      return json({ items });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/network/approve", async ({ req }) => {
    try {
      const body = await req.json();
      const { sessionId, requestId, scope } = body;
      if (!sessionId || !requestId) {
        return json({ error: "sessionId and requestId are required" }, 400);
      }
      await approveNetwork(ctx, sessionId, requestId, scope);
      return json({ ok: true });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/network/deny", async ({ req }) => {
    try {
      const body = await req.json();
      const { sessionId, requestId, scope } = body;
      if (!sessionId || !requestId) {
        return json({ error: "sessionId and requestId are required" }, 400);
      }
      await denyNetwork(ctx, sessionId, requestId, scope);
      return json({ ok: true });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  // --- HostExec ---

  api.get("/hostexec/pending", async () => {
    try {
      const items = await getHostExecPending(ctx);
      return json({ items });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/hostexec/approve", async ({ req }) => {
    try {
      const body = await req.json();
      const { sessionId, requestId, scope } = body;
      if (!sessionId || !requestId) {
        return json({ error: "sessionId and requestId are required" }, 400);
      }
      await approveHostExec(ctx, sessionId, requestId, scope);
      return json({ ok: true });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/hostexec/deny", async ({ req }) => {
    try {
      const body = await req.json();
      const { sessionId, requestId } = body;
      if (!sessionId || !requestId) {
        return json({ error: "sessionId and requestId are required" }, 400);
      }
      await denyHostExec(ctx, sessionId, requestId);
      return json({ ok: true });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  // --- Sessions ---

  api.get("/sessions", async () => {
    try {
      const sessions = await getSessions(ctx);
      return json(sessions);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  api.patch("/sessions/:sessionId/name", async ({ params, req }) => {
    try {
      const body = await req.json();
      const { name } = body;
      if (typeof name !== "string" || name.length === 0) {
        return json({ error: "name is required" }, 400);
      }
      const item = await renameSession(ctx, params.sessionId, name);
      return json({ item });
    } catch (e) {
      const message = (e as Error).message;
      if (message.startsWith("Session not found:")) {
        return json({ error: message }, 404);
      }
      return json({ error: message }, 500);
    }
  });

  api.post("/sessions/:sessionId/ack", async ({ params }) => {
    try {
      const item = await acknowledgeSessionTurn(ctx, params.sessionId);
      return json({ item });
    } catch (e) {
      const message = (e as Error).message;
      if (message.startsWith("Session not found:")) {
        return json({ error: message }, 404);
      }
      if (message.startsWith("Cannot acknowledge turn in state:")) {
        return json({ error: message }, 409);
      }
      return json({ error: message }, 500);
    }
  });

  // --- Containers ---

  api.get("/containers", async () => {
    try {
      const containers = await getNasContainers(ctx);
      return json({ items: containers });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/containers/:name/stop", async ({ params }) => {
    try {
      await stopContainer(params.name);
      return json({ ok: true });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/containers/clean", async () => {
    try {
      const result = await cleanContainers();
      return json(result);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  // --- Terminal (dtach sessions) ---

  api.get("/terminal/sessions", async () => {
    try {
      const items = await getTerminalSessions();
      return json({ items });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  // --- Audit ---

  api.get("/audit", async ({ url }) => {
    try {
      const since = url.searchParams.get("since");
      const before = url.searchParams.get("before");
      const sessionsParam = url.searchParams.get("sessions");
      const sessionContains = url.searchParams.get("sessionContains");
      const domain = url.searchParams.get("domain");
      const limitStr = url.searchParams.get("limit");

      // Validate domain parameter
      if (domain && domain !== "network" && domain !== "hostexec") {
        return json(
          { error: 'Invalid domain: must be "network" or "hostexec"' },
          400,
        );
      }

      // Validate `before` is a parseable ISO timestamp
      if (before && Number.isNaN(Date.parse(before))) {
        return json(
          { error: "Invalid before: must be an ISO-8601 timestamp" },
          400,
        );
      }

      // Validate limit parameter
      let limit: number | undefined;
      if (limitStr) {
        limit = parseInt(limitStr, 10);
        if (Number.isNaN(limit) || limit < 1) {
          return json(
            { error: "Invalid limit: must be a positive integer" },
            400,
          );
        }
      }

      const filter: AuditLogFilter = {};
      if (since) filter.startDate = since;
      if (before) filter.before = before;
      if (sessionsParam !== null) {
        // Comma-separated set membership. An explicit empty value means
        // "no session IDs match" — return nothing rather than everything.
        filter.sessionIds = sessionsParam
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      if (sessionContains) filter.sessionContains = sessionContains;
      if (domain) filter.domain = domain as AuditDomain;

      const items = await getAuditLogs(ctx, filter, limit);
      return json({ items });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  });

  return api;
}
