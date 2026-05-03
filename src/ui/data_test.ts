import { expect, test } from "bun:test";
import { NAS_SESSION_ID_LABEL } from "../docker/nas_resources.ts";
import {
  joinSessionsToContainers,
  type NasContainerInfo,
} from "../domain/container.ts";
import type { SessionRecord } from "../sessions/store.ts";

function makeContainer(
  name: string,
  labels: Record<string, string>,
  overrides: Partial<NasContainerInfo> = {},
): NasContainerInfo {
  return {
    name,
    running: true,
    labels,
    networks: [],
    startedAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeRecord(
  sessionId: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    sessionId,
    agent: "claude",
    profile: "default",
    worktree: "/work/example",
    turn: "agent-turn",
    startedAt: "2026-04-10T00:00:00.000Z",
    lastEventAt: "2026-04-10T00:05:00.000Z",
    lastEventKind: "start",
    lastEventMessage: "working",
    ...overrides,
  };
}

test("joinSessionsToContainers: container with matching session gets fields populated", () => {
  const container = makeContainer("nas-sess1", {
    [NAS_SESSION_ID_LABEL]: "sess1",
  });
  const record = makeRecord("sess1", {
    agent: "claude",
    profile: "strict",
    worktree: "/work/repo",
    turn: "user-turn",
    startedAt: "2026-04-10T00:00:00.000Z",
    lastEventAt: "2026-04-10T01:23:45.000Z",
    lastEventKind: "attention",
    lastEventMessage: "waiting for input",
  });

  const [result] = joinSessionsToContainers([container], [record]);

  expect(result.sessionId).toBe("sess1");
  expect(result.turn).toBe("user-turn");
  expect(result.sessionAgent).toBe("claude");
  expect(result.sessionProfile).toBe("strict");
  expect(result.worktree).toBe("/work/repo");
  expect(result.sessionStartedAt).toBe("2026-04-10T00:00:00.000Z");
  expect(result.lastEventAt).toBe("2026-04-10T01:23:45.000Z");
  expect(result.lastEventKind).toBe("attention");
  expect(result.lastEventMessage).toBe("waiting for input");
  // unchanged base fields
  expect(result.name).toBe("nas-sess1");
  expect(result.running).toBe(true);
  expect(result.labels).toEqual(container.labels);
});

test("joinSessionsToContainers: container without nas.session_id label has no session fields", () => {
  const sidecar = makeContainer("nas-dind", { "some.other.label": "value" });
  const record = makeRecord("sess1");

  const [result] = joinSessionsToContainers([sidecar], [record]);

  expect(result.sessionId).toBeUndefined();
  expect(result.turn).toBeUndefined();
  expect(result.sessionAgent).toBeUndefined();
  expect(result.sessionProfile).toBeUndefined();
  expect(result.worktree).toBeUndefined();
  expect(result.sessionStartedAt).toBeUndefined();
  expect(result.lastEventAt).toBeUndefined();
  expect(result.lastEventKind).toBeUndefined();
  expect(result.lastEventMessage).toBeUndefined();
  // shallow copy, not the same object
  expect(result).not.toBe(sidecar);
  expect(result.name).toBe("nas-dind");
});

test("joinSessionsToContainers: container with orphan nas.session_id label has no session fields", () => {
  const orphan = makeContainer("nas-stale", {
    [NAS_SESSION_ID_LABEL]: "sess-gone",
  });
  const record = makeRecord("sess-alive");

  const [result] = joinSessionsToContainers([orphan], [record]);

  expect(result.sessionId).toBeUndefined();
  expect(result.turn).toBeUndefined();
  expect(result.sessionAgent).toBeUndefined();
  expect(result.sessionProfile).toBeUndefined();
  expect(result.worktree).toBeUndefined();
  expect(result.sessionStartedAt).toBeUndefined();
  expect(result.lastEventAt).toBeUndefined();
  expect(result.lastEventKind).toBeUndefined();
  expect(result.lastEventMessage).toBeUndefined();
  expect(result.name).toBe("nas-stale");
  // label is preserved
  expect(result.labels[NAS_SESSION_ID_LABEL]).toBe("sess-gone");
});

test("joinSessionsToContainers: mixed list — matches some, leaves others untouched", () => {
  const containers: NasContainerInfo[] = [
    makeContainer("nas-sess-a", { [NAS_SESSION_ID_LABEL]: "sess-a" }),
    makeContainer("nas-dind", {}),
    makeContainer("nas-sess-b", { [NAS_SESSION_ID_LABEL]: "sess-b" }),
    makeContainer("nas-orphan", { [NAS_SESSION_ID_LABEL]: "sess-missing" }),
  ];
  const sessions: SessionRecord[] = [
    makeRecord("sess-a", {
      agent: "claude",
      profile: "a-profile",
      turn: "agent-turn",
    }),
    makeRecord("sess-b", {
      agent: "copilot",
      profile: "b-profile",
      turn: "done",
      lastEventKind: "stop",
    }),
    // a session record that has no matching container should be ignored
    makeRecord("sess-unused"),
  ];

  const results = joinSessionsToContainers(containers, sessions);

  expect(results).toHaveLength(4);

  expect(results[0].sessionId).toBe("sess-a");
  expect(results[0].sessionAgent).toBe("claude");
  expect(results[0].sessionProfile).toBe("a-profile");
  expect(results[0].turn).toBe("agent-turn");

  expect(results[1].sessionId).toBeUndefined();
  expect(results[1].turn).toBeUndefined();
  expect(results[1].name).toBe("nas-dind");

  expect(results[2].sessionId).toBe("sess-b");
  expect(results[2].sessionAgent).toBe("copilot");
  expect(results[2].sessionProfile).toBe("b-profile");
  expect(results[2].turn).toBe("done");
  expect(results[2].lastEventKind).toBe("stop");

  expect(results[3].sessionId).toBeUndefined();
  expect(results[3].turn).toBeUndefined();
  expect(results[3].name).toBe("nas-orphan");
});

test("joinSessionsToContainers: empty inputs produce empty output", () => {
  expect(joinSessionsToContainers([], [])).toEqual([]);
  expect(joinSessionsToContainers([], [makeRecord("sess1")])).toEqual([]);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  _closeHistoryDb,
  openHistoryDb,
  upsertConversation,
  upsertInvocation,
  upsertTrace,
} from "../history/store.ts";
import { createDataContext, parseShellSessionId } from "./data.ts";

test("UiDataContext.history: readConversationList round-trips a fixture row", async () => {
  // Drive createDataContext via a temp $XDG_DATA_HOME so we don't touch the
  // real user db.
  const dir = await mkdtemp(path.join(tmpdir(), "nas-uidata-history-"));
  const originalXdg = process.env.XDG_DATA_HOME;
  const dbPath = path.join(dir, "nas", "history.db");
  try {
    process.env.XDG_DATA_HOME = dir;
    const ctx = await createDataContext();
    expect(ctx.historyDbPath).toEqual(dbPath);
    // Empty/no-db case
    expect(ctx.history.readConversationList()).toEqual([]);
    expect(ctx.history.readConversationDetail("x")).toBeNull();
    expect(ctx.history.readInvocationDetail("x")).toBeNull();

    // Write a conversation through a writer handle and read it back via ctx.
    const writer = openHistoryDb({ path: dbPath, mode: "readwrite" });
    upsertConversation(writer, {
      id: "conv_z",
      agent: "claude",
      firstSeenAt: "2026-05-01T10:00:00Z",
      lastSeenAt: "2026-05-01T10:00:00Z",
    });
    upsertInvocation(writer, {
      id: "sess_z",
      profile: "default",
      agent: "claude",
      worktreePath: "/tmp/wt",
      startedAt: "2026-05-01T10:00:00Z",
      endedAt: null,
      exitReason: null,
    });
    upsertTrace(writer, {
      traceId: "trace_z",
      invocationId: "sess_z",
      conversationId: "conv_z",
      startedAt: "2026-05-01T10:00:00Z",
      endedAt: null,
    });
    const list = ctx.history.readConversationList();
    expect(list.map((r) => r.id)).toEqual(["conv_z"]);
  } finally {
    _closeHistoryDb(dbPath);
    if (originalXdg !== undefined) {
      process.env.XDG_DATA_HOME = originalXdg;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("parseShellSessionId: well-formed ids", () => {
  expect(parseShellSessionId("shell-abc.1")).toEqual({
    parentSessionId: "abc",
    seq: 1,
  });
  expect(parseShellSessionId("shell-2026-04-17T12-18-49-960Z.7")).toEqual({
    parentSessionId: "2026-04-17T12-18-49-960Z",
    seq: 7,
  });
});

test("parseShellSessionId: rejects malformed inputs", () => {
  expect(parseShellSessionId("sess-1")).toBeNull();
  expect(parseShellSessionId("shell-abc")).toBeNull();
  expect(parseShellSessionId("shell-abc.")).toBeNull();
  expect(parseShellSessionId("shell-.1")).toBeNull();
  expect(parseShellSessionId("shell-abc.0")).toBeNull();
  expect(parseShellSessionId("shell-abc.xyz")).toBeNull();
  expect(parseShellSessionId("shell-abc.1a")).toBeNull();
});
