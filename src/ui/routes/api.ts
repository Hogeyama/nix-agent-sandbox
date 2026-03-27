/**
 * REST API ルート (Hono)
 */

import { Hono } from "hono";
import type { UiDataContext } from "../data.ts";
import {
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
  stopContainer,
} from "../data.ts";
import type { AuditDomain, AuditLogFilter } from "../../audit/types.ts";

export function createApiRoutes(ctx: UiDataContext): Hono {
  const api = new Hono();

  // --- Health ---

  api.get("/health", (c) => {
    return c.json({ ok: true });
  });

  // --- Network ---

  api.get("/network/pending", async (c) => {
    try {
      const items = await getNetworkPending(ctx);
      return c.json({ items });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/network/approve", async (c) => {
    try {
      const body = await c.req.json();
      const { sessionId, requestId, scope } = body;
      if (!sessionId || !requestId) {
        return c.json({ error: "sessionId and requestId are required" }, 400);
      }
      await approveNetwork(ctx, sessionId, requestId, scope);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/network/deny", async (c) => {
    try {
      const body = await c.req.json();
      const { sessionId, requestId } = body;
      if (!sessionId || !requestId) {
        return c.json({ error: "sessionId and requestId are required" }, 400);
      }
      await denyNetwork(ctx, sessionId, requestId);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // --- HostExec ---

  api.get("/hostexec/pending", async (c) => {
    try {
      const items = await getHostExecPending(ctx);
      return c.json({ items });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/hostexec/approve", async (c) => {
    try {
      const body = await c.req.json();
      const { sessionId, requestId, scope } = body;
      if (!sessionId || !requestId) {
        return c.json({ error: "sessionId and requestId are required" }, 400);
      }
      await approveHostExec(ctx, sessionId, requestId, scope);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/hostexec/deny", async (c) => {
    try {
      const body = await c.req.json();
      const { sessionId, requestId } = body;
      if (!sessionId || !requestId) {
        return c.json({ error: "sessionId and requestId are required" }, 400);
      }
      await denyHostExec(ctx, sessionId, requestId);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // --- Sessions ---

  api.get("/sessions", async (c) => {
    try {
      const sessions = await getSessions(ctx);
      return c.json(sessions);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // --- Containers ---

  api.get("/containers", async (c) => {
    try {
      const containers = await getNasContainers();
      return c.json({ items: containers });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/containers/:name/stop", async (c) => {
    try {
      const name = c.req.param("name");
      await stopContainer(name);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  api.post("/containers/clean", async (c) => {
    try {
      const result = await cleanContainers();
      return c.json(result);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // --- Audit ---

  api.get("/audit", async (c) => {
    try {
      const since = c.req.query("since");
      const session = c.req.query("session");
      const domain = c.req.query("domain");
      const limitStr = c.req.query("limit");

      // Validate domain parameter
      if (domain && domain !== "network" && domain !== "hostexec") {
        return c.json(
          { error: 'Invalid domain: must be "network" or "hostexec"' },
          400,
        );
      }

      // Validate limit parameter
      let limit: number | undefined;
      if (limitStr) {
        limit = parseInt(limitStr, 10);
        if (isNaN(limit) || limit < 1) {
          return c.json(
            { error: "Invalid limit: must be a positive integer" },
            400,
          );
        }
      }

      const filter: AuditLogFilter = {};
      if (since) filter.startDate = since;
      if (session) filter.sessionId = session;
      if (domain) filter.domain = domain as AuditDomain;

      const items = await getAuditLogs(ctx, filter, limit);
      return c.json({ items });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  return api;
}
