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
import {
  ackSessionTurn,
  approveHostExec,
  approveNetwork,
  denyHostExec,
  denyNetwork,
  getAuditLogs,
  getInfo,
  getLaunchBranches,
  getLaunchInfo,
  HttpError,
  killTerminalClients,
  renameSession,
  request,
  startShell,
  stopContainer,
} from "./client";

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

  test("ackSessionTurn encodes sessionId containing reserved characters", async () => {
    const fetchMock = installFetch(async () =>
      jsonResponse({ item: { sessionId: "weird/sess&id" } }),
    );
    await ackSessionTurn("weird/sess&id");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/api/sessions/${encodeURIComponent("weird/sess&id")}/ack`,
    );
    expect(url).not.toContain("weird/sess&id");
  });
});

describe("HttpError", () => {
  test("preserves status code on 4xx responses", async () => {
    installFetch(
      async () =>
        new Response(JSON.stringify({ error: "conflict" }), {
          status: 409,
          statusText: "Conflict",
          headers: { "Content-Type": "application/json" },
        }),
    );
    let caught: unknown;
    try {
      await request("POST", "/api/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(409);
    expect((caught as HttpError).message).toBe("conflict");
    // `name = "HttpError"` makes the class identifiable in stack traces
    // and Error.toString() output.
    expect((caught as HttpError).name).toBe("HttpError");
  });

  test("preserves status code on 5xx responses", async () => {
    installFetch(
      async () =>
        new Response("not json", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "text/plain" },
        }),
    );
    let caught: unknown;
    try {
      await request("GET", "/api/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(500);
    // Falls back to statusText when the body is not parseable JSON.
    expect((caught as HttpError).message).toBe("Internal Server Error");
  });
});

describe("ackSessionTurn", () => {
  test("posts to /api/sessions/:id/ack and parses {item} envelope on 200", async () => {
    const fetchMock = installFetch(async () =>
      jsonResponse({
        item: { sessionId: "sess-1", turn: "ack-turn", name: "renamed" },
      }),
    );
    const result = await ackSessionTurn("sess-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/sess-1/ack");
    expect(init.method).toBe("POST");
    // Bodyless POST: no Content-Type, no JSON body.
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(result.item.sessionId).toBe("sess-1");
    expect(result.item.turn).toBe("ack-turn");
    expect(result.item.name).toBe("renamed");
  });

  test("rejects with HttpError(409) on conflict (state mismatch)", async () => {
    installFetch(
      async () =>
        new Response(
          JSON.stringify({
            error: "Cannot acknowledge turn in state: agent-turn",
          }),
          {
            status: 409,
            statusText: "Conflict",
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    let caught: unknown;
    try {
      await ackSessionTurn("sess-1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    // Commit 5 silently absorbs 409 as a benign race; pin the contract here.
    expect((caught as HttpError).status).toBe(409);
    expect((caught as HttpError).message).toContain(
      "Cannot acknowledge turn in state",
    );
  });

  test("rejects with HttpError(500) on server error (distinct from 409)", async () => {
    installFetch(
      async () =>
        new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "application/json" },
        }),
    );
    let caught: unknown;
    try {
      await ackSessionTurn("sess-1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    // 500 is intentionally distinct from 409 so callers can branch.
    expect((caught as HttpError).status).toBe(500);
    expect((caught as HttpError).status).not.toBe(409);
  });

  test("passes through item.name when omitted by the backend", async () => {
    // Backend omits `name` when no custom name has been set; the wire
    // contract makes the field optional and the client must accept it
    // without throwing, leaving downstream consumers to treat undefined
    // as "no custom name".
    installFetch(async () =>
      jsonResponse({ item: { sessionId: "sess-2", turn: "ack-turn" } }),
    );
    const result = await ackSessionTurn("sess-2");
    expect(result.item.sessionId).toBe("sess-2");
    expect(result.item.name).toBeUndefined();
  });
});

describe("renameSession", () => {
  test("sends PATCH with {name} body and parses {item} envelope", async () => {
    const fetchMock = installFetch(async () =>
      jsonResponse({ item: { sessionId: "sess-3", name: "new name" } }),
    );
    const result = await renameSession("sess-3", "new name");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/sess-3/name");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ name: "new name" }));
    expect(result.item.name).toBe("new name");
  });

  test("surfaces the sanitized name returned by the backend", async () => {
    // The backend strips control characters (U+0000..U+001F, U+007F)
    // before persisting and echoes the sanitized result back. The client
    // must surface that rather than the user-typed input so the UI shows
    // exactly what is stored. Mirrors the pattern in
    // `src/ui/routes/api_integration_test.ts:655-681`.
    const fetchMock = installFetch(async () =>
      jsonResponse({ item: { sessionId: "sess-4", name: "abcd" } }),
    );
    const result = await renameSession("sess-4", "a\u0000b\u0007c\u007fd");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The wire body still carries the raw user input; the backend does
    // the stripping and replies with the sanitized form.
    expect(init.body).toBe(JSON.stringify({ name: "a\u0000b\u0007c\u007fd" }));
    expect(result.item.name).toBe("abcd");
  });
});

describe("stopContainer", () => {
  test("posts to /api/containers/:name/stop and parses {ok:true} envelope", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ ok: true }));
    const result = await stopContainer("nas-foo");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/containers/nas-foo/stop");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(result).toEqual({ ok: true });
  });

  test("encodes container name containing reserved characters", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ ok: true }));
    await stopContainer("weird/name&id");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/api/containers/${encodeURIComponent("weird/name&id")}/stop`,
    );
    expect(url).not.toContain("weird/name&id");
  });
});

