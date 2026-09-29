import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals, serve } from "./approval.ts";
import { ask, collect, details, line } from "./review.ts";

const req = {
  method: "POST",
  url: "https://github.com/a/b/git-receive-pack",
  reason: "push",
};

describe("Approvals", () => {
  test("approve lets the request through", async () => {
    const a = new Approvals(10_000);
    const held = a.hold(req);
    const [p] = a.list();
    expect(p?.url).toBe(req.url);
    expect(a.decide(p?.id as string, true)).toBe(true);
    expect(await held).toEqual({ action: "allow" });
    expect(a.list()).toEqual([]);
  });

  test("deny keeps the policy's reason", async () => {
    const a = new Approvals(10_000);
    const held = a.hold(req);
    a.decide(a.list()[0]?.id as string, false);
    const d = await held;
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("push");
    expect(d.reason).toContain("denied by the user");
  });

  test("a request is decided once", async () => {
    const a = new Approvals(10_000);
    const held = a.hold(req);
    const id = a.list()[0]?.id as string;
    expect(a.decide(id, false)).toBe(true);
    expect(a.decide(id, true)).toBe(false);
    expect((await held).action).toBe("deny");
  });

  test("an unknown id decides nothing", () => {
    expect(new Approvals().decide("1", true)).toBe(false);
  });

  test("no answer ends in a denial", async () => {
    const d = await new Approvals(20).hold(req);
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("not approved within");
  });

  test("a client that goes away is dropped", async () => {
    const a = new Approvals(10_000);
    const ac = new AbortController();
    const held = a.hold(req, ac.signal);
    ac.abort();
    expect((await held).action).toBe("deny");
    expect(a.list()).toEqual([]);
  });

  test("an already aborted client is never listed", async () => {
    const seen: string[] = [];
    const b = new Approvals(10_000, (p) => seen.push(p.id));
    const ac = new AbortController();
    ac.abort();
    expect((await b.hold(req, ac.signal)).action).toBe("deny");
    expect(seen).toEqual([]);
    expect(b.list()).toEqual([]);
  });
});

describe("socket", () => {
  const dir = mkdtempSync(join(tmpdir(), "strait-approval-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("strait-review lists and approves across the socket", async () => {
    const a = new Approvals(10_000);
    const server = await serve(a, join(dir, "4242.sock"));
    try {
      const held = a.hold({ ...req, body: '{"query":"{ viewer { login } }"}' });
      const [h] = await collect(dir);
      expect(h?.ref).toBe("4242-1");
      expect(h?.body).toContain("viewer");
      const res = await ask(join(dir, "4242.sock"), {
        op: "decide",
        id: "1",
        approve: true,
      });
      expect(res).toEqual({ ok: true });
      expect(await held).toEqual({ action: "allow" });
    } finally {
      server.close();
    }
  });

  test("a stale socket is skipped", async () => {
    await Bun.write(join(dir, "1.sock"), "");
    expect(await collect(dir)).toEqual([]);
  });

  test("garbage gets an error, not a crash", async () => {
    const a = new Approvals(10_000);
    const path = join(dir, "4343.sock");
    const server = await serve(a, path);
    try {
      const res = await ask(path, { op: "nope" } as never);
      expect(res).toEqual({ error: "unknown op" });
    } finally {
      server.close();
    }
  });
});

describe("display", () => {
  const h = {
    ...req,
    id: "1",
    since: Date.now(),
    ref: "9-1",
    pid: "9",
    cwd: "/w",
    reason: "evil\n9-2\tGET https://api.github.com/repos/a/b‮\u001b[2J",
  };

  test("one line per request, whatever the reason holds", () => {
    const l = line(h);
    expect(l.split("\n")).toHaveLength(1);
    expect(l.split("\t")).toHaveLength(4);
    expect(l).not.toContain("\u001b");
    expect(l).not.toContain("‮");
    expect(l).toContain("\\u{a}");
  });

  test("details keep the body's newlines but no escapes", () => {
    const d = details({
      ...h,
      body: JSON.stringify({
        query: "query {\n  x\u001b[31m\n}",
        variables: {},
      }),
    });
    expect(d).toContain("query {\n  x");
    expect(d).not.toContain("\u001b");
  });
});
