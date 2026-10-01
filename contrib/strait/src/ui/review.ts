// strait review: approve or deny requests that running strait sessions hold.
//
//   strait review [--all] [SESSION]          stay open in fzf: Enter approves,
//                                            Ctrl-D denies, Esc quits
//   strait review --json [--all] [SESSION]   print what is waiting as JSON
//   strait review list [--all] [SESSION]     print what is waiting, one per line
//   strait review show REF                   print one request in full
//   strait review approve REF...
//   strait review deny REF...
//
// Without SESSION, only the sessions started in the current directory are
// shown; --all shows every session. A REF is `<session>-<n>.<incarnation>`:
// the session ID (statusline.ts shows it in Claude Code), the request's
// number, and a random word that strait draws each time it starts, so a REF
// never outlives the process that issued it. Every approval covers that one
// request only.

import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";
import type {
  ApprovalRequest,
  ApprovalResponse,
  Pending,
} from "../core/approval.ts";
import { REQUEST_ID, socketDir } from "../core/approval.ts";
import { type ExecRequest, INHERITED_ENV } from "../core/hostexec.ts";
import { isSessionId, type SessionInfo, socketFor } from "../core/session.ts";

export interface Held extends Pending {
  /** `<session>-<n>.<incarnation>`, unique across sessions and restarts. */
  ref: string;
  session: SessionInfo;
}

/** Which sessions to look at. */
export type Scope = { session: string } | { cwd: string } | { all: true };

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

export async function collect(dir: string, scope: Scope): Promise<Held[]> {
  const ids =
    "session" in scope
      ? [scope.session]
      : readdirSync(dir)
          .filter((f) => f.endsWith(".sock"))
          .map((f) => f.slice(0, -".sock".length))
          .filter(isSessionId);
  const held: Held[] = [];
  for (const id of ids) {
    // A session that crashed leaves a socket nobody answers, and one started
    // by an older strait answers without `session`; skip both, so that one
    // bad socket does not hide every other session's requests.
    const res = await ask(socketFor(dir, id), { op: "list" });
    if (res === null || !("pending" in res)) continue;
    if (typeof res.session !== "object" || res.session === null) continue;
    if ("cwd" in scope && res.session.cwd !== scope.cwd) continue;
    for (const p of res.pending) {
      held.push({
        ...p,
        session: res.session,
        ref: `${res.session.id}-${p.id}`,
      });
    }
  }
  return held.sort((a, b) => a.since - b.since);
}

/** A REF split at the last `-`; a session ID never ends in one. */
export function parseRef(ref: string): { session: string; id: string } | null {
  const i = ref.lastIndexOf("-");
  const session = ref.slice(0, i);
  const id = ref.slice(i + 1);
  return i > 0 && isSessionId(session) && REQUEST_ID.test(id)
    ? { session, id }
    : null;
}

