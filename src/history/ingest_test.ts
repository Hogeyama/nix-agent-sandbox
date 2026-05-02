import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ingestResourceSpans, type OtlpJsonExportPayload } from "./ingest.ts";
import {
  _closeHistoryDb,
  openHistoryDb,
  queryConversationList,
  upsertInvocation,
} from "./store.ts";

interface TmpHistoryDb {
  dir: string;
  dbPath: string;
}

async function makeTempDb(): Promise<TmpHistoryDb> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-history-ingest-"));
  return { dir, dbPath: path.join(dir, "history.db") };
}

async function cleanup(t: TmpHistoryDb): Promise<void> {
  _closeHistoryDb(t.dbPath);
  await rm(t.dir, { recursive: true, force: true }).catch(() => {});
}

const FIXTURES = path.join(import.meta.dir, "fixtures");

async function loadFixture(name: string): Promise<OtlpJsonExportPayload> {
  const buf = await readFile(path.join(FIXTURES, name), "utf8");
  return JSON.parse(buf) as OtlpJsonExportPayload;
}

interface CountRow {
  c: number;
}

test("copilot_chat_minimal: 3 spans / 1 trace / 1 conversation; classifications and token columns populated", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, {
      id: "sess_aaa",
      profile: "default",
      agent: "copilot",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });

    const payload = await loadFixture("copilot_chat_minimal.json");
    const result = ingestResourceSpans(db, payload);

    expect(result.acceptedSpans).toEqual(3);
    expect(result.droppedTraces).toEqual(0);
    expect(result.resolvedConversations).toEqual(1);

    const traces = db
      .query(
        "SELECT trace_id, invocation_id, conversation_id FROM traces ORDER BY trace_id",
      )
      .all() as {
      trace_id: string;
      invocation_id: string;
      conversation_id: string | null;
    }[];
    expect(traces).toEqual([
      {
        trace_id: "trace_copilot_1",
        invocation_id: "sess_aaa",
        conversation_id: "conv_copilot_1",
      },
    ]);

    const convs = db
      .query("SELECT id, agent FROM conversations ORDER BY id")
      .all() as { id: string; agent: string | null }[];
    expect(convs).toEqual([{ id: "conv_copilot_1", agent: "copilot" }]);

    const spans = db
      .query(
        "SELECT span_id, span_name, kind, model, in_tok, out_tok, attrs_json FROM spans ORDER BY started_at",
      )
      .all() as {
      span_id: string;
      span_name: string;
      kind: string;
      model: string | null;
      in_tok: number | null;
      out_tok: number | null;
      attrs_json: string;
    }[];
    expect(spans.length).toEqual(3);
    expect(spans[0].kind).toEqual("invoke_agent");
    expect(spans[1].kind).toEqual("chat");
    expect(spans[1].model).toEqual("gpt-4");
    expect(spans[1].in_tok).toEqual(100);
    expect(spans[1].out_tok).toEqual(50);
    expect(spans[2].kind).toEqual("execute_tool");

    // attrs_json must be valid JSON.
    for (const s of spans) {
      const parsed = JSON.parse(s.attrs_json) as Record<string, unknown>;
      expect(typeof parsed).toEqual("object");
    }
  } finally {
    await cleanup(t);
  }
});

test("claude_llm_request_minimal: 2 spans, kinds chat/execute_tool, cache_r/cache_w populated", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, {
      id: "sess_bbb",
      profile: "default",
      agent: "claude",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });

    const payload = await loadFixture("claude_llm_request_minimal.json");
    const result = ingestResourceSpans(db, payload);
    expect(result.acceptedSpans).toEqual(2);
    expect(result.resolvedConversations).toEqual(1);

    const spans = db
      .query(
        "SELECT span_id, span_name, kind, model, in_tok, out_tok, cache_r, cache_w FROM spans ORDER BY started_at",
      )
      .all() as {
      span_id: string;
      span_name: string;
      kind: string;
      model: string | null;
      in_tok: number | null;
      out_tok: number | null;
      cache_r: number | null;
      cache_w: number | null;
    }[];

    expect(spans[0].span_name).toEqual("claude_code.llm_request");
    expect(spans[0].kind).toEqual("chat");
    expect(spans[0].model).toEqual("claude-opus-4-7");
    expect(spans[0].in_tok).toEqual(200);
    expect(spans[0].out_tok).toEqual(100);
    expect(spans[0].cache_r).toEqual(80);
    expect(spans[0].cache_w).toEqual(20);

    expect(spans[1].span_name).toEqual("claude_code.tool");
    expect(spans[1].kind).toEqual("execute_tool");

    const conv = db
      .query("SELECT id, agent FROM conversations WHERE id = ?")
      .get("conv_claude_1") as { id: string; agent: string | null } | null;
    expect(conv?.agent).toEqual("claude");
  } finally {
    await cleanup(t);
  }
});

