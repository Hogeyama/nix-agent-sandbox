/**
 * handleApprovalSubcommand unit tests.
 *
 * Exercises the pending/approve/deny output paths with a fake adapter that
 * records sendDecision calls. fzf-based `review` is not exercised here; it
 * requires a tty and is covered by e2e tests.
 */

import { beforeEach, expect, test } from "bun:test";
import {
  type ApprovalAdapter,
  handleApprovalSubcommand,
  type PendingItem,
  sessionFilterArg,
} from "./approval_command.ts";

interface DecisionCall {
  sessionId: string;
  requestId: string;
  message:
    | { type: "approve"; requestId: string; scope?: string }
    | { type: "deny"; requestId: string };
}

function makeAdapter(pending: PendingItem[] = []): {
  adapter: ApprovalAdapter;
  calls: DecisionCall[];
} {
  const calls: DecisionCall[] = [];
  const adapter: ApprovalAdapter = {
    domain: "test-domain",
    scopeOptions: ["scope-a", "scope-b"],
    async listPending() {
      return pending;
    },
    async sessionAlive() {
      return true;
    },
    async sendDecision(sessionId, requestId, message) {
      calls.push({ sessionId, requestId, message });
    },
  };
  return { adapter, calls };
}

let stdoutLines: string[] = [];
const realLog = console.log;
beforeEach(() => {
  stdoutLines = [];
  console.log = (...args: unknown[]) => {
    stdoutLines.push(args.map(String).join(" "));
  };
});

function restoreLog() {
  console.log = realLog;
}

// ---------------------------------------------------------------------------
// pending / default subcommand
// ---------------------------------------------------------------------------

test("pending: prints each display line when items are present", async () => {
  const { adapter } = makeAdapter([
    {
      sessionId: "s1",
      requestId: "r1",
      displayLine: "[s1/r1] https://example.com",
    },
    {
      sessionId: "s2",
      requestId: "r2",
      displayLine: "[s2/r2] git.example.com",
    },
  ]);
  const handled = await handleApprovalSubcommand(adapter, "pending", []);
  restoreLog();

  expect(handled).toEqual(true);
  expect(stdoutLines).toEqual([
    "[s1/r1] https://example.com",
    "[s2/r2] git.example.com",
  ]);
});

test("pending: undefined subcommand defaults to pending listing", async () => {
  const { adapter } = makeAdapter([
    { sessionId: "s1", requestId: "r1", displayLine: "one" },
  ]);
  const handled = await handleApprovalSubcommand(adapter, undefined, []);
  restoreLog();

  expect(handled).toEqual(true);
  expect(stdoutLines).toEqual(["one"]);
});

test("pending: prints domain-specific empty message when no items", async () => {
  const { adapter } = makeAdapter([]);
  const handled = await handleApprovalSubcommand(adapter, "pending", []);
  restoreLog();

  expect(handled).toEqual(true);
  expect(stdoutLines).toEqual(["[nas] No pending test-domain approvals."]);
});

test("pending: --format json emits structured data when available", async () => {
  const { adapter } = makeAdapter([
    {
      sessionId: "s1",
      requestId: "r1",
      displayLine: "ignored",
      structured: { sessionId: "s1", requestId: "r1", host: "example.com" },
    },
    {
      sessionId: "s2",
      requestId: "r2",
      displayLine: "ignored",
    },
  ]);
  await handleApprovalSubcommand(adapter, "pending", ["--format", "json"]);
  restoreLog();

  expect(stdoutLines.length).toEqual(1);
  const parsed = JSON.parse(stdoutLines[0]);
  expect(parsed).toEqual([
    { sessionId: "s1", requestId: "r1", host: "example.com" },
    { sessionId: "s2", requestId: "r2" },
  ]);
});

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

test("approve: sends approve decision and echoes confirmation", async () => {
  const { adapter, calls } = makeAdapter();
  const handled = await handleApprovalSubcommand(adapter, "approve", [
    "approve",
    "sess-xyz",
    "req-42",
  ]);
  restoreLog();

  expect(handled).toEqual(true);
  expect(calls).toEqual([
    {
      sessionId: "sess-xyz",
      requestId: "req-42",
      message: { type: "approve", requestId: "req-42", scope: undefined },
    },
  ]);
  expect(stdoutLines).toEqual(["[nas] Approved sess-xyz req-42"]);
});

test("approve: forwards --scope flag value in the decision message", async () => {
  const { adapter, calls } = makeAdapter();
  await handleApprovalSubcommand(adapter, "approve", [
    "approve",
    "sess-xyz",
    "req-42",
    "--scope",
    "host-port",
  ]);
  restoreLog();

  expect(calls).toEqual([
    {
      sessionId: "sess-xyz",
      requestId: "req-42",
      message: { type: "approve", requestId: "req-42", scope: "host-port" },
    },
  ]);
});

// ---------------------------------------------------------------------------
// deny
// ---------------------------------------------------------------------------

