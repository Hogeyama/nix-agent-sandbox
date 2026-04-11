import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { SessionRuntimePaths } from "../sessions/store.ts";
import { ensureSessionRuntimePaths, readSession } from "../sessions/store.ts";
import {
  extractHookMessage,
  parseHookKind,
  runHookNotification,
} from "./hook.ts";

const savedEnv = {
  sessionId: process.env.NAS_SESSION_ID,
  storeDir: process.env.NAS_SESSION_STORE_DIR,
};

let tmpRoot: string;
let sessionsDir: string;
let paths: SessionRuntimePaths;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "nas-hook-test-"));
  sessionsDir = path.join(tmpRoot, "sessions");
  // Point the session store at our temp dir via the env var
  // that the store helpers read.
  process.env.NAS_SESSION_STORE_DIR = sessionsDir;
  paths = await ensureSessionRuntimePaths();
});

afterEach(async () => {
  try {
    await rm(tmpRoot, { recursive: true, force: true });
  } finally {
    if (savedEnv.sessionId === undefined) {
      delete process.env.NAS_SESSION_ID;
    } else {
      process.env.NAS_SESSION_ID = savedEnv.sessionId;
    }
    if (savedEnv.storeDir === undefined) {
      delete process.env.NAS_SESSION_STORE_DIR;
    } else {
      process.env.NAS_SESSION_STORE_DIR = savedEnv.storeDir;
    }
  }
});

// --- parseHookKind ---

test("parseHookKind: valid values map to the enum", () => {
  expect(parseHookKind("start")).toBe("start");
  expect(parseHookKind("attention")).toBe("attention");
  expect(parseHookKind("stop")).toBe("stop");
});

test("parseHookKind: undefined / empty / bogus values return null", () => {
  expect(parseHookKind(undefined)).toBeNull();
  expect(parseHookKind("")).toBeNull();
  expect(parseHookKind("bogus")).toBeNull();
  expect(parseHookKind("START")).toBeNull();
});

// --- extractHookMessage ---

test("extractHookMessage: reads payload.message", () => {
  expect(extractHookMessage({ message: "hello" })).toBe("hello");
});

test("extractHookMessage: reads payload.notification.message", () => {
  expect(extractHookMessage({ notification: { message: "nested" } })).toBe(
    "nested",
  );
});

test("extractHookMessage: reads payload.Notification.message", () => {
  expect(extractHookMessage({ Notification: { message: "Capital" } })).toBe(
    "Capital",
  );
});

test("extractHookMessage: non-object payloads return undefined", () => {
  expect(extractHookMessage(null)).toBeUndefined();
  expect(extractHookMessage(undefined)).toBeUndefined();
  expect(extractHookMessage("hello")).toBeUndefined();
  expect(extractHookMessage(42)).toBeUndefined();
  expect(extractHookMessage([])).toBeUndefined();
});

test("extractHookMessage: missing fields return undefined", () => {
  expect(extractHookMessage({})).toBeUndefined();
  expect(extractHookMessage({ notification: {} })).toBeUndefined();
  expect(extractHookMessage({ notification: null })).toBeUndefined();
  expect(extractHookMessage({ message: 42 })).toBeUndefined();
});

test("extractHookMessage: truncates to 200 chars", () => {
  const long = "a".repeat(300);
  const out = extractHookMessage({ message: long });
  expect(out?.length).toBe(200);
  expect(out).toBe("a".repeat(200));
});

test("extractHookMessage: prefers top-level message over nested", () => {
  expect(
    extractHookMessage({
      message: "top",
      notification: { message: "nested" },
    }),
  ).toBe("top");
});

// --- runHookNotification: end-to-end over a temp store dir ---

async function emptyStdin(): Promise<string> {
  return "";
}

function makeStdin(raw: string): () => Promise<string> {
  return async () => raw;
}

test("runHookNotification --kind start transitions pre-created record to agent-turn", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-1";
  // Seed the store with a user-turn record via the store module directly.
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-1",
    agent: "claude",
    profile: "default",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  });

  await runHookNotification(["--kind", "start"], { stdinReader: emptyStdin });

  const record = await readSession(paths, "sess-hook-1");
  expect(record?.turn).toBe("agent-turn");
  expect(record?.lastEventKind).toBe("start");
});

test("runHookNotification --kind attention with stdin message transitions to user-turn and records message", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-2";
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-2",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });
  // Move it to agent-turn so attention has somewhere to transition from.
  const { updateSessionTurn } = await import("../sessions/store.ts");
  await updateSessionTurn(paths, "sess-hook-2", "start");

  await runHookNotification(["--kind", "attention"], {
    stdinReader: makeStdin('{"message":"hello"}'),
  });

  const record = await readSession(paths, "sess-hook-2");
  expect(record?.turn).toBe("user-turn");
  expect(record?.lastEventKind).toBe("attention");
  expect(record?.lastEventMessage).toBe("hello");
});