test("claude_llm_request_flat_tokens: token columns populated from unprefixed attribute names", async () => {
  // Real-world Claude Code emits `input_tokens` etc. without the
  // `gen_ai.usage.` semconv prefix; the ingester must read those too.
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, {
      id: "sess_flat",
      profile: "default",
      agent: "claude",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });

    const payload = await loadFixture("claude_llm_request_flat_tokens.json");
    const result = ingestResourceSpans(db, payload);
    expect(result.acceptedSpans).toEqual(1);

    const span = db
      .query(
        "SELECT in_tok, out_tok, cache_r, cache_w FROM spans WHERE span_id = ?",
      )
      .get("span_claude_flat_llm") as {
      in_tok: number | null;
      out_tok: number | null;
      cache_r: number | null;
      cache_w: number | null;
    };
    expect(span.in_tok).toEqual(201);
    expect(span.out_tok).toEqual(101);
    expect(span.cache_r).toEqual(81);
    expect(span.cache_w).toEqual(21);
  } finally {
    await cleanup(t);
  }
});

test("codex_otel_minimal: Codex spans classify, resolve fallback ids, and promote tokens without double counting", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, {
      id: "sess_codex",
      profile: "default",
      agent: "codex",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });

    const payload = await loadFixture("codex_otel_minimal.json");
    const result = ingestResourceSpans(db, payload);

    expect(result.acceptedSpans).toEqual(6);
    expect(result.droppedTraces).toEqual(0);
    expect(result.resolvedConversations).toEqual(2);

    const traces = db
      .query("SELECT trace_id, conversation_id FROM traces ORDER BY trace_id")
      .all() as { trace_id: string; conversation_id: string | null }[];
    expect(traces).toEqual([
      {
        trace_id: "trace_codex_conversation",
        conversation_id: "conv_codex_1",
      },
      {
        trace_id: "trace_codex_thread",
        conversation_id: "thread_codex_1",
      },
    ]);

    const spans = db
      .query(
        `SELECT span_id, span_name, kind, model, in_tok, out_tok, cache_r, cache_w
           FROM spans
          ORDER BY started_at`,
      )
      .all() as {
      span_id: string;
      span_name: string;
      kind: string;
      model: string | null;
      in_tok: number | null;
      out_tok: number | null;
      cache_r: number | null;
      cache_w: number | null;
    }[];
    expect(spans).toEqual([
      {
        span_id: "span_codex_turn",
        span_name: "session_task.turn",
        kind: "invoke_agent",
        model: null,
        in_tok: null,
        out_tok: null,
        cache_r: null,
        cache_w: null,
      },
      {
        span_id: "span_codex_response",
        span_name: "model_client.stream_responses_websocket",
        kind: "chat",
        model: null,
        in_tok: null,
        out_tok: null,
        cache_r: null,
        cache_w: null,
      },
      {
        span_id: "span_codex_usage",
        span_name: "codex.turn.token_usage",
        kind: "chat",
        model: "gpt-5.5",
        in_tok: 1200,
        out_tok: 345,
        cache_r: 90,
        cache_w: 12,
      },
      {
        span_id: "span_codex_mcp",
        span_name: "mcp.tools.call",
        kind: "execute_tool",
        model: null,
        in_tok: null,
        out_tok: null,
        cache_r: null,
        cache_w: null,
      },
      {
        span_id: "span_codex_user_shell",
        span_name: "session_task.user_shell",
        kind: "execute_tool",
        model: null,
        in_tok: null,
        out_tok: null,
        cache_r: null,
        cache_w: null,
      },
      {
        span_id: "span_codex_review",
        span_name: "session_task.review",
        kind: "invoke_agent",
        model: null,
        in_tok: null,
        out_tok: null,
        cache_r: null,
        cache_w: null,
      },
    ]);

    const threadConversation = queryConversationList(db).find(
      (row) => row.id === "thread_codex_1",
    );
    expect(threadConversation?.inputTokensTotal).toEqual(1200);
    expect(threadConversation?.outputTokensTotal).toEqual(345);
    expect(threadConversation?.cacheReadTotal).toEqual(90);
    expect(threadConversation?.cacheWriteTotal).toEqual(12);
  } finally {
    await cleanup(t);
  }
});