describe("startShell", () => {
  test("posts to /api/containers/:name/shell and parses {dtachSessionId} on 200", async () => {
    const fetchMock = installFetch(async () =>
      jsonResponse({ dtachSessionId: "shell-abc123" }),
    );
    const result = await startShell("nas-foo");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/containers/nas-foo/shell");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(result).toEqual({ dtachSessionId: "shell-abc123" });
  });
});

function parseBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("approveNetwork", () => {
  test("posts to /api/network/approve with sessionId, requestId, and scope when scope is provided", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ ok: true }));
    await approveNetwork("sess-1", "req-1", "host-port");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/network/approve");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    const body = parseBody(init);
    expect(body).toEqual({
      sessionId: "sess-1",
      requestId: "req-1",
      scope: "host-port",
    });
    expect(body).toHaveProperty("scope");
    expect(body.scope).toBe("host-port");
  });

  test("omits scope from the wire body when scope is not provided", async () => {
    // `JSON.stringify` drops `undefined` values, so a missing scope
    // argument must not surface as `"scope": null` or `"scope": ""` on
    // the wire.
    const fetchMock = installFetch(async () => jsonResponse({ ok: true }));
    await approveNetwork("sess-1", "req-1");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = parseBody(init);
    expect(body).toEqual({ sessionId: "sess-1", requestId: "req-1" });
    expect(body).not.toHaveProperty("scope");
  });
});

describe("denyNetwork", () => {
  test("posts to /api/network/deny and forwards scope into the wire body", async () => {
    // The backend `/network/deny` route validates and forwards `scope`
    // (`src/ui/routes/api.ts` lines 184-203 + `src/ui/data.ts`
    // `denyNetwork`). This test pins that the frontend serializes the
    // scope into the request body, not just into the function
    // signature.
    const fetchMock = installFetch(async () => jsonResponse({ ok: true }));
    await denyNetwork("sess-1", "req-1", "host-port");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/network/deny");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    const body = parseBody(init);
    expect(body).toEqual({
      sessionId: "sess-1",
      requestId: "req-1",
      scope: "host-port",
    });
    expect(body).toHaveProperty("scope");
    expect(body.scope).toBe("host-port");
  });

  test("omits scope from the wire body when scope is not provided", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ ok: true }));
    await denyNetwork("sess-1", "req-1");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = parseBody(init);
    expect(body).toEqual({ sessionId: "sess-1", requestId: "req-1" });
    expect(body).not.toHaveProperty("scope");
  });
});

