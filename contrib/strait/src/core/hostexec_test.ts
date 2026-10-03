import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The patched srt module strait runs with, not a copy.
import { decideAndRespond } from "../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/request-filter.js";
import { parseClientArgs } from "../ui/hostexec_client.ts";
import { line } from "../ui/review.ts";
import {
  type ExecRequest,
  execEnv,
  mask,
  parseExecRequest,
  runOnHost,
} from "./hostexec.ts";
import { decide } from "./policy.ts";

const ok: ExecRequest = { argv: ["echo", "hi"], cwd: "/", env: {} };

describe("parseExecRequest", () => {
  test("a full request", () => {
    expect(
      parseExecRequest(
        JSON.stringify({ argv: ["nix", "build"], cwd: "/w", env: { A: "1" } }),
      ),
    ).toEqual({ argv: ["nix", "build"], cwd: "/w", env: { A: "1" } });
  });
  const bad: [string, unknown][] = [
    ["no argv", { cwd: "/", env: {} }],
    ["empty argv", { argv: [], cwd: "/", env: {} }],
    ["empty command", { argv: [""], cwd: "/", env: {} }],
    ["non-string arg", { argv: ["a", 1], cwd: "/", env: {} }],
    ["NUL in an arg", { argv: ["a", "b\u0000c"], cwd: "/", env: {} }],
    ["relative cwd", { argv: ["a"], cwd: "w", env: {} }],
    ["no env", { argv: ["a"], cwd: "/" }],
    ["bad env name", { argv: ["a"], cwd: "/", env: { "A=B": "1" } }],
    ["non-string env", { argv: ["a"], cwd: "/", env: { A: 1 } }],
    ["extra member", { argv: ["a"], cwd: "/", env: {}, stdin: "x" }],
    ["array", [["a"]]],
  ];
  for (const [name, body] of bad) {
    test(name, () => {
      expect(typeof parseExecRequest(JSON.stringify(body))).toBe("string");
    });
  }
});

