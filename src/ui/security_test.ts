import { describe, expect, test } from "bun:test";
import {
  applySecurityHeaders,
  guardHttpRequest,
  guardWebSocketUpgrade,
  verifyWsTokenSubprotocol,
  WS_TOKEN_SUBPROTOCOL_PREFIX,
} from "./security.ts";

const PORT = 3939;

function mkReq(
  method: string,
  headers: Record<string, string>,
  url = "http://127.0.0.1:3939/api/health",
): Request {
  return new Request(url, { method, headers });
}

describe("guardHttpRequest", () => {
  test("allows same-origin GET with loopback Host", () => {
    const res = guardHttpRequest(mkReq("GET", { host: "127.0.0.1:3939" }), {
      port: PORT,
    });
    expect(res).toBeNull();
  });

  test("allows localhost Host", () => {
    const res = guardHttpRequest(mkReq("GET", { host: "localhost:3939" }), {
      port: PORT,
    });
    expect(res).toBeNull();
  });

  test("rejects unknown Host header (DNS rebinding)", () => {
    const res = guardHttpRequest(mkReq("GET", { host: "evil.example:3939" }), {
      port: PORT,
    });
    expect(res?.status).toBe(403);
  });

  test("rejects mismatched port", () => {
    const res = guardHttpRequest(mkReq("GET", { host: "127.0.0.1:1234" }), {
      port: PORT,
    });
    expect(res?.status).toBe(403);
  });

  test("rejects missing Host", () => {
    const res = guardHttpRequest(mkReq("GET", {}), { port: PORT });
    expect(res?.status).toBe(403);
  });

  test("rejects POST without Origin (CSRF)", () => {
    const res = guardHttpRequest(mkReq("POST", { host: "127.0.0.1:3939" }), {
      port: PORT,
    });
    expect(res?.status).toBe(403);
  });

  test("rejects POST with cross-origin Origin", () => {
    const res = guardHttpRequest(
      mkReq("POST", {
        host: "127.0.0.1:3939",
        origin: "http://evil.example",
      }),
      { port: PORT },
    );
    expect(res?.status).toBe(403);
  });

  test("allows POST with loopback Origin", () => {
    const res = guardHttpRequest(
      mkReq("POST", {
        host: "127.0.0.1:3939",
        origin: "http://127.0.0.1:3939",
      }),
      { port: PORT },
    );
    expect(res).toBeNull();
  });

  test("allows PATCH with localhost Origin", () => {
    const res = guardHttpRequest(
      mkReq("PATCH", {
        host: "localhost:3939",
        origin: "http://localhost:3939",
      }),
      { port: PORT },
    );
    expect(res).toBeNull();
  });

  test("rejects GET that carries a cross-origin Origin header", () => {
    const res = guardHttpRequest(
      mkReq("GET", {
        host: "127.0.0.1:3939",
        origin: "http://evil.example",
      }),
      { port: PORT },
    );
    expect(res?.status).toBe(403);
  });
});

describe("guardWebSocketUpgrade", () => {
  test("allows loopback Host+Origin", () => {
    const res = guardWebSocketUpgrade(
      mkReq("GET", {
        host: "127.0.0.1:3939",
        origin: "http://127.0.0.1:3939",
      }),
      { port: PORT },
    );
    expect(res).toBeNull();
  });

  test("rejects cross-origin upgrade (CSWSH)", () => {
    const res = guardWebSocketUpgrade(
      mkReq("GET", {
        host: "127.0.0.1:3939",
        origin: "http://evil.example",
      }),
      { port: PORT },
    );
    expect(res?.status).toBe(403);
  });

  test("rejects upgrade without Origin", () => {
    const res = guardWebSocketUpgrade(
      mkReq("GET", { host: "127.0.0.1:3939" }),
      {
        port: PORT,
      },
    );
    expect(res?.status).toBe(403);
  });

  test("rejects upgrade with rebinding Host", () => {
    const res = guardWebSocketUpgrade(
      mkReq("GET", {
        host: "evil.example:3939",
        origin: "http://evil.example:3939",
      }),
      { port: PORT },
    );
    expect(res?.status).toBe(403);
  });
});

