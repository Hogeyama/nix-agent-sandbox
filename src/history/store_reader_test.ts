import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  _closeHistoryDb,
  insertSpans,
  insertTurnEvent,
  openHistoryDb,
  queryConversationDetail,
  queryConversationList,
  queryInvocationDetail,
  upsertConversation,
  upsertConversationSummary,
  upsertInvocation,
  upsertTrace,
} from "./store.ts";
import type {
  ConversationRow,
  InvocationRow,
  SpanRow,
  TraceRow,
  TurnEventRow,
} from "./types.ts";

interface TmpHistoryDb {
  dir: string;
  dbPath: string;
}

async function makeTempDb(): Promise<TmpHistoryDb> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-history-reader-"));
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
    agent: "claude",
    firstSeenAt: "2026-05-01T10:00:00Z",
    lastSeenAt: "2026-05-01T10:00:00Z",
    ...overrides,
  };
}

function tr(overrides: Partial<TraceRow> = {}): TraceRow {
  return {
    traceId: "trace_a",
    invocationId: "sess_a",
    conversationId: "conv_a",
    startedAt: "2026-05-01T10:00:00Z",
    endedAt: null,
    ...overrides,
  };
}

function sp(overrides: Partial<SpanRow> = {}): SpanRow {
  return {
    spanId: "span_a",
    parentSpanId: null,
    traceId: "trace_a",
    spanName: "chat",
    kind: "chat",
    model: "claude-sonnet",
    inTok: 100,
    outTok: 200,
    cacheR: 10,
    cacheW: 20,
    durationMs: 1234,
    startedAt: "2026-05-01T10:00:00Z",
    endedAt: "2026-05-01T10:00:01Z",
    attrsJson: "{}",
    ...overrides,
  };
}

function te(overrides: Partial<TurnEventRow> = {}): TurnEventRow {
  return {
    invocationId: "sess_a",
    conversationId: "conv_a",
    ts: "2026-05-01T10:00:00Z",
    kind: "user_prompt",
    payloadJson: "{}",
    ...overrides,
  };
}

test("queryConversationList: empty db returns []", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    expect(queryConversationList(db)).toEqual([]);
  } finally {
    await cleanup(t);
  }
});

test("queryConversationList: aggregates counts and tokens, NULL safe (returns 0)", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv({ id: "sess_a" }));
    upsertConversation(db, conv({ id: "conv_a" }));
    upsertTrace(
      db,
      tr({
        traceId: "trace_a",
        invocationId: "sess_a",
        conversationId: "conv_a",
      }),
    );
    insertSpans(db, [
      sp({
        spanId: "s1",
        traceId: "trace_a",
        inTok: 100,
        outTok: 200,
        cacheR: 10,
        cacheW: 20,
      }),
      sp({
        spanId: "s2",
        traceId: "trace_a",
        inTok: null,
        outTok: null,
        cacheR: null,
        cacheW: null,
      }),
    ]);
    insertTurnEvent(
      db,
      te({ invocationId: "sess_a", conversationId: "conv_a" }),
    );
    insertTurnEvent(
      db,
      te({
        invocationId: "sess_a",
        conversationId: "conv_a",
        kind: "tool_use",
      }),
    );

    // A second conversation with no spans / no events — aggregates must be 0, not NULL.
    upsertConversation(
      db,
      conv({
        id: "conv_b",
        agent: null,
        firstSeenAt: "2026-05-01T09:00:00Z",
        lastSeenAt: "2026-05-01T09:00:00Z",
      }),
    );

    const list = queryConversationList(db);
    expect(list.length).toEqual(2);

    const a = list.find((r) => r.id === "conv_a");
    expect(a).toBeDefined();
    expect(a?.turnEventCount).toEqual(2);
    expect(a?.spanCount).toEqual(2);
    expect(a?.invocationCount).toEqual(1);
    expect(a?.inputTokensTotal).toEqual(100);
    expect(a?.outputTokensTotal).toEqual(200);
    expect(a?.cacheReadTotal).toEqual(10);
    expect(a?.cacheWriteTotal).toEqual(20);
    expect(a?.agent).toEqual("claude");

    const b = list.find((r) => r.id === "conv_b");
    expect(b).toBeDefined();
    expect(b?.turnEventCount).toEqual(0);
    expect(b?.spanCount).toEqual(0);
    expect(b?.invocationCount).toEqual(0);
    expect(b?.inputTokensTotal).toEqual(0);
    expect(b?.outputTokensTotal).toEqual(0);
    expect(b?.cacheReadTotal).toEqual(0);
    expect(b?.cacheWriteTotal).toEqual(0);
    expect(b?.agent).toBeNull();
  } finally {
    await cleanup(t);
  }
});

