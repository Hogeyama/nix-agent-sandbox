import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  recordInvocationEnd,
  recordInvocationStart,
  shouldRecordInvocation,
} from "./cli_lifecycle.ts";
import { _resetPruneThrottle } from "./retention.ts";
import {
  _closeHistoryDb,
  insertSpans,
  openHistoryDb,
  upsertConversation,
  upsertInvocation,
  upsertTrace,
} from "./store.ts";

interface CapturedStderr {
  messages: string[];
  restore: () => void;
}

function captureStderr(): CapturedStderr {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map((a) => String(a)).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.error = original;
    },
  };
}

interface TempEnv {
  dir: string;
  dbPath: string;
  prevXdg: string | undefined;
}

async function setupTempXdg(): Promise<TempEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-history-cli-"));
  const prevXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dir;
  return {
    dir,
    dbPath: path.join(dir, "nas", "history.db"),
    prevXdg,
  };
}

async function teardownTempXdg(t: TempEnv): Promise<void> {
  _closeHistoryDb(t.dbPath);
  if (t.prevXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = t.prevXdg;
  await rm(t.dir, { recursive: true, force: true }).catch(() => {});
}

let env: TempEnv;
beforeEach(async () => {
  env = await setupTempXdg();
  // Reset throttle state so each test sees a clean slate; otherwise a prior
  // test's throttle entry for the same XDG path could mask a fresh prune.
  _resetPruneThrottle();
});
afterEach(async () => {
  await teardownTempXdg(env);
});

// ---------------------------------------------------------------------------
// shouldRecordInvocation
// ---------------------------------------------------------------------------

test("shouldRecordInvocation: non-multiplex always records", () => {
  expect(shouldRecordInvocation({ session: { multiplex: false } }, {})).toBe(
    true,
  );
  expect(
    shouldRecordInvocation(
      { session: { multiplex: false } },
      { NAS_INSIDE_DTACH: "1" },
    ),
  ).toBe(true);
});

test("shouldRecordInvocation: multiplex parent (no NAS_INSIDE_DTACH) skips", () => {
  expect(shouldRecordInvocation({ session: { multiplex: true } }, {})).toBe(
    false,
  );
});

test("shouldRecordInvocation: multiplex child (NAS_INSIDE_DTACH=1) records", () => {
  expect(
    shouldRecordInvocation(
      { session: { multiplex: true } },
      { NAS_INSIDE_DTACH: "1" },
    ),
  ).toBe(true);
});

test("shouldRecordInvocation: missing session shape defaults to record", () => {
  expect(shouldRecordInvocation({}, {})).toBe(true);
});

test('shouldRecordInvocation skips parent when NAS_INSIDE_DTACH is set to a value other than "1"', () => {
  // Implementation guards on `!== "1"`, so any other string (including "0",
  // "true", or empty) must still be treated as "parent → skip".
  expect(
    shouldRecordInvocation(
      { session: { multiplex: true } },
      { NAS_INSIDE_DTACH: "0" },
    ),
  ).toBe(false);
  expect(
    shouldRecordInvocation(
      { session: { multiplex: true } },
      { NAS_INSIDE_DTACH: "true" },
    ),
  ).toBe(false);
  expect(
    shouldRecordInvocation(
      { session: { multiplex: true } },
      { NAS_INSIDE_DTACH: "" },
    ),
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// recordInvocationStart / recordInvocationEnd happy path
// ---------------------------------------------------------------------------

test("recordInvocationStart materialises an invocations row", () => {
  const db = recordInvocationStart({
    sessionId: "sess_abc",
    profileName: "dev",
    agent: "claude",
    worktreePath: "/tmp/wt",
    retentionSeconds: null,
  });
  expect(db).not.toBeNull();
  const row = db!
    .query(
      "SELECT id, profile, agent, worktree_path, started_at, ended_at, exit_reason FROM invocations WHERE id = ?",
    )
    .get("sess_abc") as {
    id: string;
    profile: string | null;
    agent: string | null;
    worktree_path: string | null;
    started_at: string;
    ended_at: string | null;
    exit_reason: string | null;
  } | null;
  expect(row?.id).toEqual("sess_abc");
  expect(row?.profile).toEqual("dev");
  expect(row?.agent).toEqual("claude");
  expect(row?.worktree_path).toEqual("/tmp/wt");
  expect(row?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(row?.ended_at).toBeNull();
  expect(row?.exit_reason).toBeNull();
});

test("recordInvocationStart twice with same sessionId preserves started_at", async () => {
  const db1 = recordInvocationStart({
    sessionId: "sess_dup",
    profileName: "dev",
    agent: "claude",
    retentionSeconds: null,
  });
  expect(db1).not.toBeNull();
  const firstStartedAt = (
    db1!
      .query("SELECT started_at FROM invocations WHERE id = ?")
      .get("sess_dup") as { started_at: string }
  ).started_at;

  await new Promise((r) => setTimeout(r, 5));

  const db2 = recordInvocationStart({
    sessionId: "sess_dup",
    profileName: "dev",
    agent: "claude",
    retentionSeconds: null,
  });
  expect(db2).not.toBeNull();
  const secondRow = db2!
    .query("SELECT started_at FROM invocations WHERE id = ?")
    .get("sess_dup") as { started_at: string };
  expect(secondRow.started_at).toEqual(firstStartedAt);
});

test("recordInvocationEnd fills ended_at and exit_reason", () => {
  const db = recordInvocationStart({
    sessionId: "sess_end",
    profileName: "dev",
    agent: "claude",
    retentionSeconds: null,
  });
  expect(db).not.toBeNull();
  recordInvocationEnd(db, { sessionId: "sess_end", exitReason: "ok" });
  const row = db!
    .query("SELECT ended_at, exit_reason FROM invocations WHERE id = ?")
    .get("sess_end") as { ended_at: string; exit_reason: string };
  expect(row.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(row.exit_reason).toEqual("ok");
});

test("recordInvocationEnd with null db is a no-op (no throw)", () => {
  expect(() =>
    recordInvocationEnd(null, { sessionId: "sess_x", exitReason: "ok" }),
  ).not.toThrow();
});

test("recordInvocationEnd error path warns but does not throw", () => {
  // Use an in-memory db without the schema → markInvocationEnded will fail
  // because the `invocations` table does not exist.
  const broken = new Database(":memory:");
  const cap = captureStderr();
  try {
    expect(() =>
      recordInvocationEnd(broken, {
        sessionId: "sess_bad",
        exitReason: "error",
      }),
    ).not.toThrow();
    expect(
      cap.messages.some((m) => m.includes("history invocation end failed")),
    ).toBe(true);
  } finally {
    cap.restore();
    broken.close();
  }
});

// ---------------------------------------------------------------------------
// open failures: best-effort warn + null
// ---------------------------------------------------------------------------

test("recordInvocationStart returns null and warns on schema version mismatch", async () => {
  // Create a valid db, then tamper user_version out-of-band.
  const created = recordInvocationStart({
    sessionId: "sess_v1",
    profileName: "dev",
    agent: "claude",
    retentionSeconds: null,
  });
  expect(created).not.toBeNull();
  _closeHistoryDb(env.dbPath);

  const raw = new Database(env.dbPath);
  raw.run("PRAGMA user_version = 999");
  raw.close();

  const cap = captureStderr();
  try {
    const db = recordInvocationStart({
      sessionId: "sess_v2",
      profileName: "dev",
      agent: "claude",
      retentionSeconds: null,
    });
    expect(db).toBeNull();
    expect(
      cap.messages.some(
        (m) =>
          m.includes("schema version mismatch") &&
          m.includes("newer than this binary") &&
          m.includes("Upgrade nas") &&
          m.includes("Continuing without history"),
      ),
    ).toBe(true);
  } finally {
    cap.restore();
  }
});

test("recordInvocationStart returns null and warns when db open fails", async () => {
  // XDG_DATA_HOME points to a regular file so resolveHistoryDbPath's
  // mkdirSync({ recursive: true }) on the `nas/` subdir under it throws
  // ENOTDIR — that is how this test exercises the open-failed path.
  const file = path.join(env.dir, "not-a-dir");
  await Bun.write(file, "x");
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = file;

  const cap = captureStderr();
  try {
    const db = recordInvocationStart({
      sessionId: "sess_open_fail",
      profileName: "dev",
      agent: "claude",
      retentionSeconds: null,
    });
    expect(db).toBeNull();
    expect(
      cap.messages.some(
        (m) =>
          m.includes("history db open failed") &&
          m.includes("Continuing without history"),
      ),
    ).toBe(true);
  } finally {
    cap.restore();
    process.env.XDG_DATA_HOME = prev;
  }
});

// ---------------------------------------------------------------------------
// retention prune integration
// ---------------------------------------------------------------------------

test("recordInvocationStart with retentionSeconds prunes old records", () => {
  // Seed an old invocation with a related trace + span. We backdate
  // started_at well past any positive retention window the test will use.
  const writer = openHistoryDb({ path: env.dbPath, mode: "readwrite" });
  const oldStartedAt = "2020-01-01T00:00:00.000Z";
  upsertInvocation(writer, {
    id: "old_inv",
    profile: "dev",
    agent: "claude",
    worktreePath: null,
    startedAt: oldStartedAt,
    endedAt: null,
    exitReason: null,
  });
  upsertConversation(writer, {
    id: "old_conv",
    agent: "claude",
    firstSeenAt: oldStartedAt,
    lastSeenAt: oldStartedAt,
  });
  upsertTrace(writer, {
    traceId: "old_trace",
    invocationId: "old_inv",
    conversationId: "old_conv",
    startedAt: oldStartedAt,
    endedAt: null,
  });
  insertSpans(writer, [
    {
      spanId: "old_span",
      parentSpanId: null,
      traceId: "old_trace",
      spanName: "test.span",
      kind: "INTERNAL",
      model: null,
      inTok: null,
      outTok: null,
      cacheR: null,
      cacheW: null,
      durationMs: null,
      startedAt: oldStartedAt,
      endedAt: null,
      attrsJson: "{}",
      eventsJson: null,
    },
  ]);

  // Ensure the throttle does not suppress the prune triggered below.
  _resetPruneThrottle();

  const db = recordInvocationStart({
    sessionId: "new_inv",
    profileName: "dev",
    agent: "claude",
    retentionSeconds: 3600,
  });
  expect(db).not.toBeNull();

  // Old rows pruned (cutoff = now - 1h, oldStartedAt is years earlier).
  const remainingOldInv = db!
    .query("SELECT id FROM invocations WHERE id = ?")
    .get("old_inv");
  expect(remainingOldInv).toBeNull();
  expect(
    db!
      .query("SELECT trace_id FROM traces WHERE trace_id = ?")
      .get("old_trace"),
  ).toBeNull();
  expect(
    db!.query("SELECT span_id FROM spans WHERE span_id = ?").get("old_span"),
  ).toBeNull();

  // The fresh invocation row written by recordInvocationStart survives —
  // prune runs before upsert, and the row's started_at is newer than cutoff.
  const newRow = db!
    .query("SELECT id FROM invocations WHERE id = ?")
    .get("new_inv") as { id: string } | null;
  expect(newRow?.id).toEqual("new_inv");
});

test("recordInvocationStart with retentionSeconds=null does not prune and returns a Database", () => {
  // Seed an old invocation; with retentionSeconds=null the prune branch is
  // skipped entirely, so the row must still be present after the call. This
  // also confirms the returned handle is non-null when the prune is a no-op.
  const writer = openHistoryDb({ path: env.dbPath, mode: "readwrite" });
  const oldStartedAt = "2020-01-01T00:00:00.000Z";
  upsertInvocation(writer, {
    id: "keep_inv",
    profile: "dev",
    agent: "claude",
    worktreePath: null,
    startedAt: oldStartedAt,
    endedAt: null,
    exitReason: null,
  });

  _resetPruneThrottle();

  const db = recordInvocationStart({
    sessionId: "noop_inv",
    profileName: "dev",
    agent: "claude",
    retentionSeconds: null,
  });
  expect(db).not.toBeNull();

  const kept = db!
    .query("SELECT id FROM invocations WHERE id = ?")
    .get("keep_inv") as { id: string } | null;
  expect(kept?.id).toEqual("keep_inv");
});

test("recordInvocationStart writer cache survives within process", () => {
  const a = recordInvocationStart({
    sessionId: "sess_cache_a",
    profileName: "dev",
    agent: "claude",
    retentionSeconds: null,
  });
  const b = recordInvocationStart({
    sessionId: "sess_cache_b",
    profileName: "dev",
    agent: "copilot",
    retentionSeconds: null,
  });
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  // Same cached writer handle for the same path/mode.
  expect(a).toBe(b);
  // Both invocations are visible.
  const reader = openHistoryDb({ path: env.dbPath, mode: "readonly" });
  const ids = (
    reader.query("SELECT id FROM invocations ORDER BY id").all() as {
      id: string;
    }[]
  ).map((r) => r.id);
  expect(ids).toEqual(["sess_cache_a", "sess_cache_b"]);
});
