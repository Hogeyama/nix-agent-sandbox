import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  _closeHistoryDb,
  HISTORY_DB_USER_VERSION,
  HistoryDbVersionMismatchError,
  insertLogRecords,
  insertSpans,
  insertTurnEvent,
  markInvocationEnded,
  openHistoryDb,
  queryConversationDetail,
  queryLogRecordsByConversation,
  upsertConversation,
  upsertConversationSummary,
  upsertInvocation,
  upsertTrace,
} from "./store.ts";
import type {
  ConversationRow,
  InvocationRow,
  LogRecordRow,
  SpanRow,
  TraceRow,
  TurnEventRow,
} from "./types.ts";

interface TmpHistoryDb {
  dir: string;
  dbPath: string;
}

async function makeTempDb(): Promise<TmpHistoryDb> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-history-"));
  return { dir, dbPath: path.join(dir, "history.db") };
}

async function cleanup(t: TmpHistoryDb): Promise<void> {
  _closeHistoryDb(t.dbPath);
  await rm(t.dir, { recursive: true, force: true }).catch(() => {});
}

function inv(overrides: Partial<InvocationRow> = {}): InvocationRow {
  return {
    id: "sess_a",
    profile: "default",
    agent: "claude",
    worktreePath: "/tmp/wt",
    startedAt: "2026-05-01T10:00:00Z",
    endedAt: null,
    exitReason: null,
    ...overrides,
  };
}

function conv(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "conv_a",
    agent: null,
    firstSeenAt: "2026-05-01T10:00:00Z",
    lastSeenAt: "2026-05-01T10:00:00Z",
    ...overrides,
  };
}

function trace(overrides: Partial<TraceRow> = {}): TraceRow {
  return {
    traceId: "trace_a",
    invocationId: "sess_a",
    conversationId: null,
    startedAt: "2026-05-01T10:00:00Z",
    endedAt: null,
    ...overrides,
  };
}

function span(overrides: Partial<SpanRow> = {}): SpanRow {
  return {
    spanId: "span_a",
    parentSpanId: null,
    traceId: "trace_a",
    spanName: "chat",
    kind: "chat",
    model: "claude-sonnet",
    inTok: 100,
    outTok: 200,
    cacheR: 0,
    cacheW: 0,
    durationMs: 1234,
    startedAt: "2026-05-01T10:00:00Z",
    endedAt: "2026-05-01T10:00:01Z",
    attrsJson: "{}",
    eventsJson: null,
    ...overrides,
  };
}

function turn(overrides: Partial<TurnEventRow> = {}): TurnEventRow {
  return {
    invocationId: "sess_a",
    conversationId: null,
    ts: "2026-05-01T10:00:00Z",
    kind: "user_prompt",
    payloadJson: "{}",
    ...overrides,
  };
}

interface CountRow {
  c: number;
}

test("readwrite write is visible to a separate readonly handle (WAL concurrency)", async () => {
  const t = await makeTempDb();
  try {
    const writer = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(writer, inv());

    const reader = openHistoryDb({ path: t.dbPath, mode: "readonly" });
    const row = reader
      .query("SELECT id, profile, started_at FROM invocations WHERE id = ?")
      .get("sess_a") as {
      id: string;
      profile: string | null;
      started_at: string;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.id).toEqual("sess_a");
    expect(row?.profile).toEqual("default");
    expect(row?.started_at).toEqual("2026-05-01T10:00:00Z");
  } finally {
    await cleanup(t);
  }
});

test("upsertInvocation called twice does not overwrite started_at; later non-null fields win", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(
      db,
      inv({ startedAt: "2026-05-01T09:00:00Z", agent: null, profile: null }),
    );
    upsertInvocation(
      db,
      inv({
        startedAt: "2026-05-01T11:00:00Z", // attempted reassignment, ignored
        agent: "claude",
        profile: "wide",
      }),
    );

    const row = db
      .query("SELECT started_at, agent, profile FROM invocations WHERE id = ?")
      .get("sess_a") as {
      started_at: string;
      agent: string | null;
      profile: string | null;
    } | null;
    expect(row?.started_at).toEqual("2026-05-01T09:00:00Z");
    expect(row?.agent).toEqual("claude");
    expect(row?.profile).toEqual("wide");

    const count = db
      .query("SELECT COUNT(*) AS c FROM invocations")
      .get() as CountRow;
    expect(count.c).toEqual(1);
  } finally {
    await cleanup(t);
  }
});

