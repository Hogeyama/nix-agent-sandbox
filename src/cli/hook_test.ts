import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { recordInvocationStart } from "../history/cli_lifecycle.ts";
import {
  _closeHistoryDb,
  openHistoryDb,
  resolveHistoryDbPath,
} from "../history/store.ts";
import type { SessionRuntimePaths } from "../sessions/store.ts";
import { ensureSessionRuntimePaths, readSession } from "../sessions/store.ts";
import {
  extractConversationId,
  extractFirstUserPrompt,
  extractHookMessage,
  extractTranscriptPath,
  parseHookKind,
  runHookCommand,
} from "./hook.ts";

const savedEnv = {
  sessionId: process.env.NAS_SESSION_ID,
  storeDir: process.env.NAS_SESSION_STORE_DIR,
  xdgData: process.env.XDG_DATA_HOME,
};

let tmpRoot: string;
let sessionsDir: string;
let paths: SessionRuntimePaths;
let historyDbPath: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "nas-hook-test-"));
  sessionsDir = path.join(tmpRoot, "sessions");
  // Point the session store at our temp dir via the env var
  // that the store helpers read.
  process.env.NAS_SESSION_STORE_DIR = sessionsDir;
  // Redirect history.db to a per-test temp path so the hook's
  // appendTurnEvent does not touch the user's real ~/.local/share/nas.
  process.env.XDG_DATA_HOME = tmpRoot;
  historyDbPath = resolveHistoryDbPath();
  paths = await ensureSessionRuntimePaths();
});

afterEach(async () => {
  try {
    _closeHistoryDb(historyDbPath);
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
    if (savedEnv.xdgData === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = savedEnv.xdgData;
    }
  }
});

interface TurnEventRowDb {
  invocation_id: string;
  conversation_id: string | null;
  ts: string;
  kind: string;
  payload_json: string;
}

function readTurnEvents(invocationId: string): TurnEventRowDb[] {
  const db = openHistoryDb({ path: historyDbPath, mode: "readonly" });
  return db
    .query(
      "SELECT invocation_id, conversation_id, ts, kind, payload_json FROM turn_events WHERE invocation_id = ? ORDER BY ts, rowid",
    )
    .all(invocationId) as TurnEventRowDb[];
}

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

// --- runHookCommand: end-to-end over a temp store dir ---

async function emptyStdin(): Promise<string> {
  return "";
}

function makeStdin(raw: string): () => Promise<string> {
  return async () => raw;
}

const noopNotify = () => {};

// Seed an invocations row so the FK on turn_events.invocation_id is satisfied.
// In production, recordInvocationStart runs before any hook fires (cli.ts);
// in tests we replicate that contract.
function seedInvocation(sessionId: string): void {
  const db = recordInvocationStart({
    sessionId,
    profileName: "default",
    agent: "claude",
  });
  expect(db).not.toBeNull();
}

test("runHookCommand --kind start transitions pre-created record to agent-turn", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-1";
  // Seed the store with a user-turn record via the store module directly.
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-1",
    agent: "claude",
    profile: "default",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  });

  await runHookCommand(["--kind", "start"], { stdinReader: emptyStdin });

  const record = await readSession(paths, "sess-hook-1");
  expect(record?.turn).toBe("agent-turn");
  expect(record?.lastEventKind).toBe("start");
});

test("runHookCommand --kind attention with stdin message transitions to user-turn and records message", async () => {
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

  await runHookCommand(["--kind", "attention"], {
    stdinReader: makeStdin('{"message":"hello"}'),
    notifySender: noopNotify,
  });

  const record = await readSession(paths, "sess-hook-2");
  expect(record?.turn).toBe("user-turn");
  expect(record?.lastEventKind).toBe("attention");
  expect(record?.lastEventMessage).toBe("hello");
});

