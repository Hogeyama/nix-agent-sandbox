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
  getHostExecPending,
  getNasContainers,
  getNetworkPending,
  getSessions,
  stopContainer,
} from "../data.ts";

export function createApiRoutes(ctx: UiDataContext): Hono {
  const api = new Hono();

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

  return api;
}