test("markInvocationEnded is idempotent: second call does not change ended_at", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    markInvocationEnded(db, {
      id: "sess_a",
      endedAt: "2026-05-01T10:30:00Z",
      exitReason: "ok",
    });
    markInvocationEnded(db, {
      id: "sess_a",
      endedAt: "2026-05-01T11:00:00Z",
      exitReason: "later",
    });

    const row = db
      .query("SELECT ended_at, exit_reason FROM invocations WHERE id = ?")
      .get("sess_a") as { ended_at: string; exit_reason: string } | null;
    expect(row?.ended_at).toEqual("2026-05-01T10:30:00Z");
    expect(row?.exit_reason).toEqual("ok");
  } finally {
    await cleanup(t);
  }
});

test("upsertTrace: first non-null conversation_id sticks; later writes (null or non-null) cannot mutate it", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    upsertConversation(db, conv({ id: "conv_first" }));
    upsertConversation(db, conv({ id: "conv_other" }));

    // Initial: conversation_id null
    upsertTrace(db, trace({ conversationId: null }));
    let row = db
      .query("SELECT conversation_id FROM traces WHERE trace_id = ?")
      .get("trace_a") as { conversation_id: string | null } | null;
    expect(row?.conversation_id).toBeNull();

    // First non-null write sets it
    upsertTrace(db, trace({ conversationId: "conv_first" }));
    row = db
      .query("SELECT conversation_id FROM traces WHERE trace_id = ?")
      .get("trace_a") as { conversation_id: string | null } | null;
    expect(row?.conversation_id).toEqual("conv_first");

    // Subsequent null does not erase
    upsertTrace(db, trace({ conversationId: null }));
    row = db
      .query("SELECT conversation_id FROM traces WHERE trace_id = ?")
      .get("trace_a") as { conversation_id: string | null } | null;
    expect(row?.conversation_id).toEqual("conv_first");

    // Subsequent non-null also does not overwrite (first wins)
    upsertTrace(db, trace({ conversationId: "conv_other" }));
    row = db
      .query("SELECT conversation_id FROM traces WHERE trace_id = ?")
      .get("trace_a") as { conversation_id: string | null } | null;
    expect(row?.conversation_id).toEqual("conv_first");
  } finally {
    await cleanup(t);
  }
});

test("upsertTrace does not overwrite started_at on later writes", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());

    upsertTrace(db, trace({ startedAt: "2026-05-01T09:00:00Z" }));
    upsertTrace(
      db,
      trace({
        startedAt: "2026-05-01T11:00:00Z", // attempted reassignment, ignored
        endedAt: "2026-05-01T12:00:00Z",
      }),
    );

    const row = db
      .query("SELECT started_at, ended_at FROM traces WHERE trace_id = ?")
      .get("trace_a") as {
      started_at: string;
      ended_at: string | null;
    } | null;
    expect(row?.started_at).toEqual("2026-05-01T09:00:00Z");
    expect(row?.ended_at).toEqual("2026-05-01T12:00:00Z");
  } finally {
    await cleanup(t);
  }
});

