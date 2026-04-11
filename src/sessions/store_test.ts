import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createSession,
  deleteSession,
  ensureSessionRuntimePaths,
  listSessions,
  readSession,
  resolveSessionRuntimePaths,
  type SessionRuntimePaths,
  sessionRecordPath,
  updateSessionTurn,
} from "./store.ts";

let tmpRoot: string;
let paths: SessionRuntimePaths;
const savedEnv = process.env.NAS_SESSION_STORE_DIR;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "nas-session-store-test-"));
  // Use a subdirectory and let the helper mkdir it.
  paths = await ensureSessionRuntimePaths(path.join(tmpRoot, "sessions"));
});

afterEach(async () => {
  try {
    await rm(tmpRoot, { recursive: true, force: true });
  } finally {
    if (savedEnv === undefined) {
      delete process.env.NAS_SESSION_STORE_DIR;
    } else {
      process.env.NAS_SESSION_STORE_DIR = savedEnv;
    }
  }
});

test("createSession writes a record with turn=user-turn and lastEventAt=startedAt", async () => {
  const startedAt = "2026-04-11T10:00:00.000Z";
  const record = await createSession(paths, {
    sessionId: "sess-1",
    agent: "claude",
    profile: "default",
    worktree: "/work/foo",
    startedAt,
  });

  expect(record.turn).toBe("user-turn");
  expect(record.lastEventAt).toBe(startedAt);
  expect(record.startedAt).toBe(startedAt);
  expect(record.agent).toBe("claude");
  expect(record.profile).toBe("default");
  expect(record.worktree).toBe("/work/foo");

  // File exists at the expected path.
  const expectedPath = sessionRecordPath(paths, "sess-1");
  expect(expectedPath).toBe(path.join(paths.sessionsDir, "sess-1.json"));
  const onDisk = await readSession(paths, "sess-1");
  expect(onDisk).toEqual(record);
});

test("readSession returns the created record; returns null for missing id", async () => {
  await createSession(paths, {
    sessionId: "sess-1",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  const found = await readSession(paths, "sess-1");
  expect(found?.sessionId).toBe("sess-1");

  const missing = await readSession(paths, "nope");
  expect(missing).toBeNull();
});

test("listSessions returns all records and skips malformed .json files", async () => {
  await createSession(paths, {
    sessionId: "sess-1",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });
  await createSession(paths, {
    sessionId: "sess-2",
    agent: "codex",
    profile: "default",
    startedAt: "2026-04-11T10:05:00.000Z",
  });
  // Drop a malformed JSON file into the directory.
  await writeFile(
    path.join(paths.sessionsDir, "broken.json"),
    "{not valid json",
    { mode: 0o600 },
  );

  const all = await listSessions(paths);
  const ids = all.map((r) => r.sessionId).sort();
  expect(ids).toEqual(["sess-1", "sess-2"]);
});

test("updateSessionTurn start transitions user-turn -> agent-turn and advances lastEventAt", async () => {
  // Use a timestamp safely in the past so the live clock can only move forward.
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const initial = await createSession(paths, {
    sessionId: "sess-1",
    agent: "claude",
    profile: "default",
    startedAt,
  });
  expect(initial.turn).toBe("user-turn");

  const updated = await updateSessionTurn(paths, "sess-1", "start");
  expect(updated.turn).toBe("agent-turn");
  expect(updated.lastEventKind).toBe("start");
  expect(updated.lastEventAt >= initial.lastEventAt).toBe(true);
});

test("updateSessionTurn attention on agent-turn transitions to user-turn and stores message", async () => {
  await createSession(paths, {
    sessionId: "sess-1",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });
  await updateSessionTurn(paths, "sess-1", "start");
  const updated = await updateSessionTurn(
    paths,
    "sess-1",
    "attention",
    "needs review",
  );
  expect(updated.turn).toBe("user-turn");
  expect(updated.lastEventKind).toBe("attention");
  expect(updated.lastEventMessage).toBe("needs review");
});

test("updateSessionTurn clears lastEventMessage when a follow-up event carries none", async () => {
  await createSession(paths, {
    sessionId: "sess-1",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });
  await updateSessionTurn(paths, "sess-1", "start");
  const withMessage = await updateSessionTurn(
    paths,
    "sess-1",
    "attention",
    "needs review",
  );
  expect(withMessage.lastEventMessage).toBe("needs review");
  const afterStart = await updateSessionTurn(paths, "sess-1", "start");
  expect(afterStart.lastEventKind).toBe("start");
  expect(afterStart.lastEventMessage).toBeUndefined();
});

test("updateSessionTurn stop transitions to done", async () => {
  await createSession(paths, {
    sessionId: "sess-1",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });
  const updated = await updateSessionTurn(paths, "sess-1", "stop");
  expect(updated.turn).toBe("done");
  expect(updated.lastEventKind).toBe("stop");
});

test("updateSessionTurn on a missing record creates a partial record with unknown agent/profile", async () => {
  const updated = await updateSessionTurn(
    paths,
    "orphan",
    "attention",
    "hi from outside",
  );
  expect(updated.sessionId).toBe("orphan");
  expect(updated.agent).toBe("unknown");
  expect(updated.profile).toBe("unknown");
  expect(updated.turn).toBe("user-turn");
  expect(updated.lastEventKind).toBe("attention");
  expect(updated.lastEventMessage).toBe("hi from outside");
  expect(typeof updated.startedAt).toBe("string");
  expect(updated.startedAt.length).toBeGreaterThan(0);

  // Persisted on disk.
  const fromDisk = await readSession(paths, "orphan");
  expect(fromDisk).toEqual(updated);
});

test("updateSessionTurn preserves startedAt across transitions", async () => {
  const startedAt = "2026-04-11T10:00:00.000Z";
  await createSession(paths, {
    sessionId: "sess-1",
    agent: "claude",
    profile: "default",
    startedAt,
  });
  const afterStart = await updateSessionTurn(paths, "sess-1", "start");
  expect(afterStart.startedAt).toBe(startedAt);
  const afterAttention = await updateSessionTurn(paths, "sess-1", "attention");
  expect(afterAttention.startedAt).toBe(startedAt);
  const afterStop = await updateSessionTurn(paths, "sess-1", "stop");
  expect(afterStop.startedAt).toBe(startedAt);
});

test("deleteSession removes the file; double delete does not throw", async () => {
  await createSession(paths, {
    sessionId: "sess-1",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });
  expect(await readSession(paths, "sess-1")).not.toBeNull();

  await deleteSession(paths, "sess-1");
  expect(await readSession(paths, "sess-1")).toBeNull();

  // Second delete must not throw.
  await deleteSession(paths, "sess-1");

  const remaining = await readdir(paths.sessionsDir);
  expect(remaining.filter((n) => n === "sess-1.json")).toEqual([]);
});

test("resolveSessionRuntimePaths honors NAS_SESSION_STORE_DIR env var", async () => {
  const envRoot = await mkdtemp(path.join(tmpdir(), "nas-session-env-"));
  const envSessionsDir = path.join(envRoot, "sessions");
  process.env.NAS_SESSION_STORE_DIR = envSessionsDir;
  try {
    const resolved = resolveSessionRuntimePaths();
    expect(resolved.sessionsDir).toBe(envSessionsDir);
    // Pure resolve must not touch the filesystem.
    const rootEntries = await readdir(envRoot);
    expect(rootEntries).toEqual([]);
  } finally {
    await rm(envRoot, { recursive: true, force: true });
  }
});