test("codex response span promotes model and tokens when no token_usage span exists in the trace", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, {
      id: "sess_codex_response",
      profile: "default",
      agent: "codex",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });

    const payload: OtlpJsonExportPayload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "nas.session.id",
                value: { stringValue: "sess_codex_response" },
              },
              { key: "nas.agent", value: { stringValue: "codex" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace_codex_response_only",
                  spanId: "span_codex_response_only",
                  name: "responses.stream_request",
                  startTimeUnixNano: "1714570100000000000",
                  endTimeUnixNano: "1714570101000000000",
                  attributes: [
                    {
                      key: "conversation.id",
                      value: { stringValue: "conv_codex_response_only" },
                    },
                    {
                      key: "gen_ai.response.model",
                      value: { stringValue: "gpt-5.5" },
                    },
                    {
                      key: "gen_ai.usage.input_tokens",
                      value: { intValue: "77" },
                    },
                    {
                      key: "gen_ai.usage.output_tokens",
                      value: { intValue: "33" },
                    },
                    {
                      key: "gen_ai.usage.cache_read.input_tokens",
                      value: { intValue: "11" },
                    },
                    {
                      key: "gen_ai.usage.cache_creation.input_tokens",
                      value: { intValue: "5" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestResourceSpans(db, payload);
    expect(result.acceptedSpans).toEqual(1);
    expect(result.droppedTraces).toEqual(0);
    expect(result.resolvedConversations).toEqual(1);

    const span = db
      .query(
        `SELECT span_name, kind, model, in_tok, out_tok, cache_r, cache_w
           FROM spans
          WHERE span_id = ?`,
      )
      .get("span_codex_response_only") as {
      span_name: string;
      kind: string;
      model: string | null;
      in_tok: number | null;
      out_tok: number | null;
      cache_r: number | null;
      cache_w: number | null;
    };
    expect(span).toEqual({
      span_name: "responses.stream_request",
      kind: "chat",
      model: "gpt-5.5",
      in_tok: 77,
      out_tok: 33,
      cache_r: 11,
      cache_w: 5,
    });

    const conv = queryConversationList(db).find(
      (row) => row.id === "conv_codex_response_only",
    );
    expect(conv?.inputTokensTotal).toEqual(77);
    expect(conv?.outputTokensTotal).toEqual(33);
    expect(conv?.cacheReadTotal).toEqual(11);
    expect(conv?.cacheWriteTotal).toEqual(5);
  } finally {
    await cleanup(t);
  }
});

test("codex turn span promotes model and tokens when no usage or response span exists in the trace", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, {
      id: "sess_codex_turn",
      profile: "default",
      agent: "codex",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });

    const payload: OtlpJsonExportPayload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "nas.session.id",
                value: { stringValue: "sess_codex_turn" },
              },
              { key: "nas.agent", value: { stringValue: "codex" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace_codex_turn_only",
                  spanId: "span_codex_turn_only",
                  name: "session_task.turn",
                  startTimeUnixNano: "1714570200000000000",
                  endTimeUnixNano: "1714570201000000000",
                  attributes: [
                    {
                      key: "thread.id",
                      value: { stringValue: "thread_codex_turn_only" },
                    },
                    {
                      key: "model",
                      value: { stringValue: "gpt-5.5" },
                    },
                    {
                      key: "codex.turn.token_usage.input_tokens",
                      value: { intValue: "88" },
                    },
                    {
                      key: "codex.turn.token_usage.output_tokens",
                      value: { intValue: "44" },
                    },
                    {
                      key: "codex.turn.token_usage.cache_read_input_tokens",
                      value: { intValue: "22" },
                    },
                    {
                      key: "codex.turn.token_usage.cache_creation_input_tokens",
                      value: { intValue: "6" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestResourceSpans(db, payload);
    expect(result.acceptedSpans).toEqual(1);
    expect(result.droppedTraces).toEqual(0);
    expect(result.resolvedConversations).toEqual(1);

    const span = db
      .query(
        `SELECT span_name, kind, model, in_tok, out_tok, cache_r, cache_w
           FROM spans
          WHERE span_id = ?`,
      )
      .get("span_codex_turn_only") as {
      span_name: string;
      kind: string;
      model: string | null;
      in_tok: number | null;
      out_tok: number | null;
      cache_r: number | null;
      cache_w: number | null;
    };
    expect(span).toEqual({
      span_name: "session_task.turn",
      kind: "invoke_agent",
      model: "gpt-5.5",
      in_tok: 88,
      out_tok: 44,
      cache_r: 22,
      cache_w: 6,
    });

    const conv = queryConversationList(db).find(
      (row) => row.id === "thread_codex_turn_only",
    );
    expect(conv?.inputTokensTotal).toEqual(88);
    expect(conv?.outputTokensTotal).toEqual(44);
    expect(conv?.cacheReadTotal).toEqual(22);
    expect(conv?.cacheWriteTotal).toEqual(6);
  } finally {
    await cleanup(t);
  }
});

test("subagent_one_invocation_two_conversations: 1 invocation, 2 traces, 2 conversations", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, {
      id: "sess_ccc",
      profile: null,
      agent: "claude",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });

    const payload = await loadFixture(
      "subagent_one_invocation_two_conversations.json",
    );
    const result = ingestResourceSpans(db, payload);
    expect(result.acceptedSpans).toEqual(2);
    expect(result.resolvedConversations).toEqual(2);

    const traces = db
      .query("SELECT trace_id, conversation_id FROM traces ORDER BY trace_id")
      .all() as { trace_id: string; conversation_id: string | null }[];
    expect(traces).toEqual([
      { trace_id: "trace_parent", conversation_id: "conv_parent" },
      { trace_id: "trace_subagent", conversation_id: "conv_subagent" },
    ]);

    const convs = db
      .query("SELECT id FROM conversations ORDER BY id")
      .all() as { id: string }[];
    expect(convs).toEqual([{ id: "conv_parent" }, { id: "conv_subagent" }]);

    const invocationCount = db
      .query("SELECT COUNT(*) AS c FROM invocations")
      .get() as CountRow;
    expect(invocationCount.c).toEqual(1);
  } finally {
    await cleanup(t);
  }
});