test("markInvocationEnded does nothing when invocation row is absent", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });

    // No row exists for "sess_missing"; the UPDATE matches zero rows and returns silently.
    markInvocationEnded(db, {
      id: "sess_missing",
      endedAt: "2026-05-01T10:30:00Z",
      exitReason: "ok",
    });

    const countBefore = db
      .query("SELECT COUNT(*) AS c FROM invocations")
      .get() as CountRow;
    expect(countBefore.c).toEqual(0);

    // Creating the row afterwards does not retroactively pick up the prior call.
    upsertInvocation(db, inv({ id: "sess_missing" }));
    const row = db
      .query("SELECT ended_at, exit_reason FROM invocations WHERE id = ?")
      .get("sess_missing") as {
      ended_at: string | null;
      exit_reason: string | null;
    } | null;
    expect(row?.ended_at).toBeNull();
    expect(row?.exit_reason).toBeNull();
  } finally {
    await cleanup(t);
  }
});

test("upsertConversation: agent COALESCEs from null, then sticks even if a later write is null", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });

    upsertConversation(
      db,
      conv({
        agent: null,
        firstSeenAt: "2026-05-01T10:00:00Z",
        lastSeenAt: "2026-05-01T10:00:00Z",
      }),
    );
    let row = db
      .query(
        "SELECT agent, first_seen_at, last_seen_at FROM conversations WHERE id = ?",
      )
      .get("conv_a") as {
      agent: string | null;
      first_seen_at: string;
      last_seen_at: string;
    } | null;
    expect(row?.agent).toBeNull();

    // Filling in agent
    upsertConversation(
      db,
      conv({
        agent: "claude",
        firstSeenAt: "2026-05-01T11:00:00Z",
        lastSeenAt: "2026-05-01T11:00:00Z",
      }),
    );
    row = db
      .query(
        "SELECT agent, first_seen_at, last_seen_at FROM conversations WHERE id = ?",
      )
      .get("conv_a") as {
      agent: string | null;
      first_seen_at: string;
      last_seen_at: string;
    } | null;
    expect(row?.agent).toEqual("claude");
    // first_seen_at stays at the earlier value, last_seen_at advances
    expect(row?.first_seen_at).toEqual("2026-05-01T10:00:00Z");
    expect(row?.last_seen_at).toEqual("2026-05-01T11:00:00Z");

    // A later null does not erase the agent
    upsertConversation(
      db,
      conv({
        agent: null,
        firstSeenAt: "2026-05-01T12:00:00Z",
        lastSeenAt: "2026-05-01T12:00:00Z",
      }),
    );
    row = db
      .query(
        "SELECT agent, first_seen_at, last_seen_at FROM conversations WHERE id = ?",
      )
      .get("conv_a") as {
      agent: string | null;
      first_seen_at: string;
      last_seen_at: string;
    } | null;
    expect(row?.agent).toEqual("claude");
    expect(row?.first_seen_at).toEqual("2026-05-01T10:00:00Z");
    expect(row?.last_seen_at).toEqual("2026-05-01T12:00:00Z");
  } finally {
    await cleanup(t);
  }
});

test("user_version is stamped to HISTORY_DB_USER_VERSION on writer creation and stays on reopen", async () => {
  const t = await makeTempDb();
  try {
    const writer = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    const v1 = writer.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(v1.user_version).toEqual(HISTORY_DB_USER_VERSION);

    _closeHistoryDb(t.dbPath);

    const writer2 = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    const v2 = writer2.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(v2.user_version).toEqual(HISTORY_DB_USER_VERSION);
  } finally {
    await cleanup(t);
  }
});

test("opening with a mismatched user_version throws HistoryDbVersionMismatchError (writer and reader)", async () => {
  const t = await makeTempDb();
  try {
    // Create a writer once so the file + schema exist.
    openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    _closeHistoryDb(t.dbPath);

    // Tamper user_version through an out-of-band raw handle.
    const raw = new Database(t.dbPath);
    raw.run("PRAGMA user_version = 999");
    raw.close();

    let writerErr: unknown;
    try {
      openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    } catch (e) {
      writerErr = e;
    }
    expect(writerErr).toBeInstanceOf(HistoryDbVersionMismatchError);
    expect((writerErr as HistoryDbVersionMismatchError).actual).toEqual(999);

    let readerErr: unknown;
    try {
      openHistoryDb({ path: t.dbPath, mode: "readonly" });
    } catch (e) {
      readerErr = e;
    }
    expect(readerErr).toBeInstanceOf(HistoryDbVersionMismatchError);
    expect((readerErr as HistoryDbVersionMismatchError).actual).toEqual(999);
  } finally {
    await cleanup(t);
  }
});