test("queryConversationList: ORDER BY last_seen_at DESC", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertConversation(
      db,
      conv({
        id: "old",
        lastSeenAt: "2026-01-01T00:00:00Z",
        firstSeenAt: "2026-01-01T00:00:00Z",
      }),
    );
    upsertConversation(
      db,
      conv({
        id: "new",
        lastSeenAt: "2026-05-01T00:00:00Z",
        firstSeenAt: "2026-05-01T00:00:00Z",
      }),
    );
    upsertConversation(
      db,
      conv({
        id: "mid",
        lastSeenAt: "2026-03-01T00:00:00Z",
        firstSeenAt: "2026-03-01T00:00:00Z",
      }),
    );

    const list = queryConversationList(db);
    expect(list.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  } finally {
    await cleanup(t);
  }
});

test("queryConversationList: LIMIT honoured", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    for (let i = 0; i < 3; i++) {
      upsertConversation(
        db,
        conv({
          id: `c${i}`,
          firstSeenAt: `2026-05-01T0${i}:00:00Z`,
          lastSeenAt: `2026-05-01T0${i}:00:00Z`,
        }),
      );
    }
    const list = queryConversationList(db, { limit: 2 });
    expect(list.length).toEqual(2);
  } finally {
    await cleanup(t);
  }
});

test("queryConversationList: uses idx_conversations_lastseen", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertConversation(db, conv());
    const plan = db
      .query(
        "EXPLAIN QUERY PLAN SELECT c.id FROM conversations c ORDER BY c.last_seen_at DESC LIMIT 200",
      )
      .all() as { detail: string }[];
    const planText = plan.map((p) => p.detail).join("\n");
    expect(planText).toContain("idx_conversations_lastseen");
  } finally {
    await cleanup(t);
  }
});

test("queryConversationDetail uses idx_traces_conversation for trace lookup", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    upsertConversation(db, conv());
    upsertTrace(db, tr());
    const plan = db
      .query(
        `EXPLAIN QUERY PLAN
         SELECT t.trace_id FROM traces t
         WHERE t.conversation_id = 'conv_a'
         ORDER BY t.started_at ASC`,
      )
      .all() as { detail: string }[];
    const planText = plan.map((p) => p.detail).join("\n");
    expect(planText).toContain("idx_traces_conversation");
  } finally {
    await cleanup(t);
  }
});

test("queryConversationDetail uses idx_spans_trace via JOIN traces", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv());
    upsertConversation(db, conv());
    upsertTrace(db, tr());
    insertSpans(db, [sp()]);
    const plan = db
      .query(
        `EXPLAIN QUERY PLAN
         SELECT s.span_id
         FROM spans s
         JOIN traces t ON s.trace_id = t.trace_id
         WHERE t.conversation_id = 'conv_a'`,
      )
      .all() as { detail: string }[];
    const planText = plan.map((p) => p.detail).join("\n");
    expect(planText).toContain("idx_spans_trace");
  } finally {
    await cleanup(t);
  }
});

test("queryConversationDetail: returns null for missing id", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    expect(queryConversationDetail(db, "nope")).toBeNull();
  } finally {
    await cleanup(t);
  }
});

test("queryConversationDetail: returns empty traces/spans/turn_events for a bare conversation", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertConversation(db, conv({ id: "conv_bare" }));

    const detail = queryConversationDetail(db, "conv_bare");
    expect(detail).not.toBeNull();
    expect(detail?.conversation.id).toEqual("conv_bare");
    expect(detail?.traces).toEqual([]);
    expect(detail?.spans).toEqual([]);
    expect(detail?.turnEvents).toEqual([]);
    expect(detail?.invocations).toEqual([]);
    // Aggregates default to 0, not NULL.
    expect(detail?.conversation.turnEventCount).toEqual(0);
    expect(detail?.conversation.spanCount).toEqual(0);
    expect(detail?.conversation.invocationCount).toEqual(0);
    expect(detail?.conversation.inputTokensTotal).toEqual(0);
    expect(detail?.conversation.outputTokensTotal).toEqual(0);
    expect(detail?.conversation.cacheReadTotal).toEqual(0);
    expect(detail?.conversation.cacheWriteTotal).toEqual(0);
  } finally {
    await cleanup(t);
  }
});

