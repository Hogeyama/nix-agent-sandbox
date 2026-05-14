import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  _resetPruneThrottle,
  pruneHistory,
  pruneHistoryWithThrottle,
} from "./retention.ts";
import {
  _closeHistoryDb,
  insertLogRecords,
  insertSpans,
  openHistoryDb,
  upsertConversation,
  upsertInvocation,
  upsertTrace,
} from "./store.ts";

interface OpenedDb {
  db: Database;
  dbPath: string;
  dir: string;
}

const openedDbs: OpenedDb[] = [];

async function freshDb(): Promise<OpenedDb> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-retention-"));
  const dbPath = path.join(dir, "test.db");
  const db = openHistoryDb({ path: dbPath, mode: "readwrite" });
  const opened = { db, dbPath, dir };
  openedDbs.push(opened);
  return opened;
}

afterEach(async () => {
  _resetPruneThrottle();
  while (openedDbs.length > 0) {
    const { dbPath, dir } = openedDbs.pop()!;
    _closeHistoryDb(dbPath);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

interface SeedOptions {
  invocationId: string;
  conversationId: string;
  traceId: string;
  startedAt: string;
  lastSeenAt?: string;
  withLogRecord?: boolean;
  withSpan?: boolean;
}

function seed(db: Database, opts: SeedOptions): void {
  upsertInvocation(db, {
    id: opts.invocationId,
    profile: null,
    agent: null,
    worktreePath: null,
    startedAt: opts.startedAt,
    endedAt: null,
    exitReason: null,
  });
  upsertConversation(db, {
    id: opts.conversationId,
    agent: null,
    firstSeenAt: opts.startedAt,
    lastSeenAt: opts.lastSeenAt ?? opts.startedAt,
  });
  upsertTrace(db, {
    traceId: opts.traceId,
    invocationId: opts.invocationId,
    conversationId: opts.conversationId,
    startedAt: opts.startedAt,
    endedAt: null,
  });
  if (opts.withSpan) {
    insertSpans(db, [
      {
        spanId: `span-${opts.traceId}`,
        parentSpanId: null,
        traceId: opts.traceId,
        spanName: "test.span",
        kind: "INTERNAL",
        model: null,
        inTok: null,
        outTok: null,
        cacheR: null,
        cacheW: null,
        durationMs: null,
        startedAt: opts.startedAt,
        endedAt: null,
        attrsJson: "{}",
        eventsJson: null,
      },
    ]);
  }
  if (opts.withLogRecord) {
    insertLogRecords(db, [
      {
        invocationId: opts.invocationId,
        conversationId: opts.conversationId,
        promptId: `prompt-${opts.traceId}`,
        sequence: 1,
        eventName: "test.event",
        time: opts.startedAt,
        requestId: null,
        attrsJson: "{}",
      },
    ]);
  }
}

function countRows(db: Database, table: string): number {
  const row = db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
    c: number;
  };
  return row.c;
}

test("pruneHistory: empty db returns zero counts", async () => {
  const { db } = await freshDb();
  const result = pruneHistory(db, 3600, new Date("2026-05-15T12:00:00.000Z"));
  expect(result).toEqual({ invocationsDeleted: 0, conversationsDeleted: 0 });
});

test("pruneHistory: strictly less than cutoff (boundary)", async () => {
  const { db } = await freshDb();
  const now = new Date("2026-05-15T12:00:00.000Z");
  // retention 3600s → cutoff = 11:00:00.000Z
  const atCutoff = "2026-05-15T11:00:00.000Z";
  const justBefore = "2026-05-15T10:59:59.999Z";

  seed(db, {
    invocationId: "inv-at-cutoff",
    conversationId: "conv-at-cutoff",
    traceId: "trace-at-cutoff",
    startedAt: atCutoff,
  });
  seed(db, {
    invocationId: "inv-just-before",
    conversationId: "conv-just-before",
    traceId: "trace-just-before",
    startedAt: justBefore,
  });

  const result = pruneHistory(db, 3600, now);
  expect(result.invocationsDeleted).toEqual(1);
  expect(result.conversationsDeleted).toEqual(1);

  const remainingInv = db
    .query("SELECT id FROM invocations ORDER BY id")
    .all() as { id: string }[];
  expect(remainingInv).toEqual([{ id: "inv-at-cutoff" }]);
});

test("pruneHistory: cascades children for old invocations", async () => {
  const { db } = await freshDb();
  const now = new Date("2026-05-15T12:00:00.000Z");
  const old = "2026-05-15T00:00:00.000Z";
  const recent = "2026-05-15T11:30:00.000Z";

  seed(db, {
    invocationId: "inv-old",
    conversationId: "conv-old",
    traceId: "trace-old",
    startedAt: old,
    withLogRecord: true,
    withSpan: true,
  });
  seed(db, {
    invocationId: "inv-new",
    conversationId: "conv-new",
    traceId: "trace-new",
    startedAt: recent,
    withLogRecord: true,
    withSpan: true,
  });

  const result = pruneHistory(db, 3600, now);
  expect(result).toEqual({ invocationsDeleted: 1, conversationsDeleted: 1 });

  expect(countRows(db, "invocations")).toEqual(1);
  expect(countRows(db, "conversations")).toEqual(1);
  expect(countRows(db, "traces")).toEqual(1);
  expect(countRows(db, "spans")).toEqual(1);
  expect(countRows(db, "log_records")).toEqual(1);

  const remainingInv = db.query("SELECT id FROM invocations").get() as {
    id: string;
  };
  expect(remainingInv.id).toEqual("inv-new");
});

test("pruneHistory: deletes orphaned old conversation", async () => {
  const { db } = await freshDb();
  const now = new Date("2026-05-15T12:00:00.000Z");
  const old = "2026-05-15T00:00:00.000Z";

  // Old conversation with no trace at all (orphaned from the start).
  upsertConversation(db, {
    id: "conv-orphan",
    agent: null,
    firstSeenAt: old,
    lastSeenAt: old,
  });

  const result = pruneHistory(db, 3600, now);
  expect(result.conversationsDeleted).toEqual(1);
  expect(countRows(db, "conversations")).toEqual(0);
});

test("pruneHistory: preserves old conversation that still has a surviving trace", async () => {
  const { db } = await freshDb();
  const now = new Date("2026-05-15T12:00:00.000Z");
  const old = "2026-05-15T00:00:00.000Z";
  const recent = "2026-05-15T11:30:00.000Z";

  // Conversation is old by last_seen_at, but a newer invocation/trace
  // references it — so the trace survives the prune and protects the
  // conversation row.
  upsertConversation(db, {
    id: "conv-shared",
    agent: null,
    firstSeenAt: old,
    lastSeenAt: old,
  });
  upsertInvocation(db, {
    id: "inv-recent",
    profile: null,
    agent: null,
    worktreePath: null,
    startedAt: recent,
    endedAt: null,
    exitReason: null,
  });
  upsertTrace(db, {
    traceId: "trace-recent",
    invocationId: "inv-recent",
    conversationId: "conv-shared",
    startedAt: recent,
    endedAt: null,
  });

  const result = pruneHistory(db, 3600, now);
  expect(result.invocationsDeleted).toEqual(0);
  expect(result.conversationsDeleted).toEqual(0);
  expect(countRows(db, "conversations")).toEqual(1);
});

test("pruneHistory: preserves conversation with recent last_seen_at even when no trace", async () => {
  const { db } = await freshDb();
  const now = new Date("2026-05-15T12:00:00.000Z");
  const recent = "2026-05-15T11:30:00.000Z";

  upsertConversation(db, {
    id: "conv-recent",
    agent: null,
    firstSeenAt: recent,
    lastSeenAt: recent,
  });

  const result = pruneHistory(db, 3600, now);
  expect(result.conversationsDeleted).toEqual(0);
  expect(countRows(db, "conversations")).toEqual(1);
});

test("pruneHistory: foreign_keys ON cascade runs without FK violation", async () => {
  const { db } = await freshDb();
  // Confirm the writer left foreign_keys enabled — this is the precondition
  // that makes child-first deletion necessary.
  const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
  expect(fk.foreign_keys).toEqual(1);

  const now = new Date("2026-05-15T12:00:00.000Z");
  const old = "2026-05-15T00:00:00.000Z";

  seed(db, {
    invocationId: "inv-old",
    conversationId: "conv-old",
    traceId: "trace-old",
    startedAt: old,
    withLogRecord: true,
    withSpan: true,
  });

  expect(() => pruneHistory(db, 3600, now)).not.toThrow();
  expect(countRows(db, "invocations")).toEqual(0);
});

test("pruneHistory: retentionSeconds <= 0 is a no-op", async () => {
  const { db } = await freshDb();
  const now = new Date("2026-05-15T12:00:00.000Z");
  const old = "2026-05-15T00:00:00.000Z";

  seed(db, {
    invocationId: "inv-old",
    conversationId: "conv-old",
    traceId: "trace-old",
    startedAt: old,
  });

  expect(pruneHistory(db, 0, now)).toEqual({
    invocationsDeleted: 0,
    conversationsDeleted: 0,
  });
  expect(pruneHistory(db, -1, now)).toEqual({
    invocationsDeleted: 0,
    conversationsDeleted: 0,
  });
  expect(countRows(db, "invocations")).toEqual(1);
  expect(countRows(db, "conversations")).toEqual(1);
});

test("pruneHistory: returned counts match number of rows actually deleted", async () => {
  const { db } = await freshDb();
  const now = new Date("2026-05-15T12:00:00.000Z");
  const old = "2026-05-15T00:00:00.000Z";

  for (let i = 0; i < 3; i++) {
    seed(db, {
      invocationId: `inv-${i}`,
      conversationId: `conv-${i}`,
      traceId: `trace-${i}`,
      startedAt: old,
    });
  }
  // One orphan conversation that is also old.
  upsertConversation(db, {
    id: "conv-orphan",
    agent: null,
    firstSeenAt: old,
    lastSeenAt: old,
  });

  const result = pruneHistory(db, 3600, now);
  expect(result.invocationsDeleted).toEqual(3);
  // 3 from seeded conversations + 1 orphan = 4.
  expect(result.conversationsDeleted).toEqual(4);
});

test("pruneHistoryWithThrottle: second call within window is skipped", async () => {
  const { db, dbPath } = await freshDb();
  const now = new Date("2026-05-15T12:00:00.000Z");

  const first = pruneHistoryWithThrottle(db, dbPath, 3600, now);
  expect(first.skipped).toEqual(false);

  const second = pruneHistoryWithThrottle(db, dbPath, 3600, now);
  expect(second).toEqual({
    invocationsDeleted: 0,
    conversationsDeleted: 0,
    skipped: true,
  });
});

test("pruneHistoryWithThrottle: _resetPruneThrottle re-enables the next call", async () => {
  const { db, dbPath } = await freshDb();
  const now = new Date("2026-05-15T12:00:00.000Z");

  pruneHistoryWithThrottle(db, dbPath, 3600, now);
  _resetPruneThrottle();
  const second = pruneHistoryWithThrottle(db, dbPath, 3600, now);
  expect(second.skipped).toEqual(false);
});

test("pruneHistoryWithThrottle: minIntervalMs override allows quick re-run", async () => {
  const { db, dbPath } = await freshDb();
  const t0 = new Date("2026-05-15T12:00:00.000Z");
  const t1 = new Date("2026-05-15T12:00:00.005Z");

  const first = pruneHistoryWithThrottle(db, dbPath, 3600, t0, 1);
  expect(first.skipped).toEqual(false);
  const second = pruneHistoryWithThrottle(db, dbPath, 3600, t1, 1);
  expect(second.skipped).toEqual(false);
});

test("pruneHistoryWithThrottle: distinct dbPaths share no state", async () => {
  const a = await freshDb();
  const b = await freshDb();
  const now = new Date("2026-05-15T12:00:00.000Z");

  expect(pruneHistoryWithThrottle(a.db, a.dbPath, 3600, now).skipped).toEqual(
    false,
  );
  // Other path is unaffected by the first prune.
  expect(pruneHistoryWithThrottle(b.db, b.dbPath, 3600, now).skipped).toEqual(
    false,
  );
  // But repeating on a still skips.
  expect(pruneHistoryWithThrottle(a.db, a.dbPath, 3600, now).skipped).toEqual(
    true,
  );
});

test("pruneHistoryWithThrottle: retentionSeconds <= 0 returns zero and does not poison throttle", async () => {
  const { db, dbPath } = await freshDb();
  const now = new Date("2026-05-15T12:00:00.000Z");

  const zero = pruneHistoryWithThrottle(db, dbPath, 0, now);
  expect(zero).toEqual({
    invocationsDeleted: 0,
    conversationsDeleted: 0,
    skipped: false,
  });
  // A subsequent positive call still runs (throttle map was not touched).
  const positive = pruneHistoryWithThrottle(db, dbPath, 3600, now);
  expect(positive.skipped).toEqual(false);
});

test("pruneHistoryWithThrottle: throw inside pruneHistory does not poison the throttle map", async () => {
  const { db, dbPath } = await freshDb();
  const now1 = new Date("2026-05-15T12:00:00.000Z");
  const now2 = new Date("2026-05-15T12:00:00.001Z");

  // Drop a table that pruneHistory unconditionally touches when
  // retentionSeconds > 0, so the inner transaction throws before reaching
  // the `lastPrunedAt.set(...)` line. If the throttle map were updated
  // before/regardless of the throw, the second call below would observe
  // `skipped: true` instead of running.
  db.run("DROP TABLE log_records");

  expect(() => pruneHistoryWithThrottle(db, dbPath, 3600, now1)).toThrow();

  // Restore the dropped table so the second call can run cleanly. We use
  // the same schema as the v3 migration; this is intentionally a minimal
  // re-create rather than re-running applyMigrations, because we only need
  // the table to exist for pruneHistory's DELETE statement to succeed.
  db.run(`
    CREATE TABLE log_records (
      invocation_id    TEXT NOT NULL REFERENCES invocations(id),
      conversation_id  TEXT NOT NULL REFERENCES conversations(id),
      prompt_id        TEXT NOT NULL,
      sequence         INTEGER NOT NULL,
      event_name       TEXT NOT NULL,
      time             TEXT NOT NULL,
      request_id       TEXT,
      attrs_json       TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (conversation_id, sequence)
    )
  `);

  // If the throttle map was poisoned by the previous failed run, this call
  // would short-circuit with skipped:true. The contract is that a failed
  // prune leaves the map untouched so the next call retries.
  const second = pruneHistoryWithThrottle(db, dbPath, 3600, now2);
  expect(second.skipped).toEqual(false);
});
