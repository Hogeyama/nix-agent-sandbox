/**
 * Router 定義 + Bun.serve 起動 + 静的ファイル配信
 *
 * 静的アセットは起動時にメモリへプリロードする。
 * nix-bundle-elf (single-exe) では親プロセス終了時に /tmp の展開物が
 * trap で削除されるが、fork されたデーモンはプリロード済みデータで配信を続けられる。
 */

import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { listHostExecPendingEntries } from "../hostexec/registry.ts";
import { resolveAssetDir } from "../lib/asset.ts";
import {
  listPendingEntries,
  listSessionRegistries,
} from "../network/registry.ts";
import type { UiDataContext } from "./data.ts";
import { createDataContext } from "./data.ts";
import { html, Router, text } from "./router.ts";
import { createApiRoutes } from "./routes/api.ts";
import { createSseRoutes } from "./routes/sse.ts";
import {
  extractSessionId,
  handleTerminalClose,
  handleTerminalMessage,
  handleTerminalOpen,
  type TerminalWSData,
  validateTerminalUpgrade,
} from "./routes/terminal.ts";

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

function contentType(p: string): string {
  const ext = p.slice(p.lastIndexOf("."));
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export interface PreloadedAssets {
  indexHtml: string | null;
  /** pathname → Blob (contentType 込み) */
  files: Map<string, Blob>;
}

export async function preloadAssets(): Promise<PreloadedAssets> {
  const files = new Map<string, Blob>();
  let indexHtml: string | null = null;

  try {
    indexHtml = await readFile(path.join(DIST_BASE, "index.html"), "utf8");
  } catch {
    // index.html not found — will return 500 at request time
  }

  try {
    const assetsDir = path.join(DIST_BASE, "assets");
    const entries = await readdir(assetsDir);
    for (const entry of entries) {
      const filePath = path.join(assetsDir, entry);
      const buf = await readFile(filePath);
      files.set(
        `/assets/${entry}`,
        new Blob([buf], { type: contentType(entry) }),
      );
    }
  } catch {
    // assets dir not found — will return 404 at request time
  }

  return { indexHtml, files };
}

export function createApp(ctx: UiDataContext, assets: PreloadedAssets): Router {
  const app = new Router();

  // API routes
  app.route("/api", createApiRoutes(ctx));
  app.route("/api", createSseRoutes(ctx));

  // Static file serving (from preloaded memory)
  app.get("/assets/*", ({ url }) => {
    const blob = assets.files.get(url.pathname);
    if (blob) {
      return new Response(blob);
    }
    return new Response("404 Not Found", { status: 404 });
  });

  app.get("/", () => {
    if (assets.indexHtml !== null) {
      return html(assets.indexHtml);
    }
    return text("UI assets not found. Run 'bun run build-ui' first.", 500);
  });

  return app;
}

export interface ServeOptions {
  port: number;
  open: boolean;
  idleTimeout?: number;
}

export async function startServer(options: ServeOptions): Promise<void> {
  const ctx = await createDataContext();
  const assets = await preloadAssets();
  const app = createApp(ctx, assets);

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

  Bun.serve<TerminalWSData>({
    port: options.port,
    fetch: async (req, server) => {
      // WebSocket upgrade for terminal sessions
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const url = new URL(req.url);
        const sessionId = extractSessionId(url.pathname);
        if (!sessionId) {
          return new Response("Invalid terminal path", { status: 400 });
        }
        const result = await validateTerminalUpgrade(sessionId);
        if (!result.ok) {
          return new Response(result.reason, { status: 404 });
        }
        const ok = server.upgrade(req, {
          data: { sessionId, socket: null },
        });
        if (ok) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
      return app.fetch(req);
    },
    websocket: {
      open: handleTerminalOpen,
      message: handleTerminalMessage,
      close: handleTerminalClose,
    },
  });

  console.log(`[nas] UI server listening on http://localhost:${options.port}`);

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
      const hasActivity =
        sessions.length > 0 || netPending.length > 0 || hePending.length > 0;

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
