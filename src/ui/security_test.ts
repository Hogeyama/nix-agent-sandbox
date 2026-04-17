import { describe, expect, test } from "bun:test";
import { guardHttpRequest, guardWebSocketUpgrade } from "./security.ts";

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