test("runHookCommand applies --when toolName=ask_user", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-when-tool";
  const { createSession, updateSessionTurn } = await import(
    "../sessions/store.ts"
  );
  await createSession(paths, {
    sessionId: "sess-hook-when-tool",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });
  await updateSessionTurn(paths, "sess-hook-when-tool", "start");

  await runHookCommand(["--kind", "attention", "--when", "toolName=ask_user"], {
    stdinReader: makeStdin('{"toolName":"ask_user","message":"hello"}'),
    notifySender: noopNotify,
  });

  const record = await readSession(paths, "sess-hook-when-tool");
  expect(record?.turn).toBe("user-turn");
  expect(record?.lastEventKind).toBe("attention");
  expect(record?.lastEventMessage).toBe("hello");
});

test("runHookCommand applies --when stopReason=end_turn", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-when-stop";
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-when-stop",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  await runHookCommand(
    ["--kind", "attention", "--when", "stopReason=end_turn"],
    {
      stdinReader: makeStdin('{"stopReason":"end_turn","message":"done"}'),
      notifySender: noopNotify,
    },
  );

  const record = await readSession(paths, "sess-hook-when-stop");
  expect(record?.turn).toBe("user-turn");
  expect(record?.lastEventKind).toBe("attention");
  expect(record?.lastEventMessage).toBe("done");
});

test("runHookCommand --kind attention without message leaves lastEventMessage empty", async () => {
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

  await runHookCommand(["--kind", "attention"], {
    stdinReader: emptyStdin,
    notifySender: noopNotify,
  });

  const record = await readSession(paths, "sess-hook-2b");
  expect(record?.turn).toBe("user-turn");
  expect(record?.lastEventKind).toBe("attention");
  expect(record?.lastEventMessage).toBeUndefined();
});

test("runHookCommand with mismatched --when leaves the store untouched", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-when-mismatch";
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-when-mismatch",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  const before = await readSession(paths, "sess-hook-when-mismatch");

  await runHookCommand(
    ["--kind", "attention", "--when", "toolResult.resultType=success"],
    {
      stdinReader: makeStdin(
        '{"toolResult":{"resultType":"failure"},"message":"ignored"}',
      ),
    },
  );

  const after = await readSession(paths, "sess-hook-when-mismatch");
  expect(after).toEqual(before);
});

test("runHookCommand --kind stop transitions to done", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-3";
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-3",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  await runHookCommand(["--kind", "stop"], { stdinReader: emptyStdin });

  const record = await readSession(paths, "sess-hook-3");
  expect(record?.turn).toBe("done");
});

test("runHookCommand without NAS_SESSION_ID exits cleanly and writes nothing", async () => {
  delete process.env.NAS_SESSION_ID;

  await runHookCommand(["--kind", "start"], { stdinReader: emptyStdin });

  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookCommand with empty NAS_SESSION_ID exits cleanly and writes nothing", async () => {
  process.env.NAS_SESSION_ID = "";

  await runHookCommand(["--kind", "start"], { stdinReader: emptyStdin });

  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookCommand with invalid --kind exits cleanly and writes nothing", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-bad-kind";

  await runHookCommand(["--kind", "bogus"], { stdinReader: emptyStdin });
  // Also test missing --kind entirely.
  await runHookCommand([], { stdinReader: emptyStdin });

  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookCommand rejects NAS_SESSION_ID with path traversal and writes nothing", async () => {
  process.env.NAS_SESSION_ID = "../etc/passwd";

  await runHookCommand(["--kind", "start"], { stdinReader: emptyStdin });

  // Nothing should have been written in our temp sessions dir.
  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookCommand rejects NAS_SESSION_ID containing slash", async () => {
  process.env.NAS_SESSION_ID = "foo/bar";
  await runHookCommand(["--kind", "start"], { stdinReader: emptyStdin });
  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookCommand rejects NAS_SESSION_ID containing backslash", async () => {
  process.env.NAS_SESSION_ID = "foo\\bar";
  await runHookCommand(["--kind", "start"], { stdinReader: emptyStdin });
  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookCommand rejects NAS_SESSION_ID starting with dot", async () => {
  process.env.NAS_SESSION_ID = ".hidden";
  await runHookCommand(["--kind", "start"], { stdinReader: emptyStdin });
  const entries = await readdir(sessionsDir);
  expect(entries.length).toBe(0);
});

