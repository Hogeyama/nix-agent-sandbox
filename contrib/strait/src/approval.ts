// Holding requests for a human, and the Unix socket strait-review talks to.
//
// A request that `decide` sends to review waits in filterRequest until someone
// approves or denies it with strait-review, or until HOLD_MS passes. The
// socket lives in a 0700 directory outside the workspace that main.ts adds to
// denyRead, and srt's seccomp filter blocks AF_UNIX inside the sandbox on
// Linux, so only the host can reach it.

import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FinalDecision } from "./policy.ts";

/**
 * How long a request waits. Below node:http's default requestTimeout (300 s),
 * which can end a held request whose body is not yet consumed.
 */
export const HOLD_MS = 240_000;

export interface Pending {
  id: string;
  method: string;
  url: string;
  /** Why the policy did not allow it. */
  reason: string;
  /** The body strait read to decide, if any (GraphQL). */
  body?: string;
  /** Epoch milliseconds. */
  since: number;
}

export type ApprovalRequest =
  | { op: "list" }
  | { op: "decide"; id: string; approve: boolean };

export type ApprovalResponse =
  | { pending: Pending[]; cwd: string }
  | { ok: boolean }
  | { error: string };

export class Approvals {
  private readonly waiting = new Map<
    string,
    { pending: Pending; settle: (d: FinalDecision) => void }
  >();
  private next = 1;

  constructor(
    private readonly holdMs = HOLD_MS,
    private readonly onPending: (p: Pending) => void = () => {},
  ) {}

  /** Wait for a human. The request is dropped if the client goes away. */
  hold(
    request: Omit<Pending, "id" | "since">,
    signal?: AbortSignal,
  ): Promise<FinalDecision> {
    const id = String(this.next++);
    const pending: Pending = { ...request, id, since: Date.now() };
    return new Promise<FinalDecision>((resolve) => {
      const done = (d: FinalDecision) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.waiting.delete(id);
        resolve(d);
      };
      const aborted = () =>
        done({ action: "deny", reason: "the client went away" });
      const timer = setTimeout(
        () =>
          done({
            action: "deny",
            reason: `${request.reason}; not approved within ${this.holdMs / 1000} s (run strait-review on the host)`,
          }),
        this.holdMs,
      );
      if (signal?.aborted) return aborted();
      signal?.addEventListener("abort", aborted, { once: true });
      this.waiting.set(id, { pending, settle: done });
      this.onPending(pending);
    });
  }

  list(): Pending[] {
    return [...this.waiting.values()].map((w) => w.pending);
  }

  /** Returns false when the request is no longer waiting. */
  decide(id: string, approve: boolean): boolean {
    const w = this.waiting.get(id);
    if (w === undefined) return false;
    w.settle(
      approve
        ? { action: "allow" }
        : { action: "deny", reason: `${w.pending.reason}; denied by the user` },
    );
    return true;
  }

  handle(req: ApprovalRequest): ApprovalResponse {
    if (req.op === "list") return { pending: this.list(), cwd: process.cwd() };
    if (req.op === "decide") return { ok: this.decide(req.id, req.approve) };
    return { error: "unknown op" };
  }
}

/**
 * The directory holding one socket per running strait. It must be a real
 * directory owned by us and closed to everyone else, or anyone who can write
 * there could stand in for a session.
 */
export function socketDir(): string {
  const base = process.env.XDG_RUNTIME_DIR || tmpdir();
  const uid = process.getuid?.() ?? 0;
  const dir = join(
    base,
    process.env.XDG_RUNTIME_DIR ? "strait" : `strait-${uid}`,
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new Error(`${dir} must be a directory owned by you with mode 0700`);
  }
  return dir;
}

/** One JSON request per connection, one JSON response back. */
export function serve(approvals: Approvals, path: string): Promise<Server> {
  const server = createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > 64 * 1024) return socket.destroy();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let res: ApprovalResponse;
      try {
        res = approvals.handle(JSON.parse(buf.slice(0, nl)) as ApprovalRequest);
      } catch {
        res = { error: "bad request" };
      }
      socket.end(`${JSON.stringify(res)}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

export function removeSocket(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

/** Best effort: a desktop notification if notify-send exists. */
export function notify(p: Pending): void {
  try {
    const child = spawn(
      "notify-send",
      ["strait: approval needed", `${p.method} ${p.url}\n${p.reason}`],
      { stdio: "ignore", detached: true },
    );
    child.on("error", () => {});
    child.unref();
  } catch {}
}
