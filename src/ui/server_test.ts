/**
 * Guards against accidental relaxation of the WebSocket payload cap. Bun's
 * default is 16 MiB which is a DoS vector for the terminal input path
 * (threat review F6) — this test pins the value so a silent regression
 * trips CI instead of shipping.
 *
 * 単に定数値を pin するだけでは、`Bun.serve` の `websocket.maxPayloadLength`
 * への配線が外れても検知できない。そのため `WEBSOCKET_CONFIG` (Bun.serve に
 * そのまま渡される object) を直接検証し、定数からハンドラ 3 本 + 上限値まで
 * 一体で回帰テストする。
 */

import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { UiDataContext } from "./data.ts";
import {
  handleTerminalClose,
  handleTerminalMessage,
  handleTerminalOpen,
} from "./routes/terminal.ts";
import {
  createApp,
  materializeAssets,
  type PreloadedAssets,
  preloadAssets,
  WEBSOCKET_CONFIG,
  WS_MAX_PAYLOAD_BYTES,
} from "./server.ts";

test("WS_MAX_PAYLOAD_BYTES is pinned to 64 KiB", () => {
  expect(WS_MAX_PAYLOAD_BYTES).toEqual(64 * 1024);
  expect(WS_MAX_PAYLOAD_BYTES).toEqual(65536);
});

test("WEBSOCKET_CONFIG wires maxPayloadLength to WS_MAX_PAYLOAD_BYTES", () => {
  // Bun.serve がこの object をそのまま受け取るため、ここを assert すれば
  // 「定数は残っているが websocket config への配線が消えた」という回帰を
  // 検出できる。
  expect(WEBSOCKET_CONFIG.maxPayloadLength).toEqual(WS_MAX_PAYLOAD_BYTES);
  expect(WEBSOCKET_CONFIG.maxPayloadLength).toEqual(64 * 1024);
});

test("WEBSOCKET_CONFIG wires terminal handlers", () => {
  // maxPayloadLength だけ assert すると、ハンドラが差し替わる回帰
  // (例: 空 open に置き換わって全セッション壊れる) を検知できない。
  // open/message/close の identity もまとめて pin する。
  expect(WEBSOCKET_CONFIG.open).toBe(handleTerminalOpen);
  expect(WEBSOCKET_CONFIG.message).toBe(handleTerminalMessage);
  expect(WEBSOCKET_CONFIG.close).toBe(handleTerminalClose);
});

// --- WS token injection (C3) ----------------------------------------------

function makePreloaded(template: string | null): PreloadedAssets {
  return { indexHtmlTemplate: template, files: new Map() };
}

// createApp only reads `files` / `indexHtml` from assets; the full
// UiDataContext is not exercised by `/` so an empty cast is sufficient
// to keep this test hermetic (no network/hostexec registry access).
const EMPTY_CTX = {} as UiDataContext;

test("materializeAssets replaces {{NAS_WS_TOKEN}} placeholder with the token", () => {
  const template =
    '<!DOCTYPE html><html><head><meta name="nas-ws-token" content="{{NAS_WS_TOKEN}}" /></head><body></body></html>';
  const runtime = materializeAssets(makePreloaded(template), "tok-abc_123");
  expect(runtime.indexHtml).toContain('content="tok-abc_123"');
  expect(runtime.indexHtml).not.toContain("{{NAS_WS_TOKEN}}");
});

test("materializeAssets preserves null template (dev / missing dist)", () => {
  const runtime = materializeAssets(makePreloaded(null), "tok-abc");
  expect(runtime.indexHtml).toBeNull();
});

test("materializeAssets throws if placeholder survives replace (corrupt template)", () => {
  // Pathological: a template that contains `{{NAS_WS_TOKEN}}` embedded in
  // a way that would survive a naive replace. replaceAll is safe, so the
  // only way to trip this in practice is an upstream bug — but the guard
  // is what converts that bug from "silent" to "loud startup failure".
  // We simulate by passing a token that itself contains the placeholder.
  const template = '<meta name="nas-ws-token" content="{{NAS_WS_TOKEN}}" />';
  // A token containing the placeholder would cause includes() to trip.
  // Using the placeholder as the token is the simplest reproduction.
  expect(() =>
    materializeAssets(makePreloaded(template), "{{NAS_WS_TOKEN}}"),
  ).toThrow(/WS token injection failed/);
});

