import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeHostExecApprovalClient } from "../domain/hostexec.ts";
import {
  type HostExecRuntimePaths,
  resolveHostExecRuntimePaths,
  writeHostExecPendingEntry,
  writeHostExecSessionRegistry,
} from "../hostexec/registry.ts";
import type { PendingItem } from "./approval_command.ts";
import {
  diffPending,
  type PendingSnapshotEntry,
  runApprovalWatch,
  type WatchDeps,
} from "./approval_watch.ts";

function item(
  sessionId: string,
  requestId: string,
  structured?: Record<string, unknown>,
): PendingItem {
  return { sessionId, requestId, displayLine: "", structured };
}

function emptyState(): Map<string, PendingSnapshotEntry> {
  return new Map();
}

test("diffPending emits added for every entry of the first snapshot", () => {
  const { events, nextState } = diffPending("hostexec", emptyState(), [
    item("sess_a", "req_1", {
      sessionId: "sess_a",
      requestId: "req_1",
      ruleId: "gcloud",
    }),
    item("sess_a", "req_2", {
      sessionId: "sess_a",
      requestId: "req_2",
      ruleId: "gpg-git-sign",
    }),
  ]);

  expect(events).toEqual([
    {
      event: "added",
      domain: "hostexec",
      entry: { sessionId: "sess_a", requestId: "req_1", ruleId: "gcloud" },
    },
    {
      event: "added",
      domain: "hostexec",
      entry: {
        sessionId: "sess_a",
        requestId: "req_2",
        ruleId: "gpg-git-sign",
      },
    },
  ]);
  expect(nextState.size).toBe(2);
});

test("diffPending emits nothing when the snapshot is unchanged", () => {
  const first = diffPending("network", emptyState(), [item("sess_a", "req_1")]);
  const second = diffPending("network", first.nextState, [
    item("sess_a", "req_1"),
  ]);

  expect(second.events).toEqual([]);
});

test("diffPending emits removed for entries that disappeared", () => {
  const first = diffPending("hostexec", emptyState(), [
    item("sess_a", "req_1"),
    item("sess_b", "req_2"),
  ]);
  const second = diffPending("hostexec", first.nextState, [
    item("sess_b", "req_2"),
  ]);

  expect(second.events).toEqual([
    {
      event: "removed",
      domain: "hostexec",
      sessionId: "sess_a",
      requestId: "req_1",
    },
  ]);
  expect(second.nextState.size).toBe(1);
});

test("diffPending emits removed before added within one tick", () => {
  const first = diffPending("hostexec", emptyState(), [
    item("sess_a", "req_1"),
  ]);
  const second = diffPending("hostexec", first.nextState, [
    item("sess_a", "req_2"),
  ]);

  expect(second.events.map((e) => e.event)).toEqual(["removed", "added"]);
});

test("diffPending falls back to the id pair when an item carries no structured payload", () => {
  const { events } = diffPending("network", emptyState(), [
    item("sess_a", "req_1"),
  ]);

  expect(events).toEqual([
    {
      event: "added",
      domain: "network",
      entry: { sessionId: "sess_a", requestId: "req_1" },
    },
  ]);
});

test("diffPending distinguishes the same requestId across sessions", () => {
  const { nextState } = diffPending("hostexec", emptyState(), [
    item("sess_a", "req_1"),
    item("sess_b", "req_1"),
  ]);

  expect(nextState.size).toBe(2);
});

interface Harness {
  readonly lines: string[];
  readonly warnings: string[];
  readonly deps: WatchDeps;
  readonly controller: AbortController;
}

/** ティックごとの listPending 結果を順に返し、尽きたら停止させる。 */
function harness(ticks: Array<PendingItem[] | Error>): Harness {
  const controller = new AbortController();
  const lines: string[] = [];
  const warnings: string[] = [];
  let index = 0;
  const deps: WatchDeps = {
    listPending: async () => {
      const tick = ticks[index];
      index += 1;
      if (index >= ticks.length) controller.abort();
      if (tick instanceof Error) throw tick;
      return tick;
    },
    write: (line) => {
      lines.push(line);
    },
    warn: (message) => {
      warnings.push(message);
    },
    sleep: async () => {},
    signal: controller.signal,
  };
  return { lines, warnings, deps, controller };
}

test("runApprovalWatch writes one JSON line per event", async () => {
  const h = harness([
    [item("sess_a", "req_1", { sessionId: "sess_a", requestId: "req_1" })],
    [],
  ]);

  await runApprovalWatch("hostexec", undefined, h.deps);

  expect(h.lines).toEqual([
    '{"event":"added","domain":"hostexec","entry":{"sessionId":"sess_a","requestId":"req_1"}}\n',
    '{"event":"removed","domain":"hostexec","sessionId":"sess_a","requestId":"req_1"}\n',
  ]);
});