test("deny: sends deny decision (no scope)", async () => {
  const { adapter, calls } = makeAdapter();
  const handled = await handleApprovalSubcommand(adapter, "deny", [
    "deny",
    "sess-1",
    "req-1",
  ]);
  restoreLog();

  expect(handled).toEqual(true);
  expect(calls).toEqual([
    {
      sessionId: "sess-1",
      requestId: "req-1",
      message: { type: "deny", requestId: "req-1" },
    },
  ]);
  expect(stdoutLines).toEqual(["[nas] Denied sess-1 req-1"]);
});

// ---------------------------------------------------------------------------
// review: empty state (fzf path skipped — needs TTY)
// ---------------------------------------------------------------------------

test("review: prints empty message and returns true when no pending items", async () => {
  const { adapter, calls } = makeAdapter([]);
  const handled = await handleApprovalSubcommand(adapter, "review", ["review"]);
  restoreLog();

  expect(handled).toEqual(true);
  expect(calls).toEqual([]);
  expect(stdoutLines).toEqual(["[nas] No pending test-domain approvals."]);
});

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

test("watch: writes the structured payload and stops on the caller's signal", async () => {
  const controller = new AbortController();
  const written: string[] = [];

  const adapter: ApprovalAdapter = {
    domain: "hostexec",
    scopeOptions: ["once", "capability"],
    async listPending() {
      // 1 ティックで止める。実時間の待機を挟まずに配線だけを確かめる。
      controller.abort();
      return [
        {
          sessionId: "sess_a",
          requestId: "req_1",
          displayLine: "",
          structured: { sessionId: "sess_a", requestId: "req_1" },
        },
      ];
    },
    async sessionAlive() {
      return true;
    },
    async sendDecision() {},
  };

  const handled = await handleApprovalSubcommand(adapter, "watch", ["watch"], {
    signal: controller.signal,
    write: (line) => {
      written.push(line);
    },
  });
  restoreLog();

  expect(handled).toEqual(true);
  expect(written).toEqual([
    '{"event":"added","domain":"hostexec","entry":{"sessionId":"sess_a","requestId":"req_1"}}\n',
  ]);
});

test("watch: writes to stdout by default and leaves no listeners behind", async () => {
  const controller = new AbortController();
  const before = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
    stdoutError: process.stdout.listenerCount("error"),
  };
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  const adapter: ApprovalAdapter = {
    domain: "hostexec",
    scopeOptions: [],
    async listPending() {
      controller.abort();
      return [{ sessionId: "sess_a", requestId: "req_1", displayLine: "" }];
    },
    async sessionAlive() {
      return true;
    },
    async sendDecision() {},
  };

  try {
    await handleApprovalSubcommand(adapter, "watch", ["watch"], {
      signal: controller.signal,
    });
  } finally {
    process.stdout.write = realWrite;
  }
  restoreLog();

  expect(written).toEqual([
    '{"event":"added","domain":"hostexec","entry":{"sessionId":"sess_a","requestId":"req_1"}}\n',
  ]);
  // 呼び出しごとに登録したリスナーが残ると、長寿命プロセスで積み上がる。
  expect(process.listenerCount("SIGINT")).toEqual(before.sigint);
  expect(process.listenerCount("SIGTERM")).toEqual(before.sigterm);
  expect(process.stdout.listenerCount("error")).toEqual(before.stdoutError);
});

test("sessionFilterArg: --session without a usable value fails instead of widening", () => {
  expect(sessionFilterArg(["watch"])).toBeUndefined();
  expect(sessionFilterArg(["watch", "--session", "sess_a"])).toEqual("sess_a");
  expect(() => sessionFilterArg(["watch", "--session"])).toThrow(
    "--session requires a session id",
  );
  expect(() =>
    sessionFilterArg(["watch", "--session", "--format", "json"]),
  ).toThrow("--session requires a session id");
});

test("watch: --session limits the stream to one session", async () => {
  const controller = new AbortController();
  const written: string[] = [];

  const adapter: ApprovalAdapter = {
    domain: "network",
    scopeOptions: [],
    async listPending() {
      controller.abort();
      return [
        { sessionId: "sess_a", requestId: "req_1", displayLine: "" },
        { sessionId: "sess_b", requestId: "req_2", displayLine: "" },
      ];
    },
    async sessionAlive() {
      return true;
    },
    async sendDecision() {},
  };

  await handleApprovalSubcommand(
    adapter,
    "watch",
    ["watch", "--session", "sess_b"],
    {
      signal: controller.signal,
      write: (line) => {
        written.push(line);
      },
    },
  );
  restoreLog();

  expect(written).toEqual([
    '{"event":"added","domain":"network","entry":{"sessionId":"sess_b","requestId":"req_2"}}\n',
  ]);
});

// ---------------------------------------------------------------------------
// unknown subcommand
// ---------------------------------------------------------------------------

test("unknown subcommand returns false (caller falls through)", async () => {
  const { adapter, calls } = makeAdapter();
  const handled = await handleApprovalSubcommand(adapter, "reboot", ["reboot"]);
  restoreLog();

  expect(handled).toEqual(false);
  expect(calls).toEqual([]);
  expect(stdoutLines).toEqual([]);
});