test("resume_two_invocations_one_conversation: 2 invocations, 2 traces, 1 conversation; first/last seen span the range", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, {
      id: "sess_d1",
      profile: null,
      agent: "copilot",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });
    upsertInvocation(db, {
      id: "sess_d2",
      profile: null,
      agent: "copilot",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });

    const payload = await loadFixture(
      "resume_two_invocations_one_conversation.json",
    );
    const result = ingestResourceSpans(db, payload);
    expect(result.acceptedSpans).toEqual(2);
    expect(result.resolvedConversations).toEqual(2);

    const traces = db
      .query(
        "SELECT trace_id, invocation_id, conversation_id FROM traces ORDER BY trace_id",
      )
      .all() as {
      trace_id: string;
      invocation_id: string;
      conversation_id: string | null;
    }[];
    expect(traces).toEqual([
      {
        trace_id: "trace_d1",
        invocation_id: "sess_d1",
        conversation_id: "conv_resumed",
      },
      {
        trace_id: "trace_d2",
        invocation_id: "sess_d2",
        conversation_id: "conv_resumed",
      },
    ]);

    const convs = db
      .query("SELECT id, first_seen_at, last_seen_at FROM conversations")
      .all() as {
      id: string;
      first_seen_at: string;
      last_seen_at: string;
    }[];
    expect(convs.length).toEqual(1);
    expect(convs[0].id).toEqual("conv_resumed");
    // first_seen_at corresponds to the earlier resourceSpan's trace start;
    // last_seen_at to the later resourceSpan's trace end.
    expect(convs[0].first_seen_at < convs[0].last_seen_at).toBe(true);
  } finally {
    await cleanup(t);
  }
});