async function settle(
  dir: string,
  refs: string[],
  approve: boolean,
): Promise<boolean> {
  let ok = true;
  for (const ref of refs) {
    const r = parseRef(ref);
    const res = r
      ? await ask(socketFor(dir, r.session), {
          op: "decide",
          id: r.id,
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

/** Where a session runs, as far as strait could tell. */
function terminal(s: SessionInfo): string {
  const parts = [
    s.tmuxPane ? `tmux ${s.tmuxPane}` : undefined,
    s.tty?.replace(/^\/dev\//, ""),
  ].filter((p) => p !== undefined);
  return parts.length ? parts.join(" ") : "no tty";
}

/** One line per request; fields are tab-separated and the first is the REF. */
export function line(h: Held): string {
  const what = h.exec
    ? `EXEC ${h.exec.argv.map(shellQuote).join(" ")} (in ${h.exec.cwd})`
    : `${h.method} ${h.url}`;
  return [
    h.ref,
    `[${h.session.id}]`,
    visible(what),
    visible(h.reason),
    `(${age(h.since)}, ${visible(terminal(h.session))})`,
  ].join("\t");
}

export function details(h: Held): string {
  const s = h.session;
  const out = [
    `id:      ${h.ref}`,
    `session: ${s.id}, ${visible(s.command.map(shellQuote).join(" "))}`,
    `         in ${visible(s.cwd)}, ${visible(terminal(s))}, started ${new Date(s.startedAt).toLocaleString()}`,
    `waiting: ${age(h.since)}`,
    `request: ${visible(`${h.method} ${h.url}`)}`,
    `reason:  ${visible(h.reason)}`,
  ];
  if (h.exec) out.push("", ...execDetails(h.exec).map((l) => visible(l)));
  else if (h.body !== undefined) {
    out.push("", visible(prettyBody(h.body), true));
  }
  return out.join("\n");
}

// One argument per line: a shell-quoted join would hide where each one ends.
function execDetails(e: ExecRequest): string[] {
  const env = Object.entries(e.env);
  return [
    "command, run on the host:",
    ...e.argv.map((a, i) => `  argv[${i}] ${JSON.stringify(a)}`),
    `cwd: ${JSON.stringify(e.cwd)}`,
    `env: ${INHERITED_ENV.join(", ")} from the host${env.length ? ", plus:" : ", nothing else"}`,
    ...env.map(([k, v]) => `  ${k}=${JSON.stringify(v)}`),
  ];
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

/** The machine-readable form of `strait review --json`. */
export function structured(h: Held): Record<string, unknown> {
  return {
    ref: h.ref,
    session: h.session,
    method: h.method,
    url: h.url,
    reason: h.reason,
    since: new Date(h.since).toISOString(),
    ...(h.exec ? { exec: h.exec } : {}),
    ...(h.body !== undefined ? { body: h.body } : {}),
  };
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function scopeArgs(scope: Scope): string[] {
  if ("session" in scope) return [scope.session];
  if ("all" in scope) return ["--all"];
  return [];
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
}

/**
 * The fzf arguments for the resident review. Approving or denying runs
 * `strait review approve|deny` on the selection and reloads the list, so fzf
 * stays open; `reload` is also what the poller sends when something new
 * arrives.
 */
export function tuiArgs(self: string, scope: Scope, port: number): string[] {
  const strait = shellQuote(self);
  const list = [
    strait,
    "review",
    "list",
    ...scopeArgs(scope).map(shellQuote),
  ].join(" ");
  return [
    "--multi",
    "--delimiter=\t",
    "--with-nth=2..",
    "--no-sort",
    // Keep the cursor on the same request when the list reloads.
    "--track",
    "--id-nth=1",
    "--prompt=strait> ",
    "--header=Enter: approve | Ctrl-D: deny | Tab: select several | Ctrl-R: reload | Esc: quit",
    `--bind=start:reload(${list})`,
    `--bind=enter:execute-silent(${strait} review approve {+1})+clear-selection+reload(${list})`,
    `--bind=ctrl-d:execute-silent(${strait} review deny {+1})+clear-selection+reload(${list})`,
    `--bind=ctrl-r:reload(${list})`,
    `--preview=${strait} review show {1}`,
    "--preview-window=right,55%,wrap",
    `--listen=127.0.0.1:${port}`,
  ];
}

async function tui(dir: string, scope: Scope): Promise<number> {
  const self = resolve(import.meta.dir, "..", "..", "strait");
  const port = await freePort();
  // fzf's --listen accepts actions, including execute, from any local
  // process that knows the port; the key keeps it to this one.
  const key = randomUUID();
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(["fzf", ...tuiArgs(self, scope, port)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      env: { ...process.env, FZF_API_KEY: key },
    });
  } catch {
    console.error(
      "fzf is not installed; use `strait review list` with approve/deny",
    );
    return 2;
  }
  // Reload when what is waiting changes, not on a timer: a reload moves the
  // list under the cursor, so doing it for nothing gets in the way.
  let last = (await collect(dir, scope)).map((h) => h.ref).join(" ");
  const list = ["review", "list", ...scopeArgs(scope)]
    .map(shellQuote)
    .join(" ");
  const poll = setInterval(async () => {
    const now = (await collect(dir, scope)).map((h) => h.ref).join(" ");
    if (now === last) return;
    last = now;
    await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "x-api-key": key },
      body: `reload(${shellQuote(self)} ${list})`,
    }).catch(() => {});
  }, 1000);
  const code = await child.exited;
  clearInterval(poll);
  // 130 is Esc or Ctrl-C.
  return code === 130 || code === 0 ? 0 : code;
}

function usage(): never {
  console.error(
    "usage: strait review [--json] [--all] [SESSION]\n" +
      "       strait review list [--all] [SESSION]\n" +
      "       strait review show REF\n" +
      "       strait review approve|deny REF...",
  );
  process.exit(2);
}

/** `[--json] [--all] [SESSION]`, in any order. */
function parseScope(args: string[]): { scope: Scope; json: boolean } {
  let json = false;
  let all = false;
  let session: string | undefined;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a === "--all") all = true;
    else if (!a.startsWith("-") && session === undefined && isSessionId(a)) {
      session = a;
    } else usage();
  }
  if (all && session !== undefined) usage();
  const scope: Scope =
    session !== undefined
      ? { session }
      : all
        ? { all: true }
        : { cwd: process.cwd() };
  return { scope, json };
}

/**
 * Whether a named session is running. A misspelt ID would otherwise show an
 * empty list that never fills, which looks exactly like nothing waiting.
 */
async function running(dir: string, scope: Scope): Promise<boolean> {
  if (!("session" in scope)) return true;
  const res = await ask(socketFor(dir, scope.session), { op: "list" });
  if (res !== null && "pending" in res) return true;
  console.error(`strait review: session ${scope.session} is not running`);
  return false;
}

export async function reviewMain(argv: string[]): Promise<number> {
  const dir = socketDir();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "list": {
      const { scope } = parseScope(rest);
      if (!(await running(dir, scope))) return 1;
      for (const h of await collect(dir, scope)) console.log(line(h));
      return 0;
    }
    case "show": {
      const r = rest[0] === undefined ? null : parseRef(rest[0]);
      if (r === null || rest.length !== 1) usage();
      const h = (await collect(dir, { session: r.session })).find(
        (x) => x.ref === rest[0],
      );
      if (h === undefined) {
        console.log(`${rest[0]} is no longer waiting`);
        return 1;
      }
      console.log(details(h));
      return 0;
    }
    case "approve":
    case "deny": {
      const refs = rest.filter((r) => r !== "");
      if (refs.length === 0) return 2;
      return (await settle(dir, refs, cmd === "approve")) ? 0 : 1;
    }
    default: {
      const { scope, json } = parseScope(argv);
      if (!(await running(dir, scope))) return 1;
      if (json) {
        console.log(
          JSON.stringify((await collect(dir, scope)).map(structured)),
        );
        return 0;
      }
      return tui(dir, scope);
    }
  }
}
