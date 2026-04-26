/**
 * Read the WebSocket bearer token injected by the daemon into the HTML
 * shell's `<meta name="nas-ws-token">` tag.
 *
 * The token is materialised at daemon startup from `${daemonStateDir}/
 * daemon.token` and passed back to the daemon as the WebSocket
 * `Sec-WebSocket-Protocol` subprotocol so the daemon can authenticate
 * same-origin connections.
 *
 * Why this throws on every degenerate case
 * ----------------------------------------
 *
 *   - A missing meta tag, an empty `content`, or the literal placeholder
 *     `{{NAS_WS_TOKEN}}` all mean the UI bundle and the daemon are out
 *     of sync (e.g. the daemon never ran the asset materialiser, or the
 *     bundle was served raw from disk during development). Returning a
 *     fallback string would produce a WebSocket that *looks* authorised
 *     but is actually unauthenticated, which is exactly what the token
 *     subsystem exists to prevent. Failing loudly at load time is the
 *     only safe behaviour.
 *
 * The `doc` parameter defaults to `document` but is overridable so
 * tests can drive the function with a fake DOM.
 */
export function getWsToken(doc: Document = document): string {
  const meta = doc.querySelector('meta[name="nas-ws-token"]');
  if (!meta) {
    throw new Error(
      "WS token not injected — UI daemon may be out of sync with frontend build",
    );
  }
  const content = meta.getAttribute("content");
  if (content === null || content === "") {
    throw new Error(
      "WS token not injected — UI daemon may be out of sync with frontend build",
    );
  }
  if (content === "{{NAS_WS_TOKEN}}") {
    throw new Error(
      "WS token not injected — UI daemon may be out of sync with frontend build",
    );
  }
  return content;
}