test("schema introspection: expected 7 tables and 10 indexes are present", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });

    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const tableNames = tables.map((r) => r.name);
    expect(tableNames).toEqual([
      "conversation_summaries",
      "conversations",
      "invocations",
      "log_records",
      "spans",
      "traces",
      "turn_events",
    ]);

    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const indexNames = indexes.map((r) => r.name);
    expect(indexNames).toEqual([
      "idx_conversations_lastseen",
      "idx_invocations_started",
      "idx_log_records_conv_prompt",
      "idx_log_records_invocation",
      "idx_log_records_request_id",
      "idx_spans_trace",
      "idx_traces_conversation",
      "idx_traces_invocation",
      "idx_turn_events_conversation",
      "idx_turn_events_invocation",
    ]);
  } finally {
    await cleanup(t);
  }
});

test("insertSpans: bulk insert and idempotent replace on same span_id", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    upsertTrace(db, trace());

    insertSpans(db, [
      span({ spanId: "s1" }),
      span({ spanId: "s2", inTok: 50 }),
    ]);
    let count = db.query("SELECT COUNT(*) AS c FROM spans").get() as CountRow;
    expect(count.c).toEqual(2);

    // Replay (e.g. retry) — same ids replace, count unchanged.
    insertSpans(db, [span({ spanId: "s1", inTok: 999 })]);
    count = db.query("SELECT COUNT(*) AS c FROM spans").get() as CountRow;
    expect(count.c).toEqual(2);
    const row = db
      .query("SELECT in_tok FROM spans WHERE span_id = ?")
      .get("s1") as { in_tok: number };
    expect(row.in_tok).toEqual(999);

    // Empty batch is a no-op.
    insertSpans(db, []);
    count = db.query("SELECT COUNT(*) AS c FROM spans").get() as CountRow;
    expect(count.c).toEqual(2);
  } finally {
    await cleanup(t);
  }
});

test("insertTurnEvent: appends rows (no PK; duplicates allowed)", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    insertTurnEvent(db, turn({ kind: "user_prompt" }));
    insertTurnEvent(db, turn({ kind: "user_prompt" }));
    insertTurnEvent(db, turn({ kind: "tool_use" }));

    const count = db
      .query("SELECT COUNT(*) AS c FROM turn_events")
      .get() as CountRow;
    expect(count.c).toEqual(3);
  } finally {
    await cleanup(t);
  }
});

function logRec(overrides: Partial<LogRecordRow> = {}): LogRecordRow {
  return {
    invocationId: "sess_a",
    conversationId: "conv_a",
    promptId: "prompt_1",
    sequence: 0,
    eventName: "user_prompt",
    time: "2026-05-01T10:00:00Z",
    requestId: null,
    attrsJson: "{}",
    ...overrides,
  };
}

