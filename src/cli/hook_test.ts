import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { SessionRuntimePaths } from "../sessions/store.ts";
import { ensureSessionRuntimePaths, readSession } from "../sessions/store.ts";
import { extractHookMessage, parseHookKind, runHookCommand } from "./hook.ts";

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

// --- runHookCommand: end-to-end over a temp store dir ---

async function emptyStdin(): Promise<string> {
  return "";
}

function makeStdin(raw: string): () => Promise<string> {
  return async () => raw;
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