test("runHookNotification --kind attention without message leaves lastEventMessage empty", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-2b";
  const { createSession, updateSessionTurn } = await import(
    "../sessions/store.ts"
  );
  await createSession(paths, {
    sessionId: "sess-hook-2b",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });
  await updateSessionTurn(paths, "sess-hook-2b", "start");

  await runHookNotification(["--kind", "attention"], {
    stdinReader: emptyStdin,
  });

  const record = await readSession(paths, "sess-hook-2b");
  expect(record?.turn).toBe("user-turn");
  expect(record?.lastEventKind).toBe("attention");
  expect(record?.lastEventMessage).toBeUndefined();
});

test("runHookNotification --kind stop transitions to done", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-3";
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-3",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  await runHookNotification(["--kind", "stop"], { stdinReader: emptyStdin });

  const record = await readSession(paths, "sess-hook-3");
  expect(record?.turn).toBe("done");
});

test("runHookNotification without NAS_SESSION_ID exits cleanly and writes nothing", async () => {
  delete process.env.NAS_SESSION_ID;

  await runHookNotification(["--kind", "start"], { stdinReader: emptyStdin });

  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookNotification with empty NAS_SESSION_ID exits cleanly and writes nothing", async () => {
  process.env.NAS_SESSION_ID = "";

  await runHookNotification(["--kind", "start"], { stdinReader: emptyStdin });

  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookNotification with invalid --kind exits cleanly and writes nothing", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-bad-kind";

  await runHookNotification(["--kind", "bogus"], { stdinReader: emptyStdin });
  // Also test missing --kind entirely.
  await runHookNotification([], { stdinReader: emptyStdin });

  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookNotification rejects NAS_SESSION_ID with path traversal and writes nothing", async () => {
  process.env.NAS_SESSION_ID = "../etc/passwd";

  await runHookNotification(["--kind", "start"], { stdinReader: emptyStdin });

  // Nothing should have been written in our temp sessions dir.
  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookNotification rejects NAS_SESSION_ID containing slash", async () => {
  process.env.NAS_SESSION_ID = "foo/bar";
  await runHookNotification(["--kind", "start"], { stdinReader: emptyStdin });
  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookNotification rejects NAS_SESSION_ID containing backslash", async () => {
  process.env.NAS_SESSION_ID = "foo\\bar";
  await runHookNotification(["--kind", "start"], { stdinReader: emptyStdin });
  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookNotification rejects NAS_SESSION_ID starting with dot", async () => {
  process.env.NAS_SESSION_ID = ".hidden";
  await runHookNotification(["--kind", "start"], { stdinReader: emptyStdin });
  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookNotification tolerates malformed stdin JSON and still updates the store", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-bad-json";
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-bad-json",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  await runHookNotification(["--kind", "start"], {
    stdinReader: makeStdin("{not valid json"),
  });

  const record = await readSession(paths, "sess-hook-bad-json");
  expect(record?.turn).toBe("agent-turn");
});

test("runHookNotification: store update failure is swallowed", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-store-fail";

  // Force the store write to throw by pointing
  // NAS_SESSION_STORE_DIR at a path whose parent is a regular file.
  // `atomicWriteJson` will try to mkdir through a file component
  // and fail with ENOTDIR.
  const blockerFile = path.join(tmpRoot, "blocker-file");
  await writeFile(blockerFile, "not a directory");
  const badStoreDir = path.join(blockerFile, "nested", "sessions");
  process.env.NAS_SESSION_STORE_DIR = badStoreDir;

  let threw: unknown;
  try {
    await runHookNotification(["--kind", "attention"], {
      stdinReader: makeStdin('{"message":"should-not-notify"}'),
    });
  } catch (err) {
    threw = err;
  }

  // Primary guarantee: hook never fails.
  expect(threw).toBeUndefined();

  // And nothing was written into the original (valid) sessions dir either.
  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

// --- runHookCommand dispatcher ---

test("runHookCommand: unknown subcommand is non-fatal (writes nothing)", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-dispatch";
  const { runHookCommand } = await import("./hook.ts");
  await runHookCommand(["bogus-sub"]);
  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookCommand: no subcommand is non-fatal (writes nothing)", async () => {
  const { runHookCommand } = await import("./hook.ts");
  await runHookCommand([]);
  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});