test("insertLogRecords: basic CRUD and INSERT OR IGNORE dedup on (conversation_id, sequence)", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    upsertConversation(db, conv());

    // Insert two records with different sequence numbers
    insertLogRecords(db, [
      logRec({ sequence: 0, eventName: "log.start" }),
      logRec({ sequence: 1, eventName: "log.end" }),
    ]);

    let count = db
      .query("SELECT COUNT(*) AS c FROM log_records")
      .get() as CountRow;
    expect(count.c).toEqual(2);

    // INSERT OR IGNORE: same (conversation_id, sequence) — first write wins, count unchanged
    insertLogRecords(db, [
      logRec({ sequence: 0, eventName: "log.start_overwrite_attempt" }),
    ]);
    count = db.query("SELECT COUNT(*) AS c FROM log_records").get() as CountRow;
    expect(count.c).toEqual(2);

    // Verify original event_name was not overwritten
    const row = db
      .query(
        "SELECT event_name FROM log_records WHERE conversation_id = ? AND sequence = ?",
      )
      .get("conv_a", 0) as { event_name: string } | null;
    expect(row?.event_name).toEqual("log.start");

    // Same (conv, seq) but different prompt_id is also deduplicated — first write wins
    insertLogRecords(db, [
      logRec({
        sequence: 0,
        promptId: "prompt_different",
        eventName: "log.start_different_prompt",
      }),
    ]);
    count = db.query("SELECT COUNT(*) AS c FROM log_records").get() as CountRow;
    expect(count.c).toEqual(2);

    const rowAfterDiffPrompt = db
      .query(
        "SELECT event_name, prompt_id FROM log_records WHERE conversation_id = ? AND sequence = ?",
      )
      .get("conv_a", 0) as { event_name: string; prompt_id: string } | null;
    expect(rowAfterDiffPrompt?.event_name).toEqual("log.start");
    expect(rowAfterDiffPrompt?.prompt_id).toEqual("prompt_1");

    // Empty batch is a no-op
    insertLogRecords(db, []);
    count = db.query("SELECT COUNT(*) AS c FROM log_records").get() as CountRow;
    expect(count.c).toEqual(2);
  } finally {
    await cleanup(t);
  }
});

test("insertLogRecords: attrsJson non-empty JSON string round-trips without modification", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    upsertConversation(db, conv());

    const attrsJson = '{"model":"claude-opus-4-5","cost_usd":0.0042}';
    insertLogRecords(db, [logRec({ sequence: 0, attrsJson })]);

    const records = queryLogRecordsByConversation(db, "conv_a");
    expect(records.length).toEqual(1);
    expect(records[0]?.attrsJson).toEqual(attrsJson);
  } finally {
    await cleanup(t);
  }
});

test("insertLogRecords: within a single batch, duplicate (conversation_id, sequence) keeps the first entry and discards the later one", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    upsertConversation(db, conv());

    // Pass two records with the same (conversation_id, sequence) in one call.
    // INSERT OR IGNORE processes rows in order, so the first definition wins.
    insertLogRecords(db, [
      logRec({ sequence: 0, eventName: "log.first_in_batch" }),
      logRec({ sequence: 0, eventName: "log.duplicate_in_batch" }),
    ]);

    const count = db
      .query("SELECT COUNT(*) AS c FROM log_records")
      .get() as CountRow;
    expect(count.c).toEqual(1);

    const row = db
      .query(
        "SELECT event_name FROM log_records WHERE conversation_id = ? AND sequence = ?",
      )
      .get("conv_a", 0) as { event_name: string } | null;
    expect(row?.event_name).toEqual("log.first_in_batch");
  } finally {
    await cleanup(t);
  }
});

test("queryLogRecordsByConversation: returns records ordered by sequence ASC", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    upsertConversation(db, conv());

    // Insert out-of-sequence order with non-monotonic timestamps to confirm
    // that ordering is by sequence, not by time.
    insertLogRecords(db, [
      logRec({
        sequence: 1,
        eventName: "log.second",
        time: "2026-05-01T10:00:02Z",
      }),
      logRec({
        sequence: 0,
        eventName: "log.first",
        time: "2026-05-01T10:00:03Z", // later timestamp but earlier sequence
      }),
      logRec({
        sequence: 2,
        eventName: "log.third",
        time: "2026-05-01T10:00:01Z",
      }),
    ]);

    const records = queryLogRecordsByConversation(db, "conv_a");
    expect(records.length).toEqual(3);
    expect(records[0]?.eventName).toEqual("log.first");
    expect(records[1]?.eventName).toEqual("log.second");
    expect(records[2]?.eventName).toEqual("log.third");

    // Unknown conversation returns empty array
    const empty = queryLogRecordsByConversation(db, "conv_unknown");
    expect(empty).toEqual([]);
  } finally {
    await cleanup(t);
  }
});

