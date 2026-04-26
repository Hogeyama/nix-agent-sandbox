/**
 * Tests for the REST client wrapper.
 *
 * The wrapper has two responsibilities worth pinning:
 *   1. Header shape — `Content-Type` is sent only with a body, never
 *      with bodyless GETs.
 *   2. Error semantics — non-2xx always throws, with a best-effort
 *      message extracted from `{error}` JSON or fallback to statusText;
 *      successful responses always parse JSON, with parse failures
 *      surfacing as rejections rather than silent `undefined` returns.
 *
 * `globalThis.fetch` is swapped for each test and restored afterwards
 * so tests do not leak state into the rest of the suite.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getLaunchBranches, killTerminalClients, request } from "./client";

type FetchFn = typeof globalThis.fetch;
type FetchImpl = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

let originalFetch: FetchFn;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(impl: FetchImpl): ReturnType<typeof mock<FetchImpl>> {
  const fn = mock(impl);
  globalThis.fetch = fn as unknown as FetchFn;
  return fn;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("request", () => {
  test("200 OK with JSON body resolves to the parsed payload", async () => {
    installFetch(async () => jsonResponse({ ok: true, value: 42 }));
    const result = await request<{ ok: boolean; value: number }>(
      "GET",
      "/api/x",
    );
    expect(result).toEqual({ ok: true, value: 42 });
  });

  test("with body, sets Content-Type and stringifies the payload", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ ok: true }));
    await request("POST", "/api/x", { foo: "bar" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ foo: "bar" }));
  });

  test("without body, omits Content-Type header and body", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ ok: true }));
    await request("GET", "/api/x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  test("non-2xx with JSON {error} throws Error with that message", async () => {
    installFetch(
      async () =>
        new Response(JSON.stringify({ error: "boom" }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(request("GET", "/api/x")).rejects.toThrow("boom");
  });

  test("non-2xx with non-JSON body falls back to statusText", async () => {
    installFetch(
      async () =>
        new Response("not json", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "text/plain" },
        }),
    );
    await expect(request("GET", "/api/x")).rejects.toThrow(
      "Internal Server Error",
    );
  });

  test("fetch rejection propagates to the caller", async () => {
    installFetch(async () => {
      throw new Error("network down");
    });
    await expect(request("GET", "/api/x")).rejects.toThrow("network down");
  });

  test("200 OK with malformed JSON body rejects rather than returning undefined", async () => {
    installFetch(
      async () =>
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(request("GET", "/api/x")).rejects.toThrow();
  });
});

describe("URL encoding", () => {
  test("getLaunchBranches encodes cwd containing spaces and non-ASCII", async () => {
    const fetchMock = installFetch(async () =>
      jsonResponse({ currentBranch: null, hasMain: false }),
    );
    await getLaunchBranches("/home/user/プロジェクト name");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/api/launch/branches?cwd=${encodeURIComponent(
        "/home/user/プロジェクト name",
      )}`,
    );
    // Sanity-check: literal slash, space, and Japanese characters are
    // all percent-encoded so they cannot be misread as path segments
    // or unparseable query components.
    expect(url).not.toContain(" ");
    expect(url).not.toContain("プロジェクト");
  });

  test("killTerminalClients encodes sessionId containing reserved characters", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ killed: 0 }));
    await killTerminalClients("weird/session&id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(url).toBe(
      `/api/terminal/${encodeURIComponent("weird/session&id")}/kill-clients`,
    );
    // The unsafe `/` and `&` in the raw id must not appear literally
    // in the path — otherwise the backend would route the request to
    // a different endpoint or interpret part of it as a query string.
    expect(url).not.toContain("weird/session&id");
  });
});
