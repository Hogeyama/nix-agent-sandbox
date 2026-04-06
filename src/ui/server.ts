/**
 * Hono app 定義 + Bun.serve 起動 + 静的ファイル配信
 */

import { Hono } from "hono";
import { createApiRoutes } from "./routes/api.ts";
import { createSseRoutes } from "./routes/sse.ts";
import { createDataContext } from "./data.ts";
import type { UiDataContext } from "./data.ts";
import {
  listPendingEntries,
  listSessionRegistries,
} from "../network/registry.ts";
import { listHostExecPendingEntries } from "../hostexec/registry.ts";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { resolveAssetDir } from "../lib/asset.ts";

const DIST_BASE = resolveAssetDir("ui/dist", import.meta.url, "./dist/");
const IDLE_CHECK_INTERVAL_MS = 30_000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function createApp(ctx: UiDataContext): Hono {
  const app = new Hono();

  // API routes
  app.route("/api", createApiRoutes(ctx));
  app.route("/api", createSseRoutes(ctx));

  // Static file serving
  app.get("/assets/*", async (c) => {
    const filePath = path.join(DIST_BASE, c.req.path.slice(1));
    try {
      const content = await readFile(filePath);
      return new Response(content, {
        headers: { "Content-Type": contentType(c.req.path) },
      });
    } catch {
      return c.notFound();
    }
  });

  app.get("/", async (c) => {
    const filePath = path.join(DIST_BASE, "index.html");
    try {
      const content = await readFile(filePath, "utf8");
      return c.html(content);
    } catch {
      return c.text(
        "UI assets not found. Run 'bun run build-ui' first.",
        500,
      );
    }
  });

  return app;
}

export interface ServeOptions {
  port: number;
  open: boolean;
  runtimeDir?: string;
  idleTimeout?: number;
}

export async function startServer(options: ServeOptions): Promise<void> {
  const ctx = await createDataContext(options.runtimeDir);
  const app = createApp(ctx);

  console.log(`[nas] UI server starting on http://localhost:${options.port}`);

  if (options.open) {
    // Fire and forget — best effort browser open
    try {
      Bun.spawn(["xdg-open", `http://localhost:${options.port}`], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // ignore if xdg-open not available
    }
  }

  Bun.serve({
    port: options.port,
    fetch: app.fetch,
  });

  console.log(
    `[nas] UI server listening on http://localhost:${options.port}`,
  );

  if (options.idleTimeout && options.idleTimeout > 0) {
    startIdleWatcher(ctx, options.idleTimeout);
  }

  // Keep the process running
  await new Promise(() => {});
}

function startIdleWatcher(ctx: UiDataContext, idleTimeoutSec: number): void {
  let idleSince: number | null = null;

  setInterval(async () => {
    try {
      const [sessions, netPending, hePending] = await Promise.all([
        listSessionRegistries(ctx.networkPaths),
        listPendingEntries(ctx.networkPaths),
        listHostExecPendingEntries(ctx.hostExecPaths),
      ]);
      const hasActivity = sessions.length > 0 || netPending.length > 0 ||
        hePending.length > 0;

      if (hasActivity) {
        idleSince = null;
        return;
      }

      if (idleSince === null) {
        idleSince = Date.now();
        return;
      }

      if (Date.now() - idleSince >= idleTimeoutSec * 1000) {
        console.log(
          `[nas] UI daemon idle for ${idleTimeoutSec}s, shutting down`,
        );
        process.exit(0);
      }
    } catch {
      // registry read errors are non-fatal for the idle watcher
    }
  }, IDLE_CHECK_INTERVAL_MS);
}
