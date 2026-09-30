import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals, serve } from "./approval.ts";
import {
  ask,
  collect,
  details,
  type Held,
  line,
  parseRef,
  structured,
  tuiArgs,
} from "./review.ts";
import { claimSocket, type SessionInfo } from "./session.ts";

const req = {
  method: "POST",
  url: "https://github.com/a/b/git-receive-pack",
  reason: "push",
};

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "k3f9",
  cwd: "/w",
  command: ["claude"],
  startedAt: Date.now(),
  ...over,
});

// srt blocks AF_UNIX inside a strait sandbox, so these cannot run there.
async function canListenOnUnixSockets(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "strait-unix-probe-"));
  try {
    return await new Promise<boolean>((done) => {
      const s = createServer();
      s.once("error", () => done(false));
      s.listen(join(dir, "p.sock"), () => s.close(() => done(true)));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const unixSockets = await canListenOnUnixSockets();

describe("Approvals", () => {
  test("approve lets the request through", async () => {
    const a = new Approvals(session(), 10_000);
    const held = a.hold(req);
    const [p] = a.list();
    expect(p?.url).toBe(req.url);
    expect(a.decide(p?.id as string, true)).toBe(true);
    expect(await held).toEqual({ action: "allow" });
    expect(a.list()).toEqual([]);
  });

  test("deny keeps the policy's reason", async () => {
    const a = new Approvals(session(), 10_000);
    const held = a.hold(req);
    a.decide(a.list()[0]?.id as string, false);
    const d = await held;
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("push");
    expect(d.reason).toContain("denied by the user");
  });

  test("a request is decided once", async () => {
    const a = new Approvals(session(), 10_000);
    const held = a.hold(req);
    const id = a.list()[0]?.id as string;
    expect(a.decide(id, false)).toBe(true);
    expect(a.decide(id, true)).toBe(false);
    expect((await held).action).toBe("deny");
  });

  test("an unknown id decides nothing", () => {
    expect(new Approvals(session()).decide("1", true)).toBe(false);
  });

  test("no answer ends in a denial", async () => {
    const d = await new Approvals(session(), 20).hold(req);
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("not approved within");
  });

  test("a client that goes away is dropped", async () => {
    const a = new Approvals(session(), 10_000);
    const ac = new AbortController();
    const held = a.hold(req, ac.signal);
    ac.abort();
    expect((await held).action).toBe("deny");
    expect(a.list()).toEqual([]);
  });

  test("an already aborted client is never listed", async () => {
    const seen: string[] = [];
    const b = new Approvals(session(), 10_000, (p) => seen.push(p.id));
    const ac = new AbortController();
    ac.abort();
    expect((await b.hold(req, ac.signal)).action).toBe("deny");
    expect(seen).toEqual([]);
    expect(b.list()).toEqual([]);
  });

  test("the list names the session", () => {
    const s = session({ tty: "/dev/pts/3" });
    expect(new Approvals(s).handle({ op: "list" })).toEqual({
      pending: [],
      session: s,
    });
  });
});

describe("socket", () => {
  const dir = mkdtempSync(join(tmpdir(), "strait-approval-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test.skipIf(!unixSockets)(
    "strait review lists and approves across the socket",
    async () => {
      const a = new Approvals(session({ id: "s1" }), 10_000);
      const server = await serve(a, join(dir, "s1.sock"));
      try {
        const held = a.hold({
          ...req,
          body: '{"query":"{ viewer { login } }"}',
        });
        const [h] = await collect(dir, { session: "s1" });
        expect(h?.ref).toBe("s1-1");
        expect(h?.body).toContain("viewer");
        const res = await ask(join(dir, "s1.sock"), {
          op: "decide",
          id: "1",
          approve: true,
        });
        expect(res).toEqual({ ok: true });
        expect(await held).toEqual({ action: "allow" });
      } finally {
        server.close();
      }
    },
  );

  test.skipIf(!unixSockets)(
    "without a session, only sessions started here are listed",
    async () => {
      const here = new Approvals(session({ id: "here", cwd: "/w" }), 10_000);
      const there = new Approvals(session({ id: "there", cwd: "/x" }), 10_000);
      const s1 = await serve(here, join(dir, "here.sock"));
      const s2 = await serve(there, join(dir, "there.sock"));
      try {
        here.hold(req);
        there.hold(req);
        const refs = async (scope: Parameters<typeof collect>[1]) =>
          (await collect(dir, scope)).map((h) => h.ref).sort();
        expect(await refs({ cwd: "/w" })).toEqual(["here-1"]);
        expect(await refs({ session: "there" })).toEqual(["there-1"]);
        expect(await refs({ all: true })).toEqual(["here-1", "there-1"]);
      } finally {
        for (const p of here.list()) here.decide(p.id, false);
        for (const p of there.list()) there.decide(p.id, false);
        s1.close();
        s2.close();
      }
    },
  );

  test.skipIf(!unixSockets)("a stale socket is skipped", async () => {
    await Bun.write(join(dir, "stale.sock"), "");
    expect(await collect(dir, { session: "stale" })).toEqual([]);
  });

  test.skipIf(!unixSockets)("garbage gets an error, not a crash", async () => {
    const path = join(dir, "g.sock");
    const server = await serve(new Approvals(session()), path);
    try {
      expect(await ask(path, { op: "nope" } as never)).toEqual({
        error: "unknown op",
      });
    } finally {
      server.close();
    }
  });

  test.skipIf(!unixSockets)(
    "a running session's name cannot be taken; a dead one's can",
    async () => {
      const server = await serve(
        new Approvals(session()),
        join(dir, "live.sock"),
      );
      try {
        await expect(claimSocket(dir, "live")).rejects.toThrow(
          "already running",
        );
      } finally {
        server.close();
      }
      await Bun.write(join(dir, "dead.sock"), "");
      expect(await claimSocket(dir, "dead")).toBe(join(dir, "dead.sock"));
    },
  );
});

describe("refs", () => {
  test("split at the last dash", () => {
    expect(parseRef("my-name-12")).toEqual({ session: "my-name", id: "12" });
    expect(parseRef("k3f9-1")).toEqual({ session: "k3f9", id: "1" });
  });
  test("reject what is not a ref", () => {
    for (const r of ["k3f9", "-1", "k3f9-", "k3f9-x", "a/b-1", ""]) {
      expect(parseRef(r)).toBeNull();
    }
  });
});

describe("display", () => {
  const h: Held = {
    ...req,
    id: "1",
    since: Date.now(),
    ref: "k3f9-1",
    session: session({ tty: "/dev/pts/3", tmuxPane: "%12" }),
    reason: "evil\n9-2\tGET https://api.github.com/repos/a/b‮\u001b[2J",
  };

  test("one line per request, whatever the reason holds", () => {
    const l = line(h);
    expect(l.split("\n")).toHaveLength(1);
    expect(l.split("\t")).toHaveLength(5);
    expect(l).not.toContain("\u001b");
    expect(l).not.toContain("‮");
    expect(l).toContain("\\u{a}");
  });

  test("the line starts with the ref, then the session", () => {
    const [ref, sessionField, , , where] = line(h).split("\t");
    expect(ref).toBe("k3f9-1");
    expect(sessionField).toBe("[k3f9]");
    expect(where).toContain("tmux %12 pts/3");
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
    expect(d).toContain("session: k3f9, 'claude'");
  });

  test("--json carries the session and the request", () => {
    expect(structured(h)).toMatchObject({
      ref: "k3f9-1",
      session: { id: "k3f9", cwd: "/w" },
      method: "POST",
    });
  });
});

describe("resident review", () => {
  test("approve and deny reload instead of quitting", () => {
    const args = tuiArgs("/s/strait", { cwd: "/w" }, 5000);
    const enter = args.find((a) => a.startsWith("--bind=enter:"));
    expect(enter).toBe(
      "--bind=enter:execute-silent('/s/strait' review approve {+1})+clear-selection+reload('/s/strait' review list)",
    );
    expect(
      args.some((a) => a.startsWith("--bind=ctrl-d:execute-silent(")),
    ).toBe(true);
    expect(args).toContain("--listen=127.0.0.1:5000");
    expect(args).not.toContain("--expect=enter,ctrl-d");
  });
  test("the scope carries over to every reload", () => {
    const args = tuiArgs("/s/strait", { session: "k3f9" }, 5000);
    expect(args.find((a) => a.startsWith("--bind=start:"))).toBe(
      "--bind=start:reload('/s/strait' review list 'k3f9')",
    );
  });
});