test("runHookCommand tolerates malformed stdin JSON and still updates the store", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-bad-json";
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-bad-json",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  await runHookCommand(["--kind", "start"], {
    stdinReader: makeStdin("{not valid json"),
  });

  const record = await readSession(paths, "sess-hook-bad-json");
  expect(record?.turn).toBe("agent-turn");
});

test("runHookCommand with malformed --when warns and is a no-op", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-bad-when";
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-bad-when",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  const before = await readSession(paths, "sess-hook-bad-when");
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };

  let threw: unknown;
  try {
    await runHookCommand(["--kind", "attention", "--when", "toolName"], {
      stdinReader: makeStdin('{"toolName":"ask_user"}'),
    });
  } catch (err) {
    threw = err;
  } finally {
    console.error = originalError;
  }

  const after = await readSession(paths, "sess-hook-bad-when");
  expect(threw).toBeUndefined();
  expect(after).toEqual(before);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("invalid --when");
});

test("runHookCommand with missing --when value warns and is a no-op", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-missing-when";
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-missing-when",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  const before = await readSession(paths, "sess-hook-missing-when");
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };

  let threw: unknown;
  try {
    await runHookCommand(["--kind", "attention", "--when"], {
      stdinReader: makeStdin('{"toolName":"ask_user"}'),
    });
  } catch (err) {
    threw = err;
  } finally {
    console.error = originalError;
  }

  const after = await readSession(paths, "sess-hook-missing-when");
  expect(threw).toBeUndefined();
  expect(after).toEqual(before);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("missing value for --when");
});

test("runHookCommand: store update failure is swallowed", async () => {
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
    await runHookCommand(["--kind", "attention"], {
      stdinReader: makeStdin('{"message":"should-not-notify"}'),
      notifySender: noopNotify,
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

// --- fireAttentionNotification (via notifySender dep) ---

test("attention hook fires desktop notification by default", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-notify-default";
  const { createSession, updateSessionTurn } = await import(
    "../sessions/store.ts"
  );
  await createSession(paths, {
    sessionId: "sess-hook-notify-default",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });
  await updateSessionTurn(paths, "sess-hook-notify-default", "start");

  const calls: { title: string; body: string }[] = [];
  await runHookCommand(["--kind", "attention"], {
    stdinReader: makeStdin('{"message":"please review"}'),
    notifySender: (title, body) => calls.push({ title, body }),
  });

  // Allow the fire-and-forget async to settle.
  await Bun.sleep(50);

  expect(calls).toHaveLength(1);
  expect(calls[0].title).toContain("sess-hook-notify-default");
  expect(calls[0].body).toBe("please review");
});

test("attention hook fires notification with fallback body when no message", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-notify-no-msg";
  const { createSession, updateSessionTurn } = await import(
    "../sessions/store.ts"
  );
  await createSession(paths, {
    sessionId: "sess-hook-notify-no-msg",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });
  await updateSessionTurn(paths, "sess-hook-notify-no-msg", "start");

  const calls: { title: string; body: string }[] = [];
  await runHookCommand(["--kind", "attention"], {
    stdinReader: emptyStdin,
    notifySender: (title, body) => calls.push({ title, body }),
  });

  await Bun.sleep(50);

  expect(calls).toHaveLength(1);
  expect(calls[0].body).toBe("Agent is waiting for input.");
});

test("attention hook suppressed when hookNotify is off", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-notify-off";
  const { createSession, updateSessionTurn } = await import(
    "../sessions/store.ts"
  );
  await createSession(paths, {
    sessionId: "sess-hook-notify-off",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
    hookNotify: "off",
  });
  await updateSessionTurn(paths, "sess-hook-notify-off", "start");

  const calls: { title: string; body: string }[] = [];
  await runHookCommand(["--kind", "attention"], {
    stdinReader: makeStdin('{"message":"hello"}'),
    notifySender: (title, body) => calls.push({ title, body }),
  });

  await Bun.sleep(50);

  expect(calls).toHaveLength(0);
});

test("start/stop hooks do not fire notification", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-notify-start";
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-notify-start",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  const calls: { title: string; body: string }[] = [];
  const deps = {
    stdinReader: emptyStdin,
    notifySender: (title: string, body: string) => calls.push({ title, body }),
  };

  await runHookCommand(["--kind", "start"], deps);
  await runHookCommand(["--kind", "stop"], deps);
  await Bun.sleep(50);

  expect(calls).toHaveLength(0);
});