test("queryConversationDetail: includes logRecords", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    // queryConversationDetail は trace と conversationSummary が両方存在する場合のみ非 null を返すため、
    // logRecords を検証するにはそれらの事前挿入が必要。
    upsertInvocation(db, inv());
    upsertConversation(db, conv());
    upsertTrace(db, trace({ conversationId: "conv_a" }));
    upsertConversationSummary(db, {
      id: "conv_a",
      summary: "test summary",
      capturedAt: "2026-05-01T10:00:00Z",
    });

    insertLogRecords(db, [
      logRec({ sequence: 0, eventName: "log.event", requestId: "req_1" }),
    ]);

    const detail = queryConversationDetail(db, "conv_a");
    expect(detail).not.toBeNull();
    expect(detail?.logRecords.length).toEqual(1);
    expect(detail?.logRecords[0]?.eventName).toEqual("log.event");
    expect(detail?.logRecords[0]?.requestId).toEqual("req_1");
    expect(detail?.logRecords[0]?.conversationId).toEqual("conv_a");
  } finally {
    await cleanup(t);
  }
});

test("queryConversationDetail: logRecords is empty array when no log_records have been inserted", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    upsertConversation(db, conv());
    upsertTrace(db, trace({ conversationId: "conv_a" }));
    upsertConversationSummary(db, {
      id: "conv_a",
      summary: "test summary",
      capturedAt: "2026-05-01T10:00:00Z",
    });
    // log_records には何も挿入しない

    const detail = queryConversationDetail(db, "conv_a");
    expect(detail).not.toBeNull();
    expect(detail?.logRecords).toEqual([]);
  } finally {
    await cleanup(t);
  }
});

test("queryLogRecordsByConversation: records across multiple prompt_ids are ordered by sequence ASC (conversation-scoped)", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    upsertConversation(db, conv());

    // sequence is conversation-scoped and monotonically increasing across
    // prompt boundaries: prompt_1 uses seq 0-1, prompt_2 continues at 2-3.
    insertLogRecords(db, [
      logRec({
        promptId: "prompt_1",
        sequence: 0,
        eventName: "p1.first",
        time: "2026-05-01T10:00:00Z",
      }),
      logRec({
        promptId: "prompt_1",
        sequence: 1,
        eventName: "p1.second",
        time: "2026-05-01T10:00:01Z",
      }),
      logRec({
        promptId: "prompt_2",
        sequence: 2,
        eventName: "p2.first",
        time: "2026-05-01T10:00:02Z",
      }),
      logRec({
        promptId: "prompt_2",
        sequence: 3,
        eventName: "p2.second",
        time: "2026-05-01T10:00:03Z",
      }),
    ]);

    const records = queryLogRecordsByConversation(db, "conv_a");
    expect(records.length).toEqual(4);
    expect(records[0]?.eventName).toEqual("p1.first");
    expect(records[1]?.eventName).toEqual("p1.second");
    expect(records[2]?.eventName).toEqual("p2.first");
    expect(records[3]?.eventName).toEqual("p2.second");
    // Confirm prompt_id attribution is preserved
    expect(records[0]?.promptId).toEqual("prompt_1");
    expect(records[2]?.promptId).toEqual("prompt_2");
  } finally {
    await cleanup(t);
  }
});

test("insertLogRecords: inserting a record with a non-existent conversation_id throws a FK violation", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    // Deliberately do NOT upsert any conversation

    let err: unknown;
    try {
      insertLogRecords(db, [logRec({ conversationId: "conv_does_not_exist" })]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/FOREIGN KEY|constraint/i);
  } finally {
    await cleanup(t);
  }
});

test("insertLogRecords: inserting a record with a non-existent invocation_id throws a FK violation", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    // conversation exists but invocation does NOT
    upsertConversation(db, conv());

    let err: unknown;
    try {
      insertLogRecords(db, [logRec({ invocationId: "sess_does_not_exist" })]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toMatch(/FOREIGN KEY|constraint/i);
  } finally {
    await cleanup(t);
  }
});