test("re-ingesting copilot_chat_minimal does not mutate traces.conversation_id", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, {
      id: "sess_aaa",
      profile: null,
      agent: "copilot",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });

    const payload = await loadFixture("copilot_chat_minimal.json");
    ingestResourceSpans(db, payload);
    ingestResourceSpans(db, payload);

    const traces = db
      .query("SELECT conversation_id FROM traces WHERE trace_id = ?")
      .all("trace_copilot_1") as { conversation_id: string | null }[];
    expect(traces.length).toEqual(1);
    expect(traces[0].conversation_id).toEqual("conv_copilot_1");

    const spanCount = db
      .query("SELECT COUNT(*) AS c FROM spans")
      .get() as CountRow;
    // INSERT OR REPLACE on the same span_ids — count stays at 3.
    expect(spanCount.c).toEqual(3);
  } finally {
    await cleanup(t);
  }
});

test("resource missing nas.session.id is dropped and counted", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    const payload: OtlpJsonExportPayload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "nas.profile", value: { stringValue: "default" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace_orphan",
                  spanId: "span_orphan",
                  name: "chat",
                  startTimeUnixNano: "1714600000000000000",
                  endTimeUnixNano: "1714600001000000000",
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = ingestResourceSpans(db, payload);
    expect(result.droppedTraces).toEqual(1);
    expect(result.acceptedSpans).toEqual(0);

    const spanCount = db
      .query("SELECT COUNT(*) AS c FROM spans")
      .get() as CountRow;
    expect(spanCount.c).toEqual(0);
  } finally {
    await cleanup(t);
  }
});

test("trace where one span has gen_ai.conversation.id='' falls back to session.id from another span", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, {
      id: "sess_mix",
      profile: null,
      agent: "claude",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });
    const payload: OtlpJsonExportPayload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "nas.session.id", value: { stringValue: "sess_mix" } },
              { key: "nas.agent", value: { stringValue: "claude" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace_mix",
                  spanId: "span_mix_1",
                  name: "claude_code.llm_request",
                  startTimeUnixNano: "1714610000000000000",
                  endTimeUnixNano: "1714610001000000000",
                  attributes: [
                    {
                      key: "gen_ai.conversation.id",
                      value: { stringValue: "" },
                    },
                  ],
                },
                {
                  traceId: "trace_mix",
                  spanId: "span_mix_2",
                  name: "claude_code.tool",
                  startTimeUnixNano: "1714610002000000000",
                  endTimeUnixNano: "1714610003000000000",
                  attributes: [
                    { key: "session.id", value: { stringValue: "conv_mix" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = ingestResourceSpans(db, payload);
    expect(result.acceptedSpans).toEqual(2);
    expect(result.resolvedConversations).toEqual(1);

    const trace = db
      .query("SELECT conversation_id FROM traces WHERE trace_id = ?")
      .get("trace_mix") as { conversation_id: string | null } | null;
    expect(trace?.conversation_id).toEqual("conv_mix");
  } finally {
    await cleanup(t);
  }
});

test("ingestResourceSpans drops spans missing required ids while accepting siblings", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, {
      id: "sess_partial",
      profile: null,
      agent: "claude",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });

    // Mix one healthy span with three malformed siblings (missing traceId,
    // spanId, or name). Cast to the typed payload shape because the wire-level
    // contract permits these required fields to be absent at runtime.
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "nas.session.id",
                value: { stringValue: "sess_partial" },
              },
              { key: "nas.agent", value: { stringValue: "claude" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace_partial",
                  spanId: "span_healthy",
                  name: "claude_code.llm_request",
                  startTimeUnixNano: "1714620000000000000",
                  endTimeUnixNano: "1714620001000000000",
                  attributes: [
                    {
                      key: "gen_ai.conversation.id",
                      value: { stringValue: "conv_partial" },
                    },
                  ],
                },
                {
                  spanId: "span_no_trace",
                  name: "claude_code.tool",
                  startTimeUnixNano: "1714620002000000000",
                  endTimeUnixNano: "1714620003000000000",
                  attributes: [],
                },
                {
                  traceId: "trace_partial",
                  name: "claude_code.tool",
                  startTimeUnixNano: "1714620004000000000",
                  endTimeUnixNano: "1714620005000000000",
                  attributes: [],
                },
                {
                  traceId: "trace_partial",
                  spanId: "span_no_name",
                  startTimeUnixNano: "1714620006000000000",
                  endTimeUnixNano: "1714620007000000000",
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    } as unknown as OtlpJsonExportPayload;

    const result = ingestResourceSpans(db, payload);
    expect(result.acceptedSpans).toEqual(1);
    expect(result.droppedTraces).toEqual(0);
    expect(result.resolvedConversations).toEqual(1);

    const spans = db
      .query("SELECT span_id FROM spans ORDER BY span_id")
      .all() as { span_id: string }[];
    expect(spans).toEqual([{ span_id: "span_healthy" }]);
  } finally {
    await cleanup(t);
  }
});