// --- extractConversationId ---

test("extractConversationId: snake_case session_id (Claude)", () => {
  expect(extractConversationId({ session_id: "conv_xxx" })).toBe("conv_xxx");
});

test("extractConversationId: camelCase sessionId (Copilot)", () => {
  expect(extractConversationId({ sessionId: "conv_yyy" })).toBe("conv_yyy");
});

test("extractConversationId: snake_case wins over camelCase when both present", () => {
  expect(
    extractConversationId({ session_id: "snake", sessionId: "camel" }),
  ).toBe("snake");
});

test("extractConversationId: empty string is treated as absent", () => {
  expect(extractConversationId({ session_id: "", sessionId: "fallback" })).toBe(
    "fallback",
  );
  expect(extractConversationId({ session_id: "", sessionId: "" })).toBeNull();
});

test("extractConversationId: non-string ids are rejected", () => {
  expect(extractConversationId({ session_id: 42 })).toBeNull();
  expect(extractConversationId({ sessionId: null })).toBeNull();
  expect(extractConversationId({ session_id: { x: 1 } })).toBeNull();
});

test("extractConversationId: missing fields and non-objects return null", () => {
  expect(extractConversationId({})).toBeNull();
  expect(extractConversationId(null)).toBeNull();
  expect(extractConversationId(undefined)).toBeNull();
  expect(extractConversationId("hi")).toBeNull();
  expect(extractConversationId(42)).toBeNull();
  expect(extractConversationId([])).toBeNull();
});

// --- runHookCommand: turn_events history persistence ---

test("runHookCommand persists turn_event with Claude session_id", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-claude";
  seedInvocation("sess-hook-claude");
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-claude",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  await runHookCommand(["--kind", "start"], {
    stdinReader: makeStdin('{"session_id":"conv_xxx","other":"data"}'),
  });

  const rows = readTurnEvents("sess-hook-claude");
  expect(rows).toHaveLength(1);
  expect(rows[0].conversation_id).toBe("conv_xxx");
  expect(rows[0].kind).toBe("start");
  expect(JSON.parse(rows[0].payload_json)).toEqual({
    session_id: "conv_xxx",
    other: "data",
  });
});

test("runHookCommand persists turn_event with Copilot sessionId", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-copilot";
  seedInvocation("sess-hook-copilot");
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-copilot",
    agent: "copilot",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  await runHookCommand(["--kind", "attention"], {
    stdinReader: makeStdin('{"sessionId":"conv_yyy","message":"hi"}'),
    notifySender: noopNotify,
  });

  const rows = readTurnEvents("sess-hook-copilot");
  expect(rows).toHaveLength(1);
  expect(rows[0].conversation_id).toBe("conv_yyy");
  expect(rows[0].kind).toBe("attention");
});

test("runHookCommand prefers snake_case over camelCase when payload has both", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-both";
  seedInvocation("sess-hook-both");
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-both",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  await runHookCommand(["--kind", "start"], {
    stdinReader: makeStdin('{"session_id":"x","sessionId":"y"}'),
  });

  const rows = readTurnEvents("sess-hook-both");
  expect(rows).toHaveLength(1);
  expect(rows[0].conversation_id).toBe("x");
});

test("runHookCommand persists turn_event with NULL conversation_id when payload lacks session id", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-noconv";
  seedInvocation("sess-hook-noconv");
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-noconv",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  await runHookCommand(["--kind", "start"], {
    stdinReader: makeStdin('{"unrelated":"data"}'),
  });

  const rows = readTurnEvents("sess-hook-noconv");
  expect(rows).toHaveLength(1);
  expect(rows[0].conversation_id).toBeNull();

  // No conversations row should be created when conversation_id is null.
  const reader = openHistoryDb({ path: historyDbPath, mode: "readonly" });
  const convCount = (
    reader.query("SELECT COUNT(*) AS n FROM conversations").get() as {
      n: number;
    }
  ).n;
  expect(convCount).toBe(0);
});