describe("approveHostExec", () => {
  test("posts to /api/hostexec/approve with sessionId, requestId, and scope when scope is provided", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ ok: true }));
    await approveHostExec("sess-1", "exec-1", "capability");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/hostexec/approve");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    const body = parseBody(init);
    expect(body).toEqual({
      sessionId: "sess-1",
      requestId: "exec-1",
      scope: "capability",
    });
    expect(body).toHaveProperty("scope");
    expect(body.scope).toBe("capability");
  });

  test("omits scope from the wire body when scope is not provided", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ ok: true }));
    await approveHostExec("sess-1", "exec-1");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = parseBody(init);
    expect(body).toEqual({ sessionId: "sess-1", requestId: "exec-1" });
    expect(body).not.toHaveProperty("scope");
  });
});

describe("getAuditLogs", () => {
  test("with no parameters, GETs the bare /api/audit path without a query string", async () => {
    // `URLSearchParams.toString()` returns "" for an empty bag, and the
    // function suppresses the `?` suffix in that case so the daemon
    // sees a clean path.
    const fetchMock = installFetch(async () => jsonResponse({ items: [] }));
    await getAuditLogs();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/audit");
    expect(url).not.toContain("?");
    expect(init.method).toBe("GET");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  test("with an empty query object, also GETs the bare /api/audit path", async () => {
    // The default-parameter and explicit-empty-object call sites must
    // produce identical URLs so the call site is free to pass either.
    const fetchMock = installFetch(async () => jsonResponse({ items: [] }));
    await getAuditLogs({});
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/audit");
  });

  test("forwards domain=network as a single query parameter", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ items: [] }));
    await getAuditLogs({ domain: "network" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/audit?domain=network");
  });

  test("forwards domain=hostexec as a single query parameter", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ items: [] }));
    await getAuditLogs({ domain: "hostexec" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/audit?domain=hostexec");
  });

  test("joins sessions with commas and percent-encodes reserved characters", async () => {
    // The backend splits on `,` (`src/ui/routes/api.ts` line 429) so the
    // separator is a literal comma, while individual session ids that
    // contain reserved characters such as `&` must be percent-encoded
    // by `URLSearchParams` so they cannot leak into the query layer.
    const fetchMock = installFetch(async () => jsonResponse({ items: [] }));
    await getAuditLogs({ sessions: ["s1", "s&2"] });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/audit?sessions=s1%2Cs%262");
    // The literal `&` in the second session id must not survive into
    // the URL — that would split the query into two parameters.
    expect(url).not.toContain("s&2");
  });

  test("forwards an explicit empty sessions array as `sessions=`", async () => {
    // The backend interprets an explicit empty `sessions` value as
    // "no session ids match" — return nothing rather than everything
    // (`src/ui/routes/api.ts` lines 425-432). Callers who want every
    // session must omit the field entirely; this test pins that the
    // empty-array path forwards the field unchanged.
    const fetchMock = installFetch(async () => jsonResponse({ items: [] }));
    await getAuditLogs({ sessions: [] });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/audit?sessions=");
  });

  test("percent-encodes sessionContains containing whitespace and reserved characters", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ items: [] }));
    await getAuditLogs({ sessionContains: "foo bar&baz" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    // `URLSearchParams` encodes spaces as `+` and `&` as `%26`. The
    // backend's `searchParams.get` decodes both back to the original
    // input.
    expect(url).toBe("/api/audit?sessionContains=foo+bar%26baz");
    expect(url).not.toContain(" ");
    expect(url).not.toContain("foo bar&baz");
  });

  test("omits sessionContains when the value is an empty string", async () => {
    // An empty substring filter would match every session id, which is
    // indistinguishable from "no filter". The function drops the empty
    // value so the wire request reflects the intent.
    const fetchMock = installFetch(async () => jsonResponse({ items: [] }));
    await getAuditLogs({ sessionContains: "" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/audit");
  });

  test("percent-encodes the before cursor as an ISO-8601 timestamp", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ items: [] }));
    await getAuditLogs({ before: "2026-04-20T10:00:00.000Z" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The colons in the ISO timestamp are reserved sub-delimiters;
    // `URLSearchParams` percent-encodes them so the value round-trips
    // intact through the backend's `searchParams.get`.
    expect(url).toBe("/api/audit?before=2026-04-20T10%3A00%3A00.000Z");
  });

  test("omits before when the value is an empty string", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ items: [] }));
    await getAuditLogs({ before: "" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/audit");
  });

  test("converts a numeric limit to its decimal string representation", async () => {
    const fetchMock = installFetch(async () => jsonResponse({ items: [] }));
    await getAuditLogs({ limit: 200 });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/audit?limit=200");
  });

  test("composes every parameter into a single deterministic query string", async () => {
    // Pin the exact insertion order so future changes that reorder the
    // setters surface as test failures. The order matches the field
    // order in `AuditLogsQuery`: domain, sessions, sessionContains,
    // before, limit.
    const fetchMock = installFetch(async () => jsonResponse({ items: [] }));
    await getAuditLogs({
      domain: "network",
      sessions: ["s1", "s2"],
      sessionContains: "abc",
      before: "2026-04-20T10:00:00.000Z",
      limit: 50,
    });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/audit?domain=network&sessions=s1%2Cs2&sessionContains=abc&before=2026-04-20T10%3A00%3A00.000Z&limit=50",
    );
  });

  test("parses the {items} envelope on a 200 response", async () => {
    installFetch(async () =>
      jsonResponse({
        items: [
          {
            id: "a-1",
            timestamp: "2026-04-20T10:00:00.000Z",
            domain: "network",
            sessionId: "s_1",
            requestId: "r_1",
            decision: "allow",
            reason: "ok",
          },
        ],
      }),
    );
    const result = await getAuditLogs({ domain: "network" });
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.id).toBe("a-1");
    expect(result.items[0]?.domain).toBe("network");
  });

  test("rejects with HttpError on a 400 response from the backend", async () => {
    installFetch(
      async () =>
        new Response(JSON.stringify({ error: "Invalid before" }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json" },
        }),
    );
    let caught: unknown;
    try {
      await getAuditLogs({ before: "not-an-iso" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(400);
    expect((caught as HttpError).message).toBe("Invalid before");
  });
});

describe("getLaunchInfo", () => {
  test("with no argument, GETs the bare /api/launch/info path without a query string", async () => {
    // `cwd === undefined` is the no-cwd branch: the daemon falls back
    // to its default behaviour rather than receiving an empty `cwd=`
    // query parameter that it would have to special-case.
    const fetchMock = installFetch(async () =>
      jsonResponse({
        dtachAvailable: true,
        profiles: ["default"],
        recentDirectories: [],
      }),
    );
    await getLaunchInfo();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/launch/info");
    expect(url).not.toContain("?");
    expect(init.method).toBe("GET");
    // Bodyless GET: no Content-Type, no body — same shape as
    // `getInfo` so the daemon's preflight policy is consistent.
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  test("with cwd === '', GETs the bare /api/launch/info path (empty cwd is equivalent to omission)", async () => {
    // Empty-string cwd must produce the same URL as the no-argument
    // call so the bare path stays the canonical "no cwd" form.
    const fetchMock = installFetch(async () =>
      jsonResponse({
        dtachAvailable: true,
        profiles: ["default"],
        recentDirectories: [],
      }),
    );
    await getLaunchInfo("");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/launch/info");
    expect(url).not.toContain("?");
  });

  test("encodes cwd containing whitespace and non-ASCII characters", async () => {
    const fetchMock = installFetch(async () =>
      jsonResponse({
        dtachAvailable: true,
        profiles: ["default"],
        recentDirectories: [],
      }),
    );
    await getLaunchInfo("/home/user/プロジェクト name");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/api/launch/info?cwd=${encodeURIComponent(
        "/home/user/プロジェクト name",
      )}`,
    );
    // Sanity-check: literal whitespace and Japanese characters are
    // percent-encoded so they cannot be misread as path segments or
    // unparseable query components.
    expect(url).not.toContain(" ");
    expect(url).not.toContain("プロジェクト");
  });

  test("encodes reserved query characters (?, &, #) in cwd to prevent URL injection", async () => {
    // Reserved characters in the raw cwd would otherwise split or
    // truncate the query string at the wire layer. Pin that
    // `encodeURIComponent` percent-encodes them all so the backend's
    // `searchParams.get("cwd")` round-trips the original value
    // intact.
    const fetchMock = installFetch(async () =>
      jsonResponse({
        dtachAvailable: true,
        profiles: ["default"],
        recentDirectories: [],
      }),
    );
    const raw = "/path/with?question&amp/hash#";
    await getLaunchInfo(raw);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/launch/info?cwd=${encodeURIComponent(raw)}`);
    // The unsafe `?`, `&`, and `#` in the raw cwd must not appear
    // literally past the fixed `?cwd=` prefix — otherwise the backend
    // would see additional query parameters or a truncated value.
    const tail = url.slice("/api/launch/info?cwd=".length);
    expect(tail).not.toContain("?");
    expect(tail).not.toContain("&");
    expect(tail).not.toContain("#");
  });
});

describe("getInfo", () => {
  test("GETs /api/info and returns the parsed {home} envelope", async () => {
    const fetchMock = installFetch(async () =>
      jsonResponse({ home: "/home/foo" }),
    );
    const result = await getInfo();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/info");
    expect(init.method).toBe("GET");
    // Bodyless GET: no Content-Type, no body — same shape as
    // `getLaunchInfo` so the daemon's preflight policy is consistent.
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(result).toEqual({ home: "/home/foo" });
  });

  test("passes through home: null when the daemon cannot resolve HOME", async () => {
    // The backend returns `{ home: null }` when `HOME` is unset; the
    // client must surface that as-is so the UI can degrade gracefully
    // (i.e. leave paths in their absolute form).
    installFetch(async () => jsonResponse({ home: null }));
    const result = await getInfo();
    expect(result).toEqual({ home: null });
  });

  test("rejects with HttpError on a 5xx response from the backend", async () => {
    // `App.tsx`'s `onMount` relies on `.catch` to log the failure and
    // leave `homeDir` at `null` so the UI degrades to absolute paths.
    // Pin the rejection contract here so a refactor that silently
    // resolves to `{ home: null }` on `!ok` does not slip through.
    installFetch(
      async () =>
        new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "application/json" },
        }),
    );
    let caught: unknown;
    try {
      await getInfo();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(500);
    expect((caught as HttpError).message).toBe("boom");
  });
});

describe("denyHostExec", () => {
  test("posts to /api/hostexec/deny without scope in the wire body", async () => {
    // The backend `/hostexec/deny` route does **not** destructure
    // `scope` from the request body (`src/ui/routes/api.ts` lines
    // 237-253) and the daemon-side `denyHostExec` takes no scope
    // (`src/ui/data.ts`). This test is the canonical pin separating
    // the two Deny paths: network forwards scope, hostexec does not.
    const fetchMock = installFetch(async () => jsonResponse({ ok: true }));
    await denyHostExec("sess-1", "exec-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/hostexec/deny");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    const body = parseBody(init);
    expect(body).toEqual({ sessionId: "sess-1", requestId: "exec-1" });
    expect(body).not.toHaveProperty("scope");
  });
});
