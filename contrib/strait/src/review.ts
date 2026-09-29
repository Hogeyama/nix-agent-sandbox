// strait-review: approve or deny requests that running strait sessions hold.
//
//   strait-review                 pick with fzf (Enter approves, Ctrl-D denies)
//   strait-review list            print what is waiting
//   strait-review show ID         print one request in full
//   strait-review approve ID...
//   strait-review deny ID...
//
// An ID is `<pid>-<n>`: the strait process and its request number. Every
// approval covers that one request only.

import { readdirSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import type { ApprovalRequest, ApprovalResponse, Pending } from "./approval.ts";
import { socketDir } from "./approval.ts";

interface Held extends Pending {
  /** `<pid>-<n>`, unique across sessions. */
  ref: string;
  pid: string;
  cwd: string;
}

export function ask(
  path: string,
  req: ApprovalRequest,
): Promise<ApprovalResponse | null> {
  return new Promise((done) => {
    const socket = connect(path);
    let buf = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("connect", () => socket.write(`${JSON.stringify(req)}\n`));
    socket.on("data", (c: string) => {
      buf += c;
    });
    socket.on("error", () => done(null));
    socket.on("close", () => {
      try {
        done(JSON.parse(buf) as ApprovalResponse);
      } catch {
        done(null);
      }
    });
  });
}

const socketFor = (dir: string, pid: string) => join(dir, `${pid}.sock`);

export async function collect(dir: string): Promise<Held[]> {
  const pids = readdirSync(dir)
    .filter((f) => /^\d+\.sock$/.test(f))
    .map((f) => f.slice(0, -".sock".length));
  const held: Held[] = [];
  for (const pid of pids) {
    // A session that crashed leaves a socket nobody answers; skip it.
    const res = await ask(socketFor(dir, pid), { op: "list" });
    if (res === null || !("pending" in res)) continue;
    for (const p of res.pending) {
      held.push({ ...p, pid, cwd: res.cwd, ref: `${pid}-${p.id}` });
    }
  }
  return held.sort((a, b) => a.since - b.since);
}

async function settle(
  dir: string,
  refs: string[],
  approve: boolean,
): Promise<boolean> {
  let ok = true;
  for (const ref of refs) {
    const m = /^(\d+)-(\d+)$/.exec(ref);
    const res = m
      ? await ask(socketFor(dir, m[1] as string), {
          op: "decide",
          id: m[2] as string,
          approve,
        })
      : null;
    if (res !== null && "ok" in res && res.ok) {
      console.log(`${approve ? "approved" : "denied"} ${ref}`);
    } else {
      console.error(`${ref}: no such request (already decided or timed out)`);
      ok = false;
    }
  }
  return ok;
}

const age = (since: number) => `${Math.round((Date.now() - since) / 1000)}s`;

// Everything shown came from the sandbox (the URL, a GraphQL owner in the
// reason, the body), so control characters are made visible: a newline could
// forge another fzf line, an escape sequence could redraw the terminal, and
// a bidi override could reorder what is shown.
const visible = (s: string, keepNewlines = false) =>
  s.replace(/[\p{Cc}\p{Cf}]/gu, (c) =>
    keepNewlines && c === "\n"
      ? c
      : `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`,
  );

export function line(h: Held): string {
  return [
    h.ref,
    visible(`${h.method} ${h.url}`),
    visible(h.reason),
    `(${age(h.since)}, ${visible(h.cwd)})`,
  ].join("\t");
}

export function details(h: Held): string {
  const out = [
    `id:      ${h.ref}`,
    `session: ${visible(h.cwd)} (pid ${h.pid})`,
    `waiting: ${age(h.since)}`,
    `request: ${visible(`${h.method} ${h.url}`)}`,
    `reason:  ${visible(h.reason)}`,
  ];
  if (h.body !== undefined) out.push("", visible(prettyBody(h.body), true));
  return out.join("\n");
}

// A GraphQL body is easier to judge with its query unescaped.
function prettyBody(body: string): string {
  try {
    const { query, ...rest } = JSON.parse(body) as Record<string, unknown>;
    if (typeof query === "string") {
      return `${query}\n\n${JSON.stringify(rest, null, 2)}`;
    }
  } catch {}
  return body;
}

async function fzf(
  input: string,
  args: string[],
): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(["fzf", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  child.stdin.write(input);
  child.stdin.end();
  const out = await new Response(child.stdout).text();
  return { code: await child.exited, out };
}

async function interactive(dir: string): Promise<number> {
  const held = await collect(dir);
  if (held.length === 0) {
    console.log("nothing is waiting");
    return 0;
  }
  const self = resolve(import.meta.dir, "..", "strait-review");
  let result: { code: number; out: string };
  try {
    result = await fzf(`${held.map(line).join("\n")}\n`, [
      "--multi",
      "--delimiter=\t",
      "--with-nth=2..",
      "--expect=enter,ctrl-d",
      "--header=Tab: select | Enter: approve | Ctrl-D: deny | Esc: cancel",
      "--prompt=strait> ",
      "--no-sort",
      `--preview=${shellQuote(self)} show {1}`,
      "--preview-window=down,60%,wrap",
    ]);
  } catch {
    console.error(
      "fzf is not installed; use `strait-review list` and approve/deny",
    );
    return 2;
  }
  // 130 is Esc or Ctrl-C, 1 is no match.
  if (result.code === 130 || result.code === 1) return 0;
  if (result.code !== 0) throw new Error(`fzf exited with ${result.code}`);
  const [key, ...picked] = result.out.trimEnd().split("\n");
  const refs = picked.map((l) => l.split("\t")[0] as string);
  if (refs.length === 0) return 0;
  return (await settle(dir, refs, key !== "ctrl-d")) ? 0 : 1;
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function usage(): never {
  console.error(
    "usage: strait-review [list | show ID | approve ID... | deny ID...]",
  );
  process.exit(2);
}

async function main(argv: string[]): Promise<number> {
  const dir = socketDir();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
      return interactive(dir);
    case "list": {
      const held = await collect(dir);
      for (const h of held) console.log(line(h));
      if (held.length === 0) console.error("nothing is waiting");
      return 0;
    }
    case "show": {
      const h = (await collect(dir)).find((x) => x.ref === rest[0]);
      if (h === undefined) {
        console.log(`${rest[0]} is no longer waiting`);
        return 1;
      }
      console.log(details(h));
      return 0;
    }
    case "approve":
    case "deny":
      if (rest.length === 0) usage();
      return (await settle(dir, rest, cmd === "approve")) ? 0 : 1;
    default:
      usage();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`strait-review: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    },
  );
}