test("queryConversationDetail: returns conversation + traces + spans + turn_events + invocations", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv({ id: "sess_a" }));
    upsertConversation(db, conv({ id: "conv_a" }));
    upsertTrace(
      db,
      tr({
        traceId: "trace_a",
        invocationId: "sess_a",
        conversationId: "conv_a",
      }),
    );
    insertSpans(db, [
      sp({ spanId: "s1", traceId: "trace_a", inTok: 50, outTok: 60 }),
    ]);
    insertTurnEvent(
      db,
      te({ invocationId: "sess_a", conversationId: "conv_a" }),
    );
    // turn_event whose conversation_id IS NULL — must NOT appear in the detail.
    insertTurnEvent(
      db,
      te({ invocationId: "sess_a", conversationId: null, kind: "stray" }),
    );

    const detail = queryConversationDetail(db, "conv_a");
    expect(detail).not.toBeNull();
    expect(detail?.conversation.id).toEqual("conv_a");
    expect(detail?.conversation.spanCount).toEqual(1);
    expect(detail?.conversation.inputTokensTotal).toEqual(50);
    expect(detail?.traces.length).toEqual(1);
    expect(detail?.traces[0].traceId).toEqual("trace_a");
    expect(detail?.traces[0].spanCount).toEqual(1);
    expect(detail?.spans.length).toEqual(1);
    expect(detail?.spans[0].spanId).toEqual("s1");
    expect(detail?.turnEvents.length).toEqual(1);
    expect(detail?.turnEvents[0].kind).toEqual("user_prompt");
    expect(detail?.invocations.length).toEqual(1);
    expect(detail?.invocations[0].id).toEqual("sess_a");
  } finally {
    await cleanup(t);
  }
});

test("queryConversationDetail: subagent — 1 invocation × 2 conversations, each detail isolates its own data", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv({ id: "sess_x" }));
    upsertConversation(db, conv({ id: "conv_main" }));
    upsertConversation(db, conv({ id: "conv_sub" }));
    upsertTrace(
      db,
      tr({
        traceId: "tr_main",
        invocationId: "sess_x",
        conversationId: "conv_main",
      }),
    );
    upsertTrace(
      db,
      tr({
        traceId: "tr_sub",
        invocationId: "sess_x",
        conversationId: "conv_sub",
      }),
    );
    insertSpans(db, [
      sp({ spanId: "sp_main", traceId: "tr_main", inTok: 11 }),
      sp({ spanId: "sp_sub", traceId: "tr_sub", inTok: 22 }),
    ]);

    const main = queryConversationDetail(db, "conv_main");
    expect(main?.spans.map((s) => s.spanId)).toEqual(["sp_main"]);
    expect(main?.traces.map((tr) => tr.traceId)).toEqual(["tr_main"]);
    expect(main?.conversation.inputTokensTotal).toEqual(11);

    const sub = queryConversationDetail(db, "conv_sub");
    expect(sub?.spans.map((s) => s.spanId)).toEqual(["sp_sub"]);
    expect(sub?.traces.map((tr) => tr.traceId)).toEqual(["tr_sub"]);
    expect(sub?.conversation.inputTokensTotal).toEqual(22);
  } finally {
    await cleanup(t);
  }
});

test("queryInvocationDetail: returns null for missing id", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    expect(queryInvocationDetail(db, "nope")).toBeNull();
  } finally {
    await cleanup(t);
  }
});

