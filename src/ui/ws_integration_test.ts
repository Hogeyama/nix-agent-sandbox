/**
 * Minimal integration coverage for the WS bearer-token gate.
 *
 * The unit tests in `security_test.ts` exercise `verifyWsTokenSubprotocol`
 * against synthesised `Request` objects. That proves the logic but does
 * NOT prove the wiring end-to-end:
 *
 *   - Is the subprotocol echo round-tripped correctly by `Bun.serve.upgrade`?
 *   - Does a real browser-style `new WebSocket(url, [proto])` client fail
 *     its handshake when the server returns a 401 for a bad token?
 *
 * Both are runtime-contract concerns that a unit test against a `Request`
 * stub cannot detect. We spin up a real `Bun.serve` on an ephemeral port
 * and probe it with the global `WebSocket` client.
 *
 * The test replicates only the token-check + upgrade path — not the full
 * terminal bridge — so it stays hermetic (no dtach, no filesystem).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { verifyWsTokenSubprotocol } from "./security.ts";

interface WsTestData {
  ok: boolean;
}

const TOKEN = "integration-test-token-xyz_123";

// Bun.serve returns a generic Server; we only need stop() + port here, so
// avoid an explicit type annotation that fights Bun's generic constraints.
let server: ReturnType<typeof Bun.serve<WsTestData>> | null = null;
let port = 0;

beforeAll(() => {
  server = Bun.serve<WsTestData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("not a ws", { status: 400 });
      }
      const result = verifyWsTokenSubprotocol(req, TOKEN);
      if (!result.ok) {
        return new Response(`WS token: ${result.reason}`, { status: 401 });
      }
      const ok = srv.upgrade(req, {
        data: { ok: true },
        headers: { "Sec-WebSocket-Protocol": result.echo },
      });
      if (ok) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 500 });
    },
    websocket: {
      open(ws) {
        ws.send("hello");
      },
      message() {},
      close() {},
    },
  });
  // `server.port` can be undefined for non-TCP binds; we bound to a TCP
  // port above, so narrow rather than silently coercing.
  if (typeof server.port !== "number") {
    throw new Error("test server did not bind to a TCP port");
  }
  port = server.port;
});

afterAll(() => {
  // Primary error (assertion) must not be masked by a stop failure.
  try {
    server?.stop(true);
  } catch (e) {
    console.warn("[ws_integration_test] server.stop failed:", e);
  }
});

interface ConnectOutcome {
  kind: "open" | "close" | "error" | "timeout";
  code?: number;
  protocol?: string;
}

function connectOnce(subprotocols: string[]): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, subprotocols);
    const timer = setTimeout(() => resolve({ kind: "timeout" }), 2000);
    // Capture the outcome synchronously when `open` fires, then close the
    // connection. Do NOT call resolve() here before close() — in Bun,
    // `ws.close()` dispatches the `close` event synchronously, which would
    // race the `open` resolve() and cause the close handler to "win".
    let opened: ConnectOutcome | null = null;
    ws.addEventListener("open", () => {
      opened = { kind: "open", protocol: ws.protocol };
      clearTimeout(timer);
      resolve(opened);
      // Closing AFTER resolve ensures the latched outcome is "open".
      ws.close(1000);
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      // If we already latched "open", the outer resolve is a no-op; this
      // keeps the handler safe when close follows a successful handshake.
      resolve(opened ?? { kind: "close", code: ev.code });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      // error is usually followed by close; resolve is idempotent.
      resolve(opened ?? { kind: "error" });
    });
  });
}

test("correct subprotocol token → handshake succeeds and protocol is echoed", async () => {
  const outcome = await connectOnce([`nas.token.${TOKEN}`]);
  expect(outcome.kind).toBe("open");
  expect(outcome.protocol).toBe(`nas.token.${TOKEN}`);
});

test("wrong subprotocol token → handshake rejected (no open)", async () => {
  const outcome = await connectOnce(["nas.token.WRONG"]);
  // Browsers / Bun surface a failed handshake as a close (code 1002 typical)
  // preceded by an error. We only assert that the connection did NOT reach
  // "open" — the exact close code is not part of our contract.
  expect(outcome.kind).not.toBe("open");
});

test("missing subprotocol → handshake rejected (no open)", async () => {
  const outcome = await connectOnce([]);
  expect(outcome.kind).not.toBe("open");
});

test("subprotocol with wrong prefix → handshake rejected (no open)", async () => {
  const outcome = await connectOnce(["foo.bar.baz"]);
  expect(outcome.kind).not.toBe("open");
});
