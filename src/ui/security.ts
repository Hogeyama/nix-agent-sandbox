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

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

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