test("createApp serves materialised index.html with injected token", async () => {
  const template =
    '<!DOCTYPE html><html><head><meta name="nas-ws-token" content="{{NAS_WS_TOKEN}}" /></head><body></body></html>';
  const runtime = materializeAssets(makePreloaded(template), "injected-token");
  const app = createApp(EMPTY_CTX, runtime);
  const res = await app.request("/");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain('content="injected-token"');
  expect(body).not.toContain("{{NAS_WS_TOKEN}}");
});

test("createApp returns 500 when indexHtml is null (dist not built)", async () => {
  const app = createApp(EMPTY_CTX, { indexHtml: null, files: new Map() });
  const res = await app.request("/");
  expect(res.status).toBe(500);
});

// --- preloadAssets ENOENT / EACCES handling --------------------------------
//
// The `catch { if (code !== "ENOENT") throw e }` pattern in preloadAssets is
// load-bearing: it must (a) swallow ENOENT so the UI daemon still boots when
// `dist/` is missing, but (b) re-throw everything else so a permission /
// I/O problem is surfaced loudly instead of silently serving a broken UI.
//
// These tests pin both arms. Without (b)'s test, a future refactor reverting
// to `catch {}` would pass CI but silently regress the error-surfacing
// contract. The `distBase` DI parameter exists specifically to make this
// testable without touching the real DIST_BASE.

test("preloadAssets returns null template and empty files when distBase does not exist", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-preload-enoent-"));
  try {
    // Point at a subpath that does not exist — both index.html and assets/
    // lookups will ENOENT, both should be swallowed.
    const missing = path.join(dir, "does-not-exist");
    const result = await preloadAssets(missing);
    expect(result.indexHtmlTemplate).toBeNull();
    expect(result.files.size).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preloadAssets loads index.html when present and tolerates missing assets/ dir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-preload-partial-"));
  try {
    await writeFile(path.join(dir, "index.html"), "<html>hi</html>", "utf8");
    // assets/ intentionally absent → readdir throws ENOENT, swallowed
    const result = await preloadAssets(dir);
    expect(result.indexHtmlTemplate).toBe("<html>hi</html>");
    expect(result.files.size).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preloadAssets re-throws non-ENOENT errors (e.g. EACCES) instead of swallowing", async () => {
  // Root bypasses file-mode permission checks, so this test can only
  // meaningfully run as an unprivileged user. On CI / dev machines we are
  // non-root; if somehow run as root, skip rather than silently pass.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return;
  }

  const dir = await mkdtemp(path.join(tmpdir(), "nas-preload-eacces-"));
  // Create index.html, then chmod the parent dir to 000 so the readFile
  // inside preloadAssets gets EACCES (not ENOENT) when traversing in.
  await writeFile(path.join(dir, "index.html"), "<html></html>", "utf8");
  await chmod(dir, 0o000);

  let threw: unknown = null;
  try {
    try {
      await preloadAssets(dir);
    } catch (e) {
      threw = e;
    }
  } finally {
    // Always restore perms before rm, otherwise rm itself hits EACCES and
    // leaks a chmod-000 directory into tmpdir. Any cleanup failure is
    // logged (so CI operators can see tmpdir pollution) but NOT thrown,
    // because we must not mask the primary `threw` value captured above.
    try {
      await chmod(dir, 0o755);
      await rm(dir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn("[test] EACCES re-throw cleanup failed:", cleanupErr);
    }
  }

  expect(threw).not.toBeNull();
  // NodeJS.ErrnoException carries a string code; must NOT be ENOENT,
  // otherwise the test would pass even if the catch block swallowed
  // everything. EACCES is what chmod 000 produces here.
  const code = (threw as NodeJS.ErrnoException).code;
  expect(code).toBe("EACCES");
});