describe("verifyWsTokenSubprotocol", () => {
  const EXPECTED = "expected-token-value_123";

  function mkWsReq(headers: Record<string, string>): Request {
    return new Request("http://127.0.0.1:3939/api/terminal/session-1", {
      method: "GET",
      headers,
    });
  }

  test("WS_TOKEN_SUBPROTOCOL_PREFIX is the documented constant", () => {
    // Pins the wire prefix so frontend/backend never silently drift.
    expect(WS_TOKEN_SUBPROTOCOL_PREFIX).toBe("nas.token.");
  });

  test("missing Sec-WebSocket-Protocol rejects as missing-subprotocol", () => {
    const res = verifyWsTokenSubprotocol(mkWsReq({}), EXPECTED);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing-subprotocol");
  });

  test("empty Sec-WebSocket-Protocol rejects as missing-subprotocol", () => {
    const res = verifyWsTokenSubprotocol(
      mkWsReq({ "sec-websocket-protocol": "   ,  , " }),
      EXPECTED,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing-subprotocol");
  });

  test("unknown subprotocol (wrong prefix) rejects as bad-format", () => {
    const res = verifyWsTokenSubprotocol(
      mkWsReq({ "sec-websocket-protocol": "foo.bar.xxx" }),
      EXPECTED,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad-format");
  });

  test("correct prefix but wrong token rejects as token-mismatch", () => {
    const res = verifyWsTokenSubprotocol(
      mkWsReq({ "sec-websocket-protocol": "nas.token.not-the-right-value" }),
      EXPECTED,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("token-mismatch");
  });

  test("correct prefix + correct token returns ok + echo", () => {
    const offer = `nas.token.${EXPECTED}`;
    const res = verifyWsTokenSubprotocol(
      mkWsReq({ "sec-websocket-protocol": offer }),
      EXPECTED,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.echo).toBe(offer);
  });

  test("multiple offers, one is valid → ok", () => {
    const offer = `nas.token.${EXPECTED}`;
    const res = verifyWsTokenSubprotocol(
      mkWsReq({
        "sec-websocket-protocol": `chat, ${offer}, other.proto`,
      }),
      EXPECTED,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.echo).toBe(offer);
  });

  test("multiple offers, none valid → reject", () => {
    // A mix: one non-nas entry (triggers bad-format arm only), and one
    // nas.token.* with wrong value (should dominate → token-mismatch).
    const res = verifyWsTokenSubprotocol(
      mkWsReq({
        "sec-websocket-protocol": "chat, nas.token.WRONG, other.proto",
      }),
      EXPECTED,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("token-mismatch");
  });

  test("multiple offers, all non-nas → bad-format", () => {
    const res = verifyWsTokenSubprotocol(
      mkWsReq({
        "sec-websocket-protocol": "chat, other.proto",
      }),
      EXPECTED,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad-format");
  });

  test("differing-length token does not throw (constant-time wrap)", () => {
    // tokenEquals must swallow length differences without throwing; pin
    // that verifyWsTokenSubprotocol never leaks a synchronous exception.
    // `expected` is 25 chars; offered slice is 3 chars — different lengths.
    let threw: unknown = null;
    let result: { ok: boolean } | null = null;
    try {
      result = verifyWsTokenSubprotocol(
        mkWsReq({ "sec-websocket-protocol": "nas.token.abc" }),
        EXPECTED,
      );
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
    expect(result?.ok).toBe(false);
  });

  test("reason code never contains the token value (no leak via onclose)", () => {
    const res = verifyWsTokenSubprotocol(
      mkWsReq({ "sec-websocket-protocol": "nas.token.SECRET-GUESS-ABC" }),
      EXPECTED,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // The reason code should be a fixed enum — not a string containing
      // either the offered or expected token value.
      expect(res.reason).toBe("token-mismatch");
      expect(res.reason).not.toContain("SECRET-GUESS-ABC");
      expect(res.reason).not.toContain(EXPECTED);
    }
  });
});

describe("applySecurityHeaders", () => {
  test("sets all six OWASP baseline headers", () => {
    const res = applySecurityHeaders(new Response("ok"), { port: PORT });
    expect(res.headers.get("Content-Security-Policy")).not.toBeNull();
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  test("CSP connect-src contains the configured port for ws://", () => {
    const res = applySecurityHeaders(new Response("ok"), { port: 12345 });
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("ws://127.0.0.1:12345");
    expect(csp).toContain("ws://localhost:12345");
    expect(csp).not.toContain("ws://127.0.0.1:3939");
  });

  test("CSP hardens framing and form/base", () => {
    const res = applySecurityHeaders(new Response("ok"), { port: PORT });
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  test("preserves body and status of the original Response", async () => {
    const original = new Response("hello-body", {
      status: 418,
      statusText: "I'm a teapot",
    });
    const res = applySecurityHeaders(original, { port: PORT });
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("hello-body");
  });

  test("does not overwrite headers already present", () => {
    const original = new Response("ok", {
      headers: { "X-Frame-Options": "SAMEORIGIN" },
    });
    const res = applySecurityHeaders(original, { port: PORT });
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    // Other defaults still applied
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