test("user.* PII attributes are stripped from attrs_json before persistence", async () => {
  const t = await makeTempDb();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(db, {
      id: "sess_pii",
      profile: "default",
      agent: "claude",
      worktreePath: null,
      startedAt: "2026-05-01T00:00:00Z",
      endedAt: null,
      exitReason: null,
    });

    const payload: OtlpJsonExportPayload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "nas.session.id", value: { stringValue: "sess_pii" } },
              { key: "nas.agent", value: { stringValue: "claude" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace_pii",
                  spanId: "span_pii",
                  name: "claude_code.llm_request",
                  startTimeUnixNano: "1714521600000000000",
                  endTimeUnixNano: "1714521601000000000",
                  attributes: [
                    {
                      key: "session.id",
                      value: { stringValue: "keep-me" },
                    },
                    {
                      key: "user.id",
                      value: { stringValue: "hashed-user-id" },
                    },
                    {
                      key: "user.email",
                      value: { stringValue: "person@example.com" },
                    },
                    {
                      key: "user.account_id",
                      value: { stringValue: "acct_123" },
                    },
                    {
                      key: "user.account_uuid",
                      value: { stringValue: "uuid_abc" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestResourceSpans(db, payload);
    expect(result.acceptedSpans).toEqual(1);

    const row = db
      .query("SELECT attrs_json FROM spans WHERE span_id = ?")
      .get("span_pii") as { attrs_json: string };
    const attrs = JSON.parse(row.attrs_json) as Record<string, unknown>;
    expect(attrs["session.id"]).toEqual("keep-me");
    expect(attrs["user.id"]).toBeUndefined();
    expect(attrs["user.email"]).toBeUndefined();
    expect(attrs["user.account_id"]).toBeUndefined();
    expect(attrs["user.account_uuid"]).toBeUndefined();
  } finally {
    await cleanup(t);
  }
});

test("payload with no resourceSpans returns zero counters and does not throw", () => {
  // No DB needed; the early-return path triggers before any query.
  const result = ingestResourceSpans(
    openHistoryDb({ path: ":memory:", mode: "readwrite" }) as never,
    {} as OtlpJsonExportPayload,
  );
  // Note: we don't assert on the in-memory DB; we only exercise the early return.
  expect(result.acceptedSpans).toEqual(0);
  expect(result.droppedTraces).toEqual(0);
  _closeHistoryDb(":memory:");
});
