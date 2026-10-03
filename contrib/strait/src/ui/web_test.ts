import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals, type Pending, serve } from "../core/approval.ts";
import type { SessionInfo } from "../core/session.ts";
import { collect, decideRef, type Held } from "./review.ts";
import {
  inboxRecord,
  type ReviewBackend,
  startWebReview,
  webHandler,
} from "./web.ts";

const token = "a".repeat(64);
const authority = "127.0.0.1:34567";
const origin = `http://${authority}`;
const ref = "k3f9-1.x7mq4ndp";
const session = (id: string): SessionInfo => ({
  id,
  cwd: "/w",
  command: ["claude"],
  startedAt: 0,
});
const request = {
  method: "POST",
  url: "https://api.github.com/repos/a/b/issues",
  reason: "REST write",
};
const assets = { html: "<h1>Review</h1>", css: "body{}", js: "// browser" };
const dir = mkdtempSync(join(tmpdir(), "strait-web-test-"));
afterAll(() => rmSync(dir, { force: true, recursive: true }));

function api(
  path = "/api/pending",
  body: unknown = {},
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      host: authority,
      origin,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
function fixture() {
  const calls: unknown[] = [];
  const backend: ReviewBackend = {
    list: async () => {
      calls.push("list");
      return [];
    },
    decide: async (target, approve) => {
      calls.push({ ref: target, approve });
      return true;
    },
  };
  return {
    calls,
    handle: webHandler({ authority: () => authority, token, backend, assets }),
  };
}

describe("Web HTTP boundary", () => {
  test("only exact Host and URL authority serve static assets", async () => {
    const { handle, calls } = fixture();
    for (const host of [
      "localhost:34567",
      "127.0.0.1",
      "evil.example:34567",
      `${authority}, evil.example`,
    ]) {
      expect(
        (await handle(new Request(origin, { headers: { host } }))).status,
      ).toBe(403);
    }
    expect(
      (
        await handle(
          new Request("http://evil.example/", { headers: { host: authority } }),
        )
      ).status,
    ).toBe(403);
    const res = await handle(
      new Request(origin, { headers: { host: authority } }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(token);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(res.headers.get("content-security-policy")).not.toContain(
      "unsafe-inline",
    );
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("absent, wrong and malformed capability cannot even list", async () => {
    const { handle, calls } = fixture();
    for (const value of [
      "",
      `Bearer ${"b".repeat(64)}`,
      token,
      `Bearer ${token}, Bearer ${token}`,
    ]) {
      expect(
        (await handle(api(undefined, {}, { authorization: value }))).status,
      ).toBe(403);
    }
    const req = api();
    req.headers.delete("authorization");
    expect((await handle(req)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("all API calls require exact Origin and same-origin fetch metadata", async () => {
    const { handle, calls } = fixture();
    for (const value of [
      "null",
      "http://evil.example",
      "http://localhost:34567",
      `${origin}, ${origin}`,
      "",
    ]) {
      expect((await handle(api(undefined, {}, { origin: value }))).status).toBe(
        403,
      );
    }
    const noOrigin = api();
    noOrigin.headers.delete("origin");
    expect((await handle(noOrigin)).status).toBe(403);
    expect(
      (await handle(api(undefined, {}, { "sec-fetch-site": "cross-site" })))
        .status,
    ).toBe(403);
    expect(
      (await handle(api(undefined, {}, { "sec-fetch-site": "same-site" })))
        .status,
    ).toBe(403);
    expect(calls).toEqual([]);
    expect(
      (await handle(api(undefined, {}, { "sec-fetch-site": "same-origin" })))
        .status,
    ).toBe(200);
  });

  test("GET, forms, preflight, query tokens and arbitrary commands are not APIs", async () => {
    const { handle, calls } = fixture();
    for (const method of ["GET", "OPTIONS", "PUT", "DELETE"]) {
      expect(
        (
          await handle(
            new Request(`${origin}/api/pending`, {
              method,
              headers: { host: authority, origin },
            }),
          )
        ).status,
      ).not.toBe(200);
    }
    expect(
      (await handle(api(undefined, {}, { "content-type": "text/plain" })))
        .status,
    ).toBe(400);
    expect((await handle(api(`/api/pending?token=${token}`))).status).toBe(403);
    expect((await handle(api("/api/command", { command: "id" }))).status).toBe(
      404,
    );
    expect((await handle(api(undefined, { op: "list" }))).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("decision schema is exact and never coerces approve", async () => {
    const { handle, calls } = fixture();
    for (const body of [
      null,
      [],
      {},
      { ref },
      { ref, approve: "false" },
      { ref, approve: 1 },
      { ref, approve: true, op: "exec" },
      { ref: "../k3f9-1.x7mq4ndp", approve: true },
      { ref: "k3f9-1", approve: true },
      { ref: "k3f9", approve: true },
    ]) {
      expect((await handle(api("/api/decision", body))).status).toBe(400);
    }
    expect(calls).toEqual([]);
    const res = await handle(api("/api/decision", { ref, approve: false }));
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ ref, approve: false }]);
  });

  test("invalid UTF-8, malformed JSON and bounded streaming bodies fail closed", async () => {
    const { handle, calls } = fixture();
    for (const body of [new Uint8Array([0xff]), "{", " ".repeat(4097)]) {
      const req = new Request(`${origin}/api/pending`, {
        method: "POST",
        headers: api().headers,
        body,
      });
      expect((await handle(req)).status).toBe(400);
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4097));
        controller.close();
      },
    });
    const req = new Request(`${origin}/api/pending`, {
      method: "POST",
      headers: api().headers,
      body: stream,
    });
    expect((await handle(req)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("backend failures do not reflect secrets or capability", async () => {
    const handle = webHandler({
      authority: () => authority,
      token,
      assets,
      backend: {
        list: async () => {
          throw new Error(token);
        },
        decide: async () => false,
      },
    });
    const res = await handle(api());
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(token);
  });
});

describe("inbox records", () => {
  const held = (over: Partial<Held> = {}): Held => ({
    id: "1.x7mq4ndp",
    ref,
    session: { ...session("k3f9"), tty: "/dev/pts/3" },
    ...request,
    since: 1000,
    expiresAt: 241_000,
    ...over,
  });

  test("only the named fields cross, exec included", () => {
    const exec = { argv: ["nix", "build"], cwd: "/w", env: { A: "1" } };
    const r = inboxRecord({
      ...held({ exec, body: "ignored for exec" }),
      secret: "x",
    } as Held);
    expect(r).toEqual({
      ref,
      session: "k3f9",
      cwd: "/w",
      command: ["claude"],
      ...request,
      exec,
      since: 1000,
      expiresAt: 241_000,
    });
    expect(JSON.stringify(r)).not.toContain("pts");
  });

  test("a malformed exec drops the request rather than hiding the command", () => {
    for (const exec of [
      null,
      "ls",
      { argv: [], cwd: "/w", env: {} },
      { argv: ["ls"], cwd: 1, env: {} },
      { argv: ["ls"], cwd: "/w", env: { A: 1 } },
      { argv: ["ls"], cwd: "/w", env: [] },
    ]) {
      expect(inboxRecord(held({ exec: exec as never }))).toBeNull();
    }
  });

  test("a ref the browser would refuse is left out, not sent", () => {
    for (const over of [
      { ref: "k3f9-1" },
      { ref: "other-1.x7mq4ndp" },
      { expiresAt: 1000 },
    ]) {
      expect(inboxRecord(held(over))).toBeNull();
    }
  });

  test("a strait from before expiresAt still gets a deadline", () => {
    const h = held();
    delete (h as { expiresAt?: number }).expiresAt;
    expect(inboxRecord(h)?.expiresAt).toBe(1000 + 240_000);
  });
});

// srt blocks AF_UNIX inside a strait sandbox, so these cannot run there.
async function canListenOnUnixSockets(): Promise<boolean> {
  return await new Promise<boolean>((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen(join(dir, "probe.sock"), () => s.close(() => done(true)));
  });
}
const unixSockets = await canListenOnUnixSockets();

describe.skipIf(!unixSockets)("real socket + HTTP allow-once decisions", () => {
  const backend = (): ReviewBackend => ({
    list: async () =>
      (await collect(dir, { all: true }))
        .map(inboxRecord)
        .filter((r) => r !== null),
    decide: (target, approve) => decideRef(dir, target, approve),
  });

  test("competing decisions settle once; a cancelled or restarted session's ref fails", async () => {
    const path = join(dir, "web1.sock");
    const approvals = new Approvals(session("web1"), 10_000);
    const socket = await serve(approvals, path);
    const handle = webHandler({
      authority: () => authority,
      token,
      assets,
      backend: backend(),
    });
    try {
      const held = approvals.hold(request);
      const list = (await (await handle(api())).json()) as {
        pending: Array<{ ref: string }>;
        inheritedEnv: string[];
      };
      expect(list.inheritedEnv).toEqual(["PATH", "HOME"]);
      const target = list.pending[0]?.ref as string;
      expect(target).toBe(`web1-${(approvals.list()[0] as Pending).id}`);
      const responses = await Promise.all(
        [true, false].map((approve) =>
          handle(api("/api/decision", { ref: target, approve })),
        ),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(["allow", "deny"]).toContain((await held).action);

      const ac = new AbortController();
      const cancelled = approvals.hold(request, ac.signal);
      const p = approvals.list()[0] as Pending;
      ac.abort();
      expect(
        (
          await handle(
            api("/api/decision", { ref: `web1-${p.id}`, approve: true }),
          )
        ).status,
      ).toBe(409);
      expect((await cancelled).action).toBe("deny");

      await new Promise<void>((r) => socket.close(() => r()));
      const replacement = new Approvals(session("web1"), 10_000);
      const next = await serve(replacement, path);
      const nextHeld = replacement.hold(request);
      try {
        expect(
          (await handle(api("/api/decision", { ref: target, approve: true })))
            .status,
        ).toBe(409);
        expect(replacement.list()).toHaveLength(1);
        replacement.close();
        expect((await nextHeld).action).toBe("deny");
      } finally {
        next.close();
      }
    } finally {
      socket.close();
    }
  });

  test("expiry is decided by strait, not by the browser", async () => {
    let now = Date.now();
    const approvals = new Approvals(session("web2"), 1000, undefined, {
      now: () => now,
      monotonicNow: () => now,
    });
    const socket = await serve(approvals, join(dir, "web2.sock"));
    try {
      const held = approvals.hold(request);
      const p = approvals.list()[0] as Pending;
      now += 1001;
      expect(await decideRef(dir, `web2-${p.id}`, true)).toBe(false);
      expect((await held).action).toBe("deny");
    } finally {
      socket.close();
    }
  });

  test("HTTP cannot hold a request or reach the socket protocol", async () => {
    const approvals = new Approvals(session("web3"), 10_000);
    const socket = await serve(approvals, join(dir, "web3.sock"));
    const handle = webHandler({
      authority: () => authority,
      token,
      assets,
      backend: backend(),
    });
    try {
      expect((await handle(api("/api/hold", request))).status).toBe(404);
      expect(
        (await handle(api("/api/decision", { op: "list", approve: true })))
          .status,
      ).toBe(400);
      expect(
        (
          await handle(
            api("/api/decision", { ref: "web3-1.x7mq4ndp", approve: true }),
          )
        ).status,
      ).toBe(409);
      expect(approvals.list()).toEqual([]);
    } finally {
      socket.close();
    }
  });

  test("actual server binds only loopback and serves no capability endpoint", async () => {
    const running = startWebReview(dir);
    try {
      const url = new URL(running.url);
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.hash).toMatch(/^#[0-9a-f]{64}$/);
      const page = await fetch(url.origin);
      expect(page.status).toBe(200);
      expect(await page.text()).not.toContain(url.hash.slice(1));
      expect(
        (
          await fetch(`${url.origin}/api/pending`, {
            method: "POST",
            body: "{}",
          })
        ).status,
      ).toBe(403);
      const list = await fetch(`${url.origin}/api/pending`, {
        method: "POST",
        headers: {
          origin: url.origin,
          authorization: `Bearer ${url.hash.slice(1)}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(list.status).toBe(200);
    } finally {
      running.server.stop(true);
    }
  });
});
