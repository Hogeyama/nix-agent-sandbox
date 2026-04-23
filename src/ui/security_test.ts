import { describe, expect, test } from "bun:test";
import {
  applySecurityHeaders,
  guardHttpRequest,
  guardWebSocketUpgrade,
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
