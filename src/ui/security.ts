/**
 * Origin/Host guard for the UI HTTP + WebSocket server.
 *
 * Even though the daemon binds to 127.0.0.1, a browser the user has open can
 * still reach it. Two classes of attack are in scope:
 *
 *   1. DNS rebinding — attacker-controlled domain resolves to 127.0.0.1
 *      after the initial page load, turning cross-origin reads into same-
 *      origin ones. Blocked by strict `Host` header allowlisting.
 *
 *   2. Cross-site requests / WebSocket hijacking — an attacker page at
 *      http://evil.example can POST to http://127.0.0.1:<port>/api/... or
 *      open ws://127.0.0.1:<port>/api/terminal/... . Blocked by requiring
 *      the `Origin` header to match the loopback origin for mutating
 *      requests and for WebSocket upgrades.
 */

import { tokenEquals } from "./ws_token.ts";

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Subprotocol prefix used to smuggle the WS bearer token through
 * `Sec-WebSocket-Protocol`. Browsers expose `new WebSocket(url, [proto])` but
 * no API for custom handshake headers, so the token rides in a subprotocol
 * offer of the form `nas.token.<base64url>`.
 */
export const WS_TOKEN_SUBPROTOCOL_PREFIX = "nas.token.";

export interface OriginGuardOptions {
  port: number;
}

function allowedHostHeaders(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

function allowedOrigins(port: number): Set<string> {
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
}

export function checkHost(req: Request, port: number): Response | null {
  const host = req.headers.get("host");
  if (host === null || !allowedHostHeaders(port).has(host.toLowerCase())) {
    return new Response("Forbidden: invalid Host header", { status: 403 });
  }
  return null;
}

export function checkOrigin(req: Request, port: number): Response | null {
  const origin = req.headers.get("origin");
  if (origin === null) {
    // Only reject missing Origin for mutating requests; GETs without Origin
    // (direct navigation, curl) are fine because Host is already checked.
    return new Response("Forbidden: Origin header required", { status: 403 });
  }
  if (!allowedOrigins(port).has(origin.toLowerCase())) {
    return new Response("Forbidden: cross-origin request", { status: 403 });
  }
  return null;
}

/**
 * Guard an incoming HTTP request. Returns a rejection Response if the
 * request should be blocked, or null if it may proceed.
 *
 * Semantics:
 *   - Host header must always match a loopback origin (DNS-rebinding guard).
 *   - For POST/PATCH/PUT/DELETE, Origin must additionally match (CSRF guard).
 *   - GET requests without Origin are allowed (direct navigation, SSE from
 *     same-origin UI, curl / local tooling).
 */
export function guardHttpRequest(
  req: Request,
  options: OriginGuardOptions,
): Response | null {
  const hostReject = checkHost(req, options.port);
  if (hostReject) return hostReject;
  if (MUTATING_METHODS.has(req.method.toUpperCase())) {
    return checkOrigin(req, options.port);
  }
  // For same-origin GETs, Origin may be omitted by the browser. If present,
  // it must still match — a cross-origin GET that leaks data would otherwise
  // be allowed despite Host matching (e.g. via <img>/<script> tags can't set
  // Host, but direct fetch from evil.com would carry Origin: http://evil…).
  const origin = req.headers.get("origin");
  if (
    origin !== null &&
    !allowedOrigins(options.port).has(origin.toLowerCase())
  ) {
    return new Response("Forbidden: cross-origin request", { status: 403 });
  }
  return null;
}

/**
 * Guard an incoming WebSocket upgrade. Browsers always send Origin for
 * WebSocket handshakes, so we require it and require it to match.
 */
export function guardWebSocketUpgrade(
  req: Request,
  options: OriginGuardOptions,
): Response | null {
  const hostReject = checkHost(req, options.port);
  if (hostReject) return hostReject;
  return checkOrigin(req, options.port);
}

/** Outcome of `verifyWsTokenSubprotocol`. */
export type WsTokenVerifyResult =
  | { ok: true; echo: string }
  | { ok: false; reason: WsTokenFailureReason };

/**
 * Stable reason codes for WS token verification failures.
 *
 * These are surfaced verbatim in the 401 response body and therefore reach
 * the browser's `WebSocket.onclose.reason`. They must NOT contain the
 * offered or expected token value — only the category of failure — so that
 * a hostile script that can observe its own upgrade-close reason cannot
 * use the server to confirm a guessed token.
 */
export type WsTokenFailureReason =
  | "missing-subprotocol"
  | "bad-format"
  | "token-mismatch";

/**
 * Verify that the WS upgrade request carries our bearer token smuggled in
 * `Sec-WebSocket-Protocol`. This is the programmatic-client defence from
 * threat review F1: Origin + Host checks alone cannot distinguish a real
 * browser tab from a same-origin non-browser process, but the token —
 * materialised into the HTML shell and served only to same-origin GETs —
 * is not reachable to an attacker who cannot already read the user's DOM.
 *
 * The client offers `nas.token.<base64url>` as a subprotocol; on success we
 * echo the exact same string back so the RFC 6455 handshake completes. On
 * failure we return a reason code for the caller to place in the 401 body.
 *
 * Comparison uses `tokenEquals` (constant-time) — a hostile script cannot
 * leak the token via upgrade-timing differences.
 */
export function verifyWsTokenSubprotocol(
  req: Request,
  expected: string,
): WsTokenVerifyResult {
  const raw = req.headers.get("sec-websocket-protocol");
  if (raw === null) {
    return { ok: false, reason: "missing-subprotocol" };
  }

  // RFC 6455 §4.1 allows the client to offer multiple subprotocols,
  // comma-separated. Trim each so incidental whitespace does not matter.
  const offers = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (offers.length === 0) {
    return { ok: false, reason: "missing-subprotocol" };
  }

  let sawPrefix = false;
  for (const offer of offers) {
    if (!offer.startsWith(WS_TOKEN_SUBPROTOCOL_PREFIX)) {
      continue;
    }
    sawPrefix = true;
    const actual = offer.slice(WS_TOKEN_SUBPROTOCOL_PREFIX.length);
    if (tokenEquals(actual, expected)) {
      // Echo the exact offered string (not re-constructed) so we don't
      // accidentally normalise and break the client's protocol check.
      return { ok: true, echo: offer };
    }
    // Keep scanning: another offer might carry the right token.
  }

  if (!sawPrefix) {
    return { ok: false, reason: "bad-format" };
  }
  return { ok: false, reason: "token-mismatch" };
}

/**
 * Apply security response headers to an outgoing Response.
 *
 * These headers harden the loopback UI against a few browser-level
 * attack classes (framing, MIME sniffing, cross-origin resource reads,
 * powerful-feature abuse) and satisfy the OWASP ZAP baseline findings
 * for CSP / X-Frame-Options / X-Content-Type-Options / COOP / CORP /
 * Permissions-Policy.
 *
 * Existing headers on the Response are preserved — routes that
 * intentionally set their own (e.g. a custom CSP) win.
 *
 * Note: Response headers can be immutable (e.g. when constructed from
 * `new Response(blob)` in some runtimes). We always copy into a fresh
 * Headers instance and rebuild the Response so `.set` is safe.
 */
export function applySecurityHeaders(
  res: Response,
  options: { port: number },
): Response {
  const headers = new Headers(res.headers);

  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ws://127.0.0.1:${options.port} ws://localhost:${options.port}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  const defaults: Array<[string, string]> = [
    ["Content-Security-Policy", csp],
    ["X-Frame-Options", "DENY"],
    ["X-Content-Type-Options", "nosniff"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
    ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
  ];

  for (const [name, value] of defaults) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
