/**
 * Hono app 定義 + Deno.serve 起動 + 静的ファイル配信
 */

import { Hono } from "hono";
import { createApiRoutes } from "./routes/api.ts";
import { createSseRoutes } from "./routes/sse.ts";
import { createDataContext } from "./data.ts";
import type { UiDataContext } from "./data.ts";

const DIST_BASE = new URL("./dist/", import.meta.url);

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
    const filePath = new URL(c.req.path.slice(1), DIST_BASE);
    try {
      const content = await Deno.readFile(filePath);
      return new Response(content, {
        headers: { "Content-Type": contentType(c.req.path) },
      });
    } catch {
      return c.notFound();
    }
  });

  app.get("/", async (c) => {
    const filePath = new URL("index.html", DIST_BASE);
    try {
      const content = await Deno.readTextFile(filePath);
      return c.html(content);
    } catch {
      return c.text(
        "UI assets not found. Run 'deno task build-ui' first.",
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
}

export async function startServer(options: ServeOptions): Promise<void> {
  const ctx = await createDataContext(options.runtimeDir);
  const app = createApp(ctx);

  console.log(`[nas] UI server starting on http://localhost:${options.port}`);

  if (options.open) {
    // Fire and forget — best effort browser open
    try {
      const cmd = new Deno.Command("xdg-open", {
        args: [`http://localhost:${options.port}`],
        stdout: "null",
        stderr: "null",
      });
      cmd.spawn();
    } catch {
      // ignore if xdg-open not available
    }
  }

  Deno.serve({
    port: options.port,
    onListen() {
      console.log(
        `[nas] UI server listening on http://localhost:${options.port}`,
      );
    },
  }, app.fetch);

  // Keep the process running
  await new Promise(() => {});
}