describe("execEnv", () => {
  test("only PATH and HOME from the host, then the declared ones", () => {
    const env = execEnv(
      { ...ok, env: { NIX_CONFIG: "x", HOME: "/other" } },
      { PATH: "/bin", HOME: "/home/u", GH_TOKEN: "real" },
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/other", NIX_CONFIG: "x" });
  });
});

describe("runOnHost", () => {
  test("output and exit code", async () => {
    const r = await runOnHost(
      {
        argv: ["sh", "-c", "echo out; echo err >&2; exit 3"],
        cwd: "/",
        env: {},
      },
      [],
    );
    expect(r.exitCode).toBe(3);
    expect(Buffer.from(r.stdout, "base64").toString()).toBe("out\n");
    expect(Buffer.from(r.stderr, "base64").toString()).toBe("err\n");
  });

  test("runs in the declared directory with the declared variables", async () => {
    const r = await runOnHost(
      { argv: ["sh", "-c", 'pwd; echo "$A"'], cwd: "/tmp", env: { A: "b" } },
      [],
    );
    expect(Buffer.from(r.stdout, "base64").toString()).toBe("/tmp\nb\n");
  });

  test("strait's own environment does not leak", async () => {
    process.env.STRAIT_TEST_SECRET = "leak";
    try {
      const r = await runOnHost(
        {
          argv: ["sh", "-c", 'echo "[$STRAIT_TEST_SECRET]"'],
          cwd: "/",
          env: {},
        },
        [],
      );
      expect(Buffer.from(r.stdout, "base64").toString()).toBe("[]\n");
    } finally {
      delete process.env.STRAIT_TEST_SECRET;
    }
  });

  test("real credentials are masked in the output", async () => {
    const r = await runOnHost(
      { argv: ["sh", "-c", "echo token=ghp_realvalue1234"], cwd: "/", env: {} },
      ["ghp_realvalue1234"],
    );
    expect(Buffer.from(r.stdout, "base64").toString()).toBe(
      "token=[masked by strait]\n",
    );
  });

  test("a missing command is 127", async () => {
    const r = await runOnHost(
      { argv: ["strait-no-such-command"], cwd: "/", env: {} },
      [],
    );
    expect(r.exitCode).toBe(127);
    expect(Buffer.from(r.stderr, "base64").toString()).toContain(
      "strait-no-such-command",
    );
  });

  test("the command is killed when the client goes away", async () => {
    const ac = new AbortController();
    const run = runOnHost(
      { argv: ["sleep", "30"], cwd: "/", env: {} },
      [],
      ac.signal,
    );
    setTimeout(() => ac.abort(), 50);
    expect((await run).signal).toBe("SIGTERM");
  });

  test("an already aborted client runs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strait-hostexec-test-"));
    try {
      const ac = new AbortController();
      ac.abort();
      const r = await runOnHost(
        { argv: ["touch", join(dir, "ran")], cwd: "/", env: {} },
        [],
        ac.signal,
      );
      expect(r.exitCode).toBeNull();
      expect(existsSync(join(dir, "ran"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // What the shell starts, including a child that ignores SIGTERM and one
  // left behind when the shell itself has already exited, holding the
  // output pipe open.
  describe.skipIf(!procfs)("the whole process tree stops", () => {
    const stubborn = `sh -c 'trap "" TERM; echo $$ >"$D/stubborn.pid"; exec sleep 300' &`;
    const cases: [string, string][] = [
      [
        "while the shell runs",
        `${stubborn} sleep 300 & echo $! >"$D/plain.pid"
         until [ -s "$D/stubborn.pid" ]; do sleep 0.01; done
         echo $$ >"$D/leader.pid"; : >"$D/ready"; wait`,
      ],
      [
        "after the shell has exited",
        `${stubborn}
         until [ -s "$D/stubborn.pid" ]; do sleep 0.01; done
         echo $$ >"$D/leader.pid"; : >"$D/ready"`,
      ],
    ];
    for (const [name, script] of cases) {
      test(name, async () => {
        const dir = mkdtempSync(join(tmpdir(), "strait-hostexec-test-"));
        const ac = new AbortController();
        const pids = () =>
          ["leader", "stubborn", "plain"].flatMap((n) => {
            const f = join(dir, `${n}.pid`);
            return existsSync(f) ? [Number(readFileSync(f, "utf8"))] : [];
          });
        try {
          const run = runOnHost(
            { argv: ["sh", "-c", script], cwd: "/", env: { D: dir } },
            [],
            ac.signal,
            200,
          );
          await waitFor(() => existsSync(join(dir, "ready")));
          const leader = Number(readFileSync(join(dir, "leader.pid"), "utf8"));
          if (name.startsWith("after")) await waitFor(() => !alive(leader));
          expect(pids().filter(alive).length).toBeGreaterThan(0);
          ac.abort();
          await within(run);
          expect(pids().filter(alive)).toEqual([]);
        } finally {
          ac.abort();
          for (const pid of pids()) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
          rmSync(dir, { recursive: true, force: true });
        }
        // Above every wait in the test, so a failure still reaches finally.
      }, 20_000);
    }

    // strait exiting does not wait for a stop's SIGKILL, so its own exit
    // has to take the groups down.
    for (const how of ["exit", "abort then exit"]) {
      test(`when strait itself exits (${how})`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "strait-hostexec-test-"));
        const pids = () =>
          ["leader", "stubborn", "plain"].flatMap((n) => {
            const f = join(dir, `${n}.pid`);
            return existsSync(f) ? [Number(readFileSync(f, "utf8"))] : [];
          });
        const main = join(dir, "main.ts");
        writeFileSync(
          main,
          `import { existsSync } from "node:fs";
           import { runOnHost } from ${JSON.stringify(join(import.meta.dir, "hostexec.ts"))};
           const ac = new AbortController();
           void runOnHost(${JSON.stringify({
             argv: ["sh", "-c", cases[0]?.[1]],
             cwd: "/",
             env: { D: dir },
           })}, [], ac.signal);
           while (!existsSync(${JSON.stringify(join(dir, "ready"))})) await Bun.sleep(10);
           if (${JSON.stringify(how)} !== "exit") ac.abort();
           process.exit(0);`,
        );
        const strait = Bun.spawn([process.execPath, main], {
          stdio: ["ignore", "inherit", "inherit"],
        });
        try {
          await within(strait.exited);
          expect(pids().length).toBe(3);
          await waitFor(() => pids().filter(alive).length === 0, 2000).catch(
            () => {},
          );
          expect(pids().filter(alive)).toEqual([]);
        } finally {
          strait.kill("SIGKILL");
          for (const pid of pids()) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
          rmSync(dir, { recursive: true, force: true });
        }
      }, 20_000);
    }
  });
});

const procfs = existsSync("/proc/self/stat");

/** A zombie counts as gone: nothing reaps orphans in some containers. */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

function within<T>(p: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error("did not settle")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe("mask", () => {
  test("leaves bytes that are not UTF-8 alone", () => {
    const b = Buffer.from([0xff, 0x00, 0x80]);
    expect(mask(b, ["abcdefgh"])).toEqual(b);
  });
  test("ignores values too short to be credentials", () => {
    expect(mask(Buffer.from("a b"), ["a"]).toString()).toBe("a b");
  });
});

describe("policy", () => {
  const url = "https://hostexec.strait.invalid/run";
  const run = (
    over: {
      method?: string;
      url?: string;
      body?: string;
      headers?: Record<string, string>;
    },
    hostExec = true,
  ) =>
    decide(
      {
        method: over.method ?? "POST",
        url: over.url ?? url,
        headers: new Headers(over.headers ?? {}),
        body: over.body ?? JSON.stringify(ok),
      },
      { githubRepos: [], hostExec },
      {},
    );

  test("a valid run goes to review with the command", () => {
    expect(run({})).toEqual({
      action: "review",
      reason: "run a command on the host",
      exec: ok,
    });
  });
  test("off unless configured", () => {
    expect(run({}, false).action).toBe("deny");
  });
  test("only POST /run", () => {
    expect(run({ method: "GET" }).action).toBe("deny");
    expect(run({ url: "https://hostexec.strait.invalid/other" }).action).toBe(
      "deny",
    );
    expect(run({ url: `${url}?x=1` }).action).toBe("deny");
  });
  test("a credential is denied", () => {
    expect(run({ headers: { authorization: "Bearer x" } }).action).toBe("deny");
  });
  test("a duplicated member is denied", () => {
    const body = '{"argv":["echo"],"argv":["rm","-rf","/"],"cwd":"/","env":{}}';
    expect(run({ body }).action).toBe("deny");
  });
  test("truncated JSON is denied without hanging", () => {
    expect(run({ body: '{"argv":["a' }).action).toBe("deny");
  });
  test("an invalid request is denied, not reviewed", () => {
    expect(run({ body: '{"argv":[]}' }).action).toBe("deny");
  });
});

describe("client arguments", () => {
  test("defaults to the current directory and no variables", () => {
    expect(parseClientArgs(["nix", "build"], "/w", {})).toEqual({
      argv: ["nix", "build"],
      cwd: "/w",
      env: {},
    });
  });
  test("--cwd, --env NAME=VALUE and --env NAME", () => {
    expect(
      parseClientArgs(
        ["--cwd", "/x", "--env", "A=1=2", "--env", "B", "--", "-v"],
        "/w",
        { B: "b" },
      ),
    ).toEqual({ argv: ["-v"], cwd: "/x", env: { A: "1=2", B: "b" } });
  });
  test("errors", () => {
    expect(typeof parseClientArgs([], "/w", {})).toBe("string");
    expect(typeof parseClientArgs(["--env", "UNSET", "x"], "/w", {})).toBe(
      "string",
    );
    expect(typeof parseClientArgs(["--bogus", "x"], "/w", {})).toBe("string");
  });
});

describe("review display", () => {
  test("shows the command and its directory", () => {
    const l = line({
      id: "1.x7mq4ndp",
      ref: "k3f9-1.x7mq4ndp",
      session: { id: "k3f9", cwd: "/w", command: ["claude"], startedAt: 0 },
      since: Date.now(),
      expiresAt: Date.now() + 240_000,
      method: "POST",
      url: "https://hostexec.strait.invalid/run",
      reason: "run a command on the host",
      exec: { argv: ["nix", "build", ".#a b"], cwd: "/w/x", env: {} },
    });
    expect(l).toContain("EXEC 'nix' 'build' '.#a b' (in /w/x)");
  });
});

describe("srt respond patch", () => {
  test("filterRequest's own response reaches the client", async () => {
    const server = createServer((req, res) => {
      decideAndRespond(
        // The type srt ships knows only allow and deny.
        async () =>
          ({
            action: "respond",
            status: 200,
            headers: { "content-type": "application/json" },
            body: '{"done":true}',
          }) as never,
        req,
        res,
        "https://hostexec.strait.invalid/run",
        new AbortController().signal,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/run`, {
        method: "POST",
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"done":true}');
    } finally {
      server.close();
    }
  });
});