test("runHookCommand without NAS_SESSION_ID writes no turn_event", async () => {
  delete process.env.NAS_SESSION_ID;

  await runHookCommand(["--kind", "start"], {
    stdinReader: makeStdin('{"session_id":"orphan"}'),
  });

  // history.db may not exist at all because nothing wrote to it.
  // openHistoryDb readonly throws on missing file; assert no rows when present.
  let rowCount = 0;
  try {
    const reader = openHistoryDb({ path: historyDbPath, mode: "readonly" });
    rowCount = (
      reader.query("SELECT COUNT(*) AS n FROM turn_events").get() as {
        n: number;
      }
    ).n;
  } catch {
    rowCount = 0;
  }
  expect(rowCount).toBe(0);
});

test("runHookCommand with history db schema mismatch exits 0 and writes no turn_event", async () => {
  // Pre-create the history.db with a wrong user_version so openHistoryDb
  // throws HistoryDbVersionMismatchError during the hook's append step.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(historyDbPath), { recursive: true });
  const { Database } = await import("bun:sqlite");
  const raw = new Database(historyDbPath, { create: true });
  raw.run("PRAGMA user_version = 999");
  raw.close();

  process.env.NAS_SESSION_ID = "sess-hook-schemafail";
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-schemafail",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };

  let threw: unknown;
  try {
    await runHookCommand(["--kind", "start"], {
      stdinReader: makeStdin('{"session_id":"conv_z"}'),
    });
  } catch (err) {
    threw = err;
  } finally {
    console.error = originalError;
  }

  // Hook never fails the agent.
  expect(threw).toBeUndefined();
  // Schema-mismatch warning was emitted.
  expect(
    errors.some(
      (m) =>
        m.includes("schema version mismatch") &&
        m.includes("Skipping turn_event"),
    ),
  ).toBe(true);

  // The session store update path is unaffected.
  const record = await readSession(paths, "sess-hook-schemafail");
  expect(record?.turn).toBe("agent-turn");
});

// --- extractTranscriptPath ---

test("extractTranscriptPath: snake_case transcript_path (Claude)", () => {
  expect(extractTranscriptPath({ transcript_path: "/tmp/x.jsonl" })).toBe(
    "/tmp/x.jsonl",
  );
});

test("extractTranscriptPath: missing field returns null", () => {
  expect(extractTranscriptPath({})).toBeNull();
  expect(extractTranscriptPath({ session_id: "x" })).toBeNull();
});

test("extractTranscriptPath: non-object / empty / non-string return null", () => {
  expect(extractTranscriptPath(null)).toBeNull();
  expect(extractTranscriptPath(undefined)).toBeNull();
  expect(extractTranscriptPath([])).toBeNull();
  expect(extractTranscriptPath({ transcript_path: "" })).toBeNull();
  expect(extractTranscriptPath({ transcript_path: 42 })).toBeNull();
});

// --- runHookCommand: conversation_summary persistence ---

interface SummaryRowDb {
  id: string;
  summary: string;
  captured_at: string;
}

function readSummary(id: string): SummaryRowDb | null {
  const db = openHistoryDb({ path: historyDbPath, mode: "readonly" });
  return (
    (db
      .query(
        "SELECT id, summary, captured_at FROM conversation_summaries WHERE id = ?",
      )
      .get(id) as SummaryRowDb | null) ?? null
  );
}

test("runHookCommand persists conversation summary when Claude payload carries transcript_path", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-trans";
  seedInvocation("sess-hook-trans");
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-trans",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  const transcriptFile = path.join(tmpRoot, "transcript.jsonl");
  await writeFile(
    transcriptFile,
    `${JSON.stringify({
      type: "user",
      message: { content: "Refactor the auth flow" },
    })}\n`,
  );

  await runHookCommand(["--kind", "start"], {
    stdinReader: makeStdin(
      JSON.stringify({
        session_id: "conv_trans",
        transcript_path: transcriptFile,
      }),
    ),
  });

  const row = readSummary("conv_trans");
  expect(row?.summary).toBe("Refactor the auth flow");
});

test("runHookCommand: payload without transcript_path leaves conversation_summaries empty", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-no-trans";
  seedInvocation("sess-hook-no-trans");
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-no-trans",
    agent: "copilot",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  await runHookCommand(["--kind", "start"], {
    stdinReader: makeStdin('{"sessionId":"conv_no_trans"}'),
  });

  expect(readSummary("conv_no_trans")).toBeNull();
});

