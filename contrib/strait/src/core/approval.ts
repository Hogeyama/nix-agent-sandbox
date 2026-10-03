// Holding requests for a human, and the Unix socket `strait review` talks to.
//
// A request that `decide` sends to review waits in filterRequest until someone
// approves or denies it with `strait review`, or until HOLD_MS passes. The
// socket lives in a 0700 directory outside the workspace that main.ts adds to
// denyRead, and srt's seccomp filter blocks AF_UNIX inside the sandbox on
// Linux, so only the host can reach it.

import { randomInt } from "node:crypto";
import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecRequest } from "./hostexec.ts";
import type { FinalDecision } from "./policy.ts";
import type { SessionInfo } from "./session.ts";

/**
 * How long a request waits. Below node:http's default requestTimeout (300 s),
 * which can end a held request whose body is not yet consumed.
 */
export const HOLD_MS = 240_000;

// Lowercase letters and digits without the ones easy to misread (0 o 1 l).
// Session IDs (session.ts) use it too.
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

export function randomWord(length: number): string {
  let w = "";
  for (let i = 0; i < length; i++) w += ALPHABET[randomInt(ALPHABET.length)];
  return w;
}

/**
 * A request ID is `<n>.<incarnation>`. The incarnation is drawn once per
 * strait process: a session restarted under the same --name counts from 1
 * again, and without it a ref read before the restart would name, and could
 * approve, an unrelated request of the new process.
 */
const INCARNATION_LENGTH = 8;
export const REQUEST_ID = new RegExp(
  `^\\d+\\.[${ALPHABET}]{${INCARNATION_LENGTH}}$`,
);

export interface Pending {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  /** Why the policy did not allow it. */
  readonly reason: string;
  /** The body strait read to decide, if any (GraphQL). */
  readonly body?: string;
  /** A command to run on the host, when this is a hostexec request. */
  readonly exec?: ExecRequest;
  /** Epoch milliseconds. */
  readonly since: number;
  /** Epoch milliseconds; the request is denied from then on. */
  readonly expiresAt: number;
}

export type HeldRequest = Omit<Pending, "id" | "since" | "expiresAt">;

export type ApprovalRequest =
  | { op: "list" }
  | { op: "decide"; id: string; approve: boolean };

export type ApprovalResponse =
  | { pending: Pending[]; session: SessionInfo }
  | { ok: boolean }
  | { error: string };

/**
 * Wall-clock time for `since`/`expiresAt`, and a monotonic one for the
 * deadline itself, so that setting the clock back cannot extend a hold.
 */
export interface ApprovalClock {
  now(): number;
  monotonicNow(): number;
}

const systemClock: ApprovalClock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
};

interface Waiting {
  pending: Pending;
  deadline: number;
  signal?: AbortSignal;
  settle: (d: FinalDecision) => void;
}

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};

export class Approvals {
  private readonly waiting = new Map<string, Waiting>();
  private next = 1;
  private readonly incarnation = randomWord(INCARNATION_LENGTH);
  private closedReason: string | undefined;