test("runApprovalWatch keeps polling after a failed tick", async () => {
  const h = harness([
    new Error("runtime dir vanished"),
    [item("sess_a", "req_1", { sessionId: "sess_a", requestId: "req_1" })],
  ]);

  await runApprovalWatch("network", undefined, h.deps);

  expect(h.warnings).toEqual(["[nas] network watch: runtime dir vanished"]);
  expect(h.lines).toHaveLength(1);
});

test("runApprovalWatch reports a rejection that is not an Error", async () => {
  const controller = new AbortController();
  const warnings: string[] = [];

  await runApprovalWatch("hostexec", undefined, {
    listPending: async () => {
      controller.abort();
      // Error 以外で reject される経路を再現する。
      throw "broker socket refused";
    },
    write: () => {},
    warn: (message) => {
      warnings.push(message);
    },
    sleep: async () => {},
    signal: controller.signal,
  });

  expect(warnings).toEqual(["[nas] hostexec watch: broker socket refused"]);
});

test("runApprovalWatch applies the session filter", async () => {
  const h = harness([
    [
      item("sess_a", "req_1", { sessionId: "sess_a", requestId: "req_1" }),
      item("sess_b", "req_2", { sessionId: "sess_b", requestId: "req_2" }),
    ],
  ]);

  await runApprovalWatch("hostexec", "sess_b", h.deps);

  expect(h.lines).toEqual([
    '{"event":"added","domain":"hostexec","entry":{"sessionId":"sess_b","requestId":"req_2"}}\n',
  ]);
});

test("runApprovalWatch returns without polling when already aborted", async () => {
  const h = harness([[item("sess_a", "req_1")]]);
  h.controller.abort();

  await runApprovalWatch("hostexec", undefined, h.deps);

  expect(h.lines).toEqual([]);
});

// ---------------------------------------------------------------------------
// 実 runtime dir を相手にした 1 往復。spec の「runtime dir が存在しない状態での
// 起動を正常系として扱う」は listPending 側の ENOENT 耐性に依存しており、
// 依存先が変わったら壊れる。
// ---------------------------------------------------------------------------

/** 一度きりのポーリングで止める deps を組む。 */
function singleTick(
  paths: HostExecRuntimePaths,
  lines: string[],
  warnings: string[],
): WatchDeps {
  const controller = new AbortController();
  const client = makeHostExecApprovalClient();
  return {
    listPending: async () => {
      controller.abort();
      const entries = await client.listPending(paths);
      return entries.map((entry) => ({
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        displayLine: "",
        structured: { sessionId: entry.sessionId, requestId: entry.requestId },
      }));
    },
    write: (line) => {
      lines.push(line);
    },
    warn: (message) => {
      warnings.push(message);
    },
    sleep: async () => {},
    signal: controller.signal,
  };
}

test("runApprovalWatch over a real runtime dir tolerates a missing tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-watch-"));
  try {
    // resolveHostExecRuntimePaths はディレクトリを作るので、存在しない状態を
    // 作るには paths を直接組む。
    const absent = path.join(root, "absent");
    const paths: HostExecRuntimePaths = {
      runtimeDir: absent,
      sessionsDir: path.join(absent, "sessions"),
      pendingDir: path.join(absent, "pending"),
      brokersDir: path.join(absent, "brokers"),
      wrappersDir: path.join(absent, "wrappers"),
    };
    const lines: string[] = [];
    const warnings: string[] = [];

    await runApprovalWatch(
      "hostexec",
      undefined,
      singleTick(paths, lines, warnings),
    );

    expect(lines).toEqual([]);
    expect(warnings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("runApprovalWatch over a real runtime dir reports a written entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-watch-"));
  try {
    const paths = await resolveHostExecRuntimePaths(root);
    // listPending は gc を挟み、生きた pid と実在する broker socket の両方を
    // 備えないセッションの pending を掃除する。どちらも用意しないと、書いた
    // 直後のエントリが消える。
    const brokerSocket = path.join(paths.brokersDir, "sess_a1", "sock");
    await mkdir(path.dirname(brokerSocket), { recursive: true });
    await writeFile(brokerSocket, "");
    await writeHostExecSessionRegistry(paths, {
      version: 1,
      sessionId: "sess_a1",
      brokerSocket,
      profileName: "test",
      createdAt: "2026-09-16T04:12:00.000Z",
      pid: process.pid,
    });
    await writeHostExecPendingEntry(paths, {
      version: 1,
      sessionId: "sess_a1",
      requestId: "req_1",
      approvalKey: "gcloud",
      ruleId: "gcloud",
      argv0: "gcloud",
      args: [],
      cwd: root,
      state: "pending",
      createdAt: "2026-09-16T04:12:03.114Z",
      updatedAt: "2026-09-16T04:12:03.114Z",
    });
    const lines: string[] = [];
    const warnings: string[] = [];

    await runApprovalWatch(
      "hostexec",
      undefined,
      singleTick(paths, lines, warnings),
    );

    expect(warnings).toEqual([]);
    expect(lines).toEqual([
      '{"event":"added","domain":"hostexec","entry":{"sessionId":"sess_a1","requestId":"req_1"}}\n',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