test("runHookCommand: missing transcript file does not fail the hook", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-trans-missing";
  seedInvocation("sess-hook-trans-missing");
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-trans-missing",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  let threw: unknown;
  try {
    await runHookCommand(["--kind", "start"], {
      stdinReader: makeStdin(
        JSON.stringify({
          session_id: "conv_trans_missing",
          transcript_path: path.join(tmpRoot, "no-such-file.jsonl"),
        }),
      ),
    });
  } catch (e) {
    threw = e;
  }

  expect(threw).toBeUndefined();
  expect(readSummary("conv_trans_missing")).toBeNull();
});

// Subagent observation: ADR §"turn_events への conversation_id 付与" notes
// that subagent hook events fire under the *parent* session id. Subagent
// internal LLM/tool calls flow through OTLP with the subagent's own
// conversation_id, so the two are naturally separated; here we only assert
// the hook side, which always sees the parent.
test("runHookCommand: subagent hook events land on the parent conversation_id", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-subagent";
  seedInvocation("sess-hook-subagent");
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-subagent",
    agent: "claude",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  // Two consecutive hooks under the same parent session_id.
  await runHookCommand(["--kind", "start"], {
    stdinReader: makeStdin('{"session_id":"conv_parent","step":"outer"}'),
  });
  await runHookCommand(["--kind", "start"], {
    stdinReader: makeStdin('{"session_id":"conv_parent","step":"inner"}'),
  });

  const rows = readTurnEvents("sess-hook-subagent");
  expect(rows).toHaveLength(2);
  expect(rows[0].conversation_id).toBe("conv_parent");
  expect(rows[1].conversation_id).toBe("conv_parent");
});

// --- extractFirstUserPrompt ---

test("extractFirstUserPrompt: Claude payload with transcript_path reads JSONL", async () => {
  const file = path.join(tmpRoot, "et-claude.jsonl");
  await writeFile(
    file,
    `${JSON.stringify({
      type: "user",
      message: { content: "hello from transcript" },
    })}\n`,
  );
  expect(extractFirstUserPrompt({ transcript_path: file }, "start")).toBe(
    "hello from transcript",
  );
});

test("extractFirstUserPrompt: Copilot payload with prompt returns the string", () => {
  expect(extractFirstUserPrompt({ prompt: "Hello, Copilot." }, "start")).toBe(
    "Hello, Copilot.",
  );
});

test("extractFirstUserPrompt: Copilot prompt is whitespace-normalized and truncated to the summary cap", () => {
  const long = `${"x".repeat(400)}`;
  const out = extractFirstUserPrompt({ prompt: long }, "start");
  expect(out).not.toBeNull();
  expect(out).toHaveLength(240);
  expect(out?.endsWith("…")).toBe(true);
});

test("extractFirstUserPrompt: collapses runs of whitespace in Copilot prompt", () => {
  expect(extractFirstUserPrompt({ prompt: "one\n\ntwo\tthree" }, "start")).toBe(
    "one two three",
  );
});

test("extractFirstUserPrompt: empty / non-string prompt returns null", () => {
  expect(extractFirstUserPrompt({ prompt: "" }, "start")).toBeNull();
  expect(extractFirstUserPrompt({ prompt: "   " }, "start")).toBeNull();
  expect(extractFirstUserPrompt({ prompt: 42 }, "start")).toBeNull();
  expect(extractFirstUserPrompt({ prompt: null }, "start")).toBeNull();
});

test("extractFirstUserPrompt: kind != start returns null even when fields are present", async () => {
  const file = path.join(tmpRoot, "et-attention.jsonl");
  await writeFile(
    file,
    `${JSON.stringify({
      type: "user",
      message: { content: "should be ignored" },
    })}\n`,
  );
  expect(
    extractFirstUserPrompt({ transcript_path: file }, "attention"),
  ).toBeNull();
  expect(
    extractFirstUserPrompt({ prompt: "should be ignored" }, "stop"),
  ).toBeNull();
});