test("queryInvocationDetail: collects traces / spans / turn_events / conversations", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, inv({ id: "sess_x" }));
    upsertConversation(db, conv({ id: "conv_main" }));
    upsertConversation(db, conv({ id: "conv_sub" }));
    upsertTrace(
      db,
      tr({
        traceId: "tr_main",
        invocationId: "sess_x",
        conversationId: "conv_main",
      }),
    );
    upsertTrace(
      db,
      tr({
        traceId: "tr_sub",
        invocationId: "sess_x",
        conversationId: "conv_sub",
      }),
    );
    insertSpans(db, [
      sp({ spanId: "sp_main", traceId: "tr_main", inTok: 11 }),
      sp({ spanId: "sp_sub", traceId: "tr_sub", inTok: 22 }),
    ]);
    insertTurnEvent(
      db,
      te({ invocationId: "sess_x", conversationId: "conv_main" }),
    );
    insertTurnEvent(
      db,
      te({ invocationId: "sess_x", conversationId: null, kind: "stray" }),
    );

    const detail = queryInvocationDetail(db, "sess_x");
    expect(detail).not.toBeNull();
    expect(detail?.invocation.id).toEqual("sess_x");
    expect(detail?.traces.map((tr) => tr.traceId).sort()).toEqual([
      "tr_main",
      "tr_sub",
    ]);
    expect(detail?.spans.map((s) => s.spanId).sort()).toEqual([
      "sp_main",
      "sp_sub",
    ]);
    // turn_events on this invocation — both rows including the conversation_id=null one.
    expect(detail?.turnEvents.length).toEqual(2);
    // Subagent fan-out — both conversations referenced by this invocation's traces.
    expect(detail?.conversations.map((c) => c.id).sort()).toEqual([
      "conv_main",
      "conv_sub",
    ]);
  } finally {
    await cleanup(t);
  }
});

test("queryConversationList: summary defaults to null when no row in conversation_summaries", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertConversation(db, conv({ id: "conv_no_sum" }));
    const list = queryConversationList(db);
    expect(list[0].summary).toBeNull();
  } finally {
    await cleanup(t);
  }
});

test("queryConversationList: summary surfaces the upserted value", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertConversation(db, conv({ id: "conv_with_sum" }));
    upsertConversationSummary(db, {
      id: "conv_with_sum",
      summary: "Help me debug the test runner",
      capturedAt: "2026-05-01T10:00:00Z",
    });
    const list = queryConversationList(db);
    expect(list[0].summary).toBe("Help me debug the test runner");
  } finally {
    await cleanup(t);
  }
});

test("upsertConversationSummary: INSERT OR IGNORE — first write wins", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertConversation(db, conv({ id: "conv_idem" }));
    upsertConversationSummary(db, {
      id: "conv_idem",
      summary: "First prompt",
      capturedAt: "2026-05-01T10:00:00Z",
    });
    upsertConversationSummary(db, {
      id: "conv_idem",
      summary: "Different later prompt",
      capturedAt: "2026-05-01T11:00:00Z",
    });
    const list = queryConversationList(db);
    expect(list[0].summary).toBe("First prompt");
  } finally {
    await cleanup(t);
  }
});

test("queryConversationDetail: includes summary in the conversation header", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertConversation(db, conv({ id: "conv_detail_sum" }));
    upsertConversationSummary(db, {
      id: "conv_detail_sum",
      summary: "Original prompt",
      capturedAt: "2026-05-01T10:00:00Z",
    });
    const detail = queryConversationDetail(db, "conv_detail_sum");
    expect(detail?.conversation.summary).toBe("Original prompt");
  } finally {
    await cleanup(t);
  }
});

test("conversation_summaries table is added to existing db on writer re-open", async () => {
  const t = await makeTempDb();
  try {
    // First open: creates db with v1 schema.
    const db1 = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertConversation(db1, conv({ id: "conv_reopen" }));
    _closeHistoryDb(t.dbPath);

    // Second open re-runs SCHEMA_SQL with CREATE TABLE IF NOT EXISTS;
    // user_version stays at 1 so this must succeed.
    const db2 = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    const tables = db2
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'",
      )
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);

    // And it is functional.
    upsertConversationSummary(db2, {
      id: "conv_reopen",
      summary: "after reopen",
      capturedAt: "2026-05-01T10:00:00Z",
    });
    expect(queryConversationList(db2)[0].summary).toBe("after reopen");
  } finally {
    await cleanup(t);
  }
});

test("readonly handle does not block writer cache (separate handles by mode)", async () => {
  const t = await makeTempDb();
  try {
    const writer = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertConversation(writer, conv({ id: "conv_a" }));

    const reader = openHistoryDb({ path: t.dbPath, mode: "readonly" });
    expect(reader).not.toBe(writer);
    // Reader sees the writer's row.
    expect(queryConversationList(reader).map((r) => r.id)).toContain("conv_a");

    // Writer can still write while reader holds its handle.
    upsertConversation(
      writer,
      conv({
        id: "conv_b",
        firstSeenAt: "2026-05-01T11:00:00Z",
        lastSeenAt: "2026-05-01T11:00:00Z",
      }),
    );
    expect(
      queryConversationList(reader)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["conv_a", "conv_b"]);
  } finally {
    await cleanup(t);
  }
});