  constructor(
    private readonly session: SessionInfo,
    private readonly holdMs = HOLD_MS,
    private readonly onPending: (p: Pending) => void = () => {},
    private readonly clock: ApprovalClock = systemClock,
  ) {
    if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > HOLD_MS) {
      throw new Error(`approval hold must be between 0 and ${HOLD_MS} ms`);
    }
  }

  /** Wait for a human. The request is dropped if the client goes away. */
  hold(request: HeldRequest, signal?: AbortSignal): Promise<FinalDecision> {
    if (this.closedReason !== undefined) {
      return Promise.resolve({ action: "deny", reason: this.closedReason });
    }
    const id = `${this.next++}.${this.incarnation}`;
    const since = this.clock.now();
    const deadline = this.clock.monotonicNow() + this.holdMs;
    // A copy, frozen: what the caller does to its object afterwards, or what
    // a notifier does to the snapshot, cannot change what gets approved.
    const pending: Pending = deepFreeze(
      structuredClone({
        ...request,
        id,
        since,
        expiresAt: since + this.holdMs,
      }),
    );
    return new Promise<FinalDecision>((resolve) => {
      let settled = false;
      const done = (d: FinalDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.waiting.delete(id);
        resolve(d);
      };
      const aborted = () =>
        done({ action: "deny", reason: "the client went away" });
      const timer = setTimeout(() => done(this.expired(pending)), this.holdMs);
      if (signal?.aborted) return aborted();
      signal?.addEventListener("abort", aborted, { once: true });
      const w: Waiting = { pending, deadline, signal, settle: done };
      this.waiting.set(id, w);
      if (this.dropIfOver(w)) return;
      try {
        this.onPending(pending);
      } catch {
        // A held request nobody was told about would only time out.
        done({
          action: "deny",
          reason: `${pending.reason}; approval notification failed`,
        });
      }
    });
  }

  list(): Pending[] {
    return [...this.waiting.values()]
      .filter((w) => !this.dropIfOver(w))
      .map((w) => w.pending);
  }

  /** Returns false when the request is no longer waiting. */
  decide(id: string, approve: boolean): boolean {
    if (typeof approve !== "boolean") return false;
    const w = this.waiting.get(id);
    if (w === undefined || this.dropIfOver(w)) return false;
    w.settle(
      approve
        ? { action: "allow" }
        : { action: "deny", reason: `${w.pending.reason}; denied by the user` },
    );
    return true;
  }

  /** Deny everything waiting, and everything held from now on. */
  close(reason = "strait is exiting"): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const w of [...this.waiting.values()]) {
      w.settle({ action: "deny", reason });
    }
  }

  /** Socket input is untrusted, whatever its TypeScript type says. */
  handle(req: unknown): ApprovalResponse {
    if (typeof req !== "object" || req === null || Array.isArray(req)) {
      return { error: "bad request" };
    }
    const r = req as Record<string, unknown>;
    const keys = Object.keys(r).sort().join(",");
    if (r.op === "list") {
      if (keys !== "op") return { error: "bad request" };
      return { pending: this.list(), session: this.session };
    }
    if (r.op === "decide") {
      if (
        keys !== "approve,id,op" ||
        typeof r.id !== "string" ||
        typeof r.approve !== "boolean"
      ) {
        return { error: "bad request" };
      }
      return { ok: this.decide(r.id, r.approve) };
    }
    return { error: "unknown op" };
  }

  private expired(p: Pending): FinalDecision {
    return {
      action: "deny",
      reason: `${p.reason}; not approved within ${this.holdMs / 1000} s (run "strait review ${this.session.id}" on the host)`,
    };
  }

  /**
   * Settle a request whose client left or whose time is up. Checked on every
   * list and decide, not only by the timer, which a busy event loop delays.
   */
  private dropIfOver(w: Waiting): boolean {
    if (w.signal?.aborted) {
      w.settle({ action: "deny", reason: "the client went away" });
      return true;
    }
    const now = this.clock.now();
    const mono = this.clock.monotonicNow();
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(mono) ||
      now >= w.pending.expiresAt ||
      mono >= w.deadline
    ) {
      w.settle(this.expired(w.pending));
      return true;
    }
    return false;
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

export const SOCKET_COMMAND_BYTES = 64 * 1024;
export const SOCKET_COMMAND_TIMEOUT_MS = 5_000;

/**
 * One newline-terminated JSON request per connection, one JSON response back.
 * Anything else, including a second request after the first, is refused.
 */
export function handleConnection(approvals: Approvals, socket: Socket): void {
  let buf = Buffer.alloc(0);
  let handled = false;
  // An absolute deadline: a slow writer cannot extend it as it could an
  // idle timeout.
  const expiresAt = performance.now() + SOCKET_COMMAND_TIMEOUT_MS;
  const deadline = setTimeout(
    () => socket.destroy(),
    SOCKET_COMMAND_TIMEOUT_MS,
  );
  socket.on("close", () => clearTimeout(deadline));
  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => {
    if (handled) return;
    if (
      performance.now() >= expiresAt ||
      buf.length + chunk.length > SOCKET_COMMAND_BYTES
    ) {
      handled = true;
      socket.destroy();
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl === -1) return;
    // Before dispatch, so that data arriving while the response drains
    // cannot decide a second request.
    handled = true;
    let res: ApprovalResponse;
    try {
      if (nl !== buf.length - 1) throw new Error("more than one request");
      const json = new TextDecoder("utf-8", { fatal: true }).decode(
        buf.subarray(0, nl),
      );
      res = approvals.handle(JSON.parse(json));
    } catch {
      res = { error: "bad request" };
    }
    socket.end(`${JSON.stringify(res)}\n`);
  });
}

export function serve(approvals: Approvals, path: string): Promise<Server> {
  const server = createServer((socket) => handleConnection(approvals, socket));
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