test("extractFirstUserPrompt: transcript_path wins when both transcript_path and prompt present", async () => {
  const file = path.join(tmpRoot, "et-both.jsonl");
  await writeFile(
    file,
    `${JSON.stringify({
      type: "user",
      message: { content: "from transcript" },
    })}\n`,
  );
  expect(
    extractFirstUserPrompt(
      { transcript_path: file, prompt: "from prompt" },
      "start",
    ),
  ).toBe("from transcript");
});

test("extractFirstUserPrompt: falls back to payload.prompt when transcript_path yields nothing", async () => {
  // Empty transcript file — Claude's first SessionStart hook fires before
  // the user's opening prompt is written to the JSONL.
  const file = path.join(tmpRoot, "et-empty.jsonl");
  await writeFile(file, "");
  expect(
    extractFirstUserPrompt(
      { transcript_path: file, prompt: "from prompt" },
      "start",
    ),
  ).toBe("from prompt");
});

test("extractFirstUserPrompt: falls back to payload.prompt when transcript file is missing", () => {
  const missing = path.join(tmpRoot, "et-missing.jsonl");
  expect(
    extractFirstUserPrompt(
      { transcript_path: missing, prompt: "from prompt" },
      "start",
    ),
  ).toBe("from prompt");
});

test("extractFirstUserPrompt: payload missing both fields returns null", () => {
  expect(extractFirstUserPrompt({}, "start")).toBeNull();
  expect(extractFirstUserPrompt({ session_id: "x" }, "start")).toBeNull();
  expect(extractFirstUserPrompt(null, "start")).toBeNull();
  expect(extractFirstUserPrompt(undefined, "start")).toBeNull();
  expect(extractFirstUserPrompt([], "start")).toBeNull();
});

// --- runHookCommand: Copilot conversation_summary persistence ---

test("runHookCommand persists Copilot conversation summary from payload.prompt", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-copilot-prompt";
  seedInvocation("sess-hook-copilot-prompt");
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-copilot-prompt",
    agent: "copilot",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  await runHookCommand(["--kind", "start"], {
    stdinReader: makeStdin(
      JSON.stringify({
        sessionId: "conv_copilot_prompt",
        prompt: "Add a Copilot integration test",
      }),
    ),
  });

  const row = readSummary("conv_copilot_prompt");
  expect(row?.summary).toBe("Add a Copilot integration test");
});

test("runHookCommand: Copilot fires twice; INSERT OR IGNORE keeps the first prompt", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-copilot-twice";
  seedInvocation("sess-hook-copilot-twice");
  const { createSession } = await import("../sessions/store.ts");
  await createSession(paths, {
    sessionId: "sess-hook-copilot-twice",
    agent: "copilot",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });

  await runHookCommand(["--kind", "start"], {
    stdinReader: makeStdin(
      JSON.stringify({
        sessionId: "conv_copilot_twice",
        prompt: "First prompt",
      }),
    ),
  });
  await runHookCommand(["--kind", "start"], {
    stdinReader: makeStdin(
      JSON.stringify({
        sessionId: "conv_copilot_twice",
        prompt: "Second prompt should be ignored",
      }),
    ),
  });

  const row = readSummary("conv_copilot_twice");
  expect(row?.summary).toBe("First prompt");
});

test("runHookCommand: kind=attention with Copilot prompt does not write a summary", async () => {
  process.env.NAS_SESSION_ID = "sess-hook-copilot-attn";
  seedInvocation("sess-hook-copilot-attn");
  const { createSession, updateSessionTurn } = await import(
    "../sessions/store.ts"
  );
  await createSession(paths, {
    sessionId: "sess-hook-copilot-attn",
    agent: "copilot",
    profile: "default",
    startedAt: "2026-04-11T10:00:00.000Z",
  });
  await updateSessionTurn(paths, "sess-hook-copilot-attn", "start");

  await runHookCommand(["--kind", "attention"], {
    stdinReader: makeStdin(
      JSON.stringify({
        sessionId: "conv_copilot_attn",
        prompt: "should not become a summary",
      }),
    ),
    notifySender: noopNotify,
  });

  expect(readSummary("conv_copilot_attn")).toBeNull();
});
