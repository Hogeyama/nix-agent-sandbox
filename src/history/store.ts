import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { extractTracePrompts } from "../agents/prompts.ts";
import {
  applyMigrations,
  HISTORY_DB_USER_VERSION,
  HistoryDbVersionMismatchError,
  readUserVersion,
} from "./migrations.ts";
import type {
  ConversationDetail,
  ConversationListRow,
  ConversationRow,
  InvocationDetail,
  InvocationRow,
  InvocationSummaryRow,
  LogRecordRow,
  LogRecordSummaryRow,
  ModelTokenTotalsRow,
  SpanRow,
  SpanSummaryRow,
  TraceRow,
  TraceSummaryRow,
} from "./types.ts";

export {
  HISTORY_DB_USER_VERSION,
  HistoryDbVersionMismatchError,
} from "./migrations.ts";
export type {
  ConversationDetail,
  ConversationListRow,
  InvocationDetail,
  InvocationSummaryRow,
  LogRecordSummaryRow,
  ModelTokenTotalsRow,
  SpanSummaryRow,
  TraceSummaryRow,
} from "./types.ts";

/**
 * Resolve the directory where the history SQLite database lives.
 *
 * Uses `$XDG_DATA_HOME/nas/` with the standard fallback to
 * `~/.local/share/nas/`. Note: history.db sits directly under `nas/`
 * (per ADR 2026042901), unlike the audit store which uses a `nas/audit/`
 * subdirectory.
 */
export function resolveHistoryDir(): string {
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData && xdgData.trim().length > 0) {
    return path.join(xdgData, "nas");
  }
  const home = process.env.HOME;
  if (!home) {
    throw new Error(
      "Cannot resolve history directory: neither XDG_DATA_HOME nor HOME is set",
    );
  }
  return path.join(home, ".local/share", "nas");
}

/** Full path to history.db. */
export function resolveHistoryDbPath(): string {
  return path.join(resolveHistoryDir(), "history.db");
}

export type HistoryDbMode = "readwrite" | "readonly";

interface OpenHistoryDbParams {
  path: string;
  mode: HistoryDbMode;
}

/**
 * Cache key is `${mode}::${path}` so that a single process can hold a
 * writer handle and a separate reader handle against the same file
 * concurrently — this is the read-after-write integration scenario for
 * the per-session OTLP receiver vs the UI daemon.
 */
const dbCache = new Map<string, Database>();

function cacheKey({ path: p, mode }: OpenHistoryDbParams): string {
  return `${mode}::${p}`;
}

/**
 * Open (or fetch the cached) history database handle.
 *
 * - readwrite: creates the file (and parent dir) on first open, applies
 *   PRAGMAs, then runs pending migrations to bring the schema up to
 *   `HISTORY_DB_USER_VERSION`. Mismatched non-zero versions throw.
 * - readonly: opens an existing file, verifies `user_version`, and skips
 *   schema/PRAGMA work.
 */
export function openHistoryDb(params: OpenHistoryDbParams): Database {
  const key = cacheKey(params);
  const cached = dbCache.get(key);
  if (cached) return cached;

  const db =
    params.mode === "readwrite"
      ? openWriter(params.path)
      : openReader(params.path);

  dbCache.set(key, db);
  return db;
}

function openWriter(dbPath: string): Database {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });

  const db = new Database(dbPath, { create: true });
  try {
    // Same PRAGMA set as audit/store.ts: WAL for reader/writer concurrency,
    // NORMAL sync (crash-safe vs app crash, fast under contention),
    // 5s busy_timeout so concurrent writers retry instead of failing,
    // foreign_keys=ON for the REFERENCES clauses to be enforced.
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA foreign_keys = ON");

    applyMigrations(db, dbPath);
  } catch (e) {
    try {
      db.close();
    } catch {
      // Suppress secondary close failures so the original error surfaces.
    }
    throw e;
  }
  return db;
}

function openReader(dbPath: string): Database {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    const actual = readUserVersion(db);
    if (actual !== HISTORY_DB_USER_VERSION) {
      throw new HistoryDbVersionMismatchError(dbPath, actual);
    }
  } catch (e) {
    try {
      db.close();
    } catch {
      // Suppress secondary close failures so the original error surfaces.
    }
    throw e;
  }
  return db;
}

/**
 * Test-only helper: close and forget cached handle(s).
 *
 * - With `path`: closes both modes (readwrite + readonly) for that path.
 * - Without `path`: closes every cached handle (full reset).
 */
export function _closeHistoryDb(targetPath?: string): void {
  if (targetPath === undefined) {
    for (const db of dbCache.values()) db.close();
    dbCache.clear();
    return;
  }
  for (const mode of ["readwrite", "readonly"] as const) {
    const key = cacheKey({ path: targetPath, mode });
    const db = dbCache.get(key);
    if (db) {
      db.close();
      dbCache.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Writer API
// ---------------------------------------------------------------------------

/**
 * Insert or update an invocation row.
 *
 * `started_at` is fixed at first write; subsequent calls do not overwrite it
 * (a re-issue from a later stage shouldn't move the recorded start time).
 * The other columns COALESCE the incoming value with the stored one — a
 * later non-null value wins, but explicit nulls don't erase data.
 */
export function upsertInvocation(db: Database, row: InvocationRow): void {
  db.prepare(
    `INSERT INTO invocations
       (id, profile, agent, worktree_path,
        started_at, ended_at, exit_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       profile       = COALESCE(excluded.profile, invocations.profile),
       agent         = COALESCE(excluded.agent, invocations.agent),
       worktree_path = COALESCE(excluded.worktree_path, invocations.worktree_path),
       ended_at      = COALESCE(excluded.ended_at, invocations.ended_at),
       exit_reason   = COALESCE(excluded.exit_reason, invocations.exit_reason)`,
  ).run(
    row.id,
    row.profile,
    row.agent,
    row.worktreePath,
    row.startedAt,
    row.endedAt,
    row.exitReason,
  );
}

/**
 * Mark an invocation as ended.
 *
 * Idempotent: the first call wins. A second call (e.g. a redundant
 * teardown) does not move `ended_at` or `exit_reason`. The row must
 * already exist (created by `upsertInvocation` at session start).
 */
export function markInvocationEnded(
  db: Database,
  params: { id: string; endedAt: string; exitReason: string },
): void {
  db.prepare(
    `UPDATE invocations
       SET ended_at    = COALESCE(ended_at, ?),
           exit_reason = COALESCE(exit_reason, ?)
     WHERE id = ?`,
  ).run(params.endedAt, params.exitReason, params.id);
}

/**
 * Insert or update a conversation row.
 *
 * `first_seen_at` clamps to MIN, `last_seen_at` to MAX. `agent` uses
 * COALESCE so a hook-side write (which has no agent classification) can
 * be filled in later by an OTLP receiver write — but never reset to NULL
 * once known.
 */
export function upsertConversation(db: Database, row: ConversationRow): void {
  db.prepare(
    `INSERT INTO conversations
       (id, agent, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       agent         = COALESCE(excluded.agent, conversations.agent),
       first_seen_at = MIN(conversations.first_seen_at, excluded.first_seen_at),
       last_seen_at  = MAX(conversations.last_seen_at, excluded.last_seen_at)`,
  ).run(row.id, row.agent, row.firstSeenAt, row.lastSeenAt);
}

/**
 * Insert or update a trace row.
 *
 * Per ADR §"Trace と conversation 紐付けの解決ルール":
 * `conversation_id` is set exactly once — the first non-null write wins,
 * and later writes (null or otherwise) cannot mutate it. `started_at`
 * is similarly fixed at first write.
 */
export function upsertTrace(db: Database, row: TraceRow): void {
  db.prepare(
    `INSERT INTO traces
       (trace_id, invocation_id, conversation_id, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(trace_id) DO UPDATE SET
       conversation_id = COALESCE(traces.conversation_id, excluded.conversation_id),
       ended_at        = COALESCE(excluded.ended_at, traces.ended_at)`,
  ).run(
    row.traceId,
    row.invocationId,
    row.conversationId,
    row.startedAt,
    row.endedAt,
  );
}

/**
 * Bulk-insert spans within a single transaction. Span ids are the OTLP
 * span_id and are unique per receiver batch; INSERT OR REPLACE keeps the
 * latest write for the same span_id (idempotent retries).
 */
export function insertSpans(db: Database, rows: SpanRow[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO spans
       (span_id, parent_span_id, trace_id, span_name, kind,
        model, in_tok, out_tok, cache_r, cache_w,
        duration_ms, started_at, ended_at, attrs_json, events_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((batch: SpanRow[]) => {
    for (const r of batch) {
      stmt.run(
        r.spanId,
        r.parentSpanId,
        r.traceId,
        r.spanName,
        r.kind,
        r.model,
        r.inTok,
        r.outTok,
        r.cacheR,
        r.cacheW,
        r.durationMs,
        r.startedAt,
        r.endedAt,
        r.attrsJson,
        r.eventsJson,
      );
    }
  });
  tx(rows);
}

/**
 * Bulk-insert log records within a single transaction.
 *
 * Callers must ensure the referenced invocation and conversation rows already
 * exist before calling this function — inserting without them will trigger a
 * FK violation (foreign_keys=ON is enforced by the writer PRAGMA setup).
 *
 * Deduplication is done by `INSERT OR IGNORE` against the composite PRIMARY
 * KEY `(conversation_id, sequence)`. This means the first write for a given
 * key wins — retried deliveries of the same OTLP log batch are silently
 * dropped, which matches the immutable-record semantics of log signals.
 * Because `sequence` is a conversation-scoped monotonic counter (not
 * prompt-local), `(conversation_id, sequence)` uniquely identifies every
 * record across all prompts within a conversation.
 *
 * This store function trusts and persists the `sequence` values as-is.
 * Ensuring that `sequence` is monotonically increasing within a conversation
 * is the responsibility of the caller (the ingest layer).
 */
export function insertLogRecords(db: Database, rows: LogRecordRow[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO log_records
       (invocation_id, conversation_id, prompt_id, sequence,
        event_name, time, request_id, attrs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((batch: LogRecordRow[]) => {
    for (const r of batch) {
      stmt.run(
        r.invocationId,
        r.conversationId,
        r.promptId,
        r.sequence,
        r.eventName,
        r.time,
        r.requestId,
        r.attrsJson,
      );
    }
  });
  tx(rows);
}

// ---------------------------------------------------------------------------
// Reader API
// ---------------------------------------------------------------------------

/**
 * Conversation row projection, including aggregate columns derived from
 * related traces / spans / invocations.
 *
 * Aggregates use COALESCE/SUM-with-default-0 so a conversation can have no
 * associated spans and still produce 0 (never NULL).
 */
interface ConversationListSqlRow {
  id: string;
  agent: string | null;
  first_seen_at: string;
  last_seen_at: string;
  worktree_path: string | null;
  turn_count: number;
  span_count: number;
  invocation_count: number;
  input_tokens_total: number;
  output_tokens_total: number;
  cache_read_total: number;
  cache_write_total: number;
}

interface TraceSummarySqlRow {
  trace_id: string;
  invocation_id: string;
  conversation_id: string | null;
  started_at: string;
  ended_at: string | null;
  span_count: number;
}

interface SpanSummarySqlRow {
  span_id: string;
  parent_span_id: string | null;
  trace_id: string;
  span_name: string;
  kind: string;
  model: string | null;
  in_tok: number | null;
  out_tok: number | null;
  cache_r: number | null;
  cache_w: number | null;
  duration_ms: number | null;
  started_at: string;
  ended_at: string | null;
  attrs_json: string;
  events_json: string | null;
}

interface InvocationSqlRow {
  id: string;
  profile: string | null;
  agent: string | null;
  worktree_path: string | null;
  started_at: string;
  ended_at: string | null;
  exit_reason: string | null;
}

const CONVERSATION_LIST_SELECT = `
  SELECT
    c.id              AS id,
    c.agent           AS agent,
    c.first_seen_at   AS first_seen_at,
    c.last_seen_at    AS last_seen_at,
    (SELECT i.worktree_path
       FROM invocations i
       JOIN traces t ON t.invocation_id = i.id
      WHERE t.conversation_id = c.id
        AND i.worktree_path IS NOT NULL
      ORDER BY i.started_at DESC
      LIMIT 1) AS worktree_path,
    COALESCE(
      (SELECT COUNT(*) FROM traces t WHERE t.conversation_id = c.id),
      0
    ) AS turn_count,
    COALESCE(
      (SELECT COUNT(*) FROM spans s
        JOIN traces t ON s.trace_id = t.trace_id
       WHERE t.conversation_id = c.id),
      0
    ) AS span_count,
    COALESCE(
      (SELECT COUNT(DISTINCT t.invocation_id) FROM traces t
       WHERE t.conversation_id = c.id),
      0
    ) AS invocation_count,
    COALESCE(
      (SELECT SUM(COALESCE(s.in_tok, 0)) FROM spans s
        JOIN traces t ON s.trace_id = t.trace_id
       WHERE t.conversation_id = c.id),
      0
    ) AS input_tokens_total,
    COALESCE(
      (SELECT SUM(COALESCE(s.out_tok, 0)) FROM spans s
        JOIN traces t ON s.trace_id = t.trace_id
       WHERE t.conversation_id = c.id),
      0
    ) AS output_tokens_total,
    COALESCE(
      (SELECT SUM(COALESCE(s.cache_r, 0)) FROM spans s
        JOIN traces t ON s.trace_id = t.trace_id
       WHERE t.conversation_id = c.id),
      0
    ) AS cache_read_total,
    COALESCE(
      (SELECT SUM(COALESCE(s.cache_w, 0)) FROM spans s
        JOIN traces t ON s.trace_id = t.trace_id
       WHERE t.conversation_id = c.id),
      0
    ) AS cache_write_total
  FROM conversations c
`;

/**
 * Build a list row from the SQL projection. `summary` is left at `null`
 * here; reader entry points (`queryConversationList` /
 * `queryConversationDetail`) overwrite it with the first-trace prompt
 * derived from log_records / spans via `extractTracePrompts`.
 */
function rowToConversationListRow(
  r: ConversationListSqlRow,
): ConversationListRow {
  return {
    id: r.id,
    agent: r.agent,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    turnCount: r.turn_count,
    spanCount: r.span_count,
    invocationCount: r.invocation_count,
    inputTokensTotal: r.input_tokens_total,
    outputTokensTotal: r.output_tokens_total,
    cacheReadTotal: r.cache_read_total,
    cacheWriteTotal: r.cache_write_total,
    summary: null,
    worktreePath: r.worktree_path,
  };
}

function rowToTraceSummary(r: TraceSummarySqlRow): TraceSummaryRow {
  return {
    traceId: r.trace_id,
    invocationId: r.invocation_id,
    conversationId: r.conversation_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    spanCount: r.span_count,
  };
}

function rowToSpanSummary(r: SpanSummarySqlRow): SpanSummaryRow {
  return {
    spanId: r.span_id,
    parentSpanId: r.parent_span_id,
    traceId: r.trace_id,
    spanName: r.span_name,
    kind: r.kind,
    model: r.model,
    inTok: r.in_tok,
    outTok: r.out_tok,
    cacheR: r.cache_r,
    cacheW: r.cache_w,
    durationMs: r.duration_ms,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    attrsJson: r.attrs_json,
    eventsJson: r.events_json,
  };
}

function rowToInvocationSummary(r: InvocationSqlRow): InvocationSummaryRow {
  return {
    id: r.id,
    profile: r.profile,
    agent: r.agent,
    worktreePath: r.worktree_path,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    exitReason: r.exit_reason,
  };
}

/**
 * List conversations sorted by `last_seen_at DESC` with aggregate counts.
 * Conversations with no associated traces are hidden from the list: Codex
 * assigns separate conversation ids to subagent runs whose traces hang off
 * the parent conversation, and any conversation row written without an
 * accompanying trace would otherwise clutter the top-level list. Hidden
 * rows are still queryable by detail routes.
 *
 * Default limit is 200; callers can override but should keep results bounded
 * since the consumer renders them as a single list.
 */
export function queryConversationList(
  db: Database,
  options?: { limit?: number },
): ConversationListRow[] {
  const limit = options?.limit ?? 200;
  const sqlRows = db
    .prepare(
      `${CONVERSATION_LIST_SELECT}
       WHERE EXISTS (
         SELECT 1 FROM traces t
         WHERE t.conversation_id = c.id
       )
       ORDER BY c.last_seen_at DESC
       LIMIT ?`,
    )
    .all(limit) as ConversationListSqlRow[];
  const rows = sqlRows.map(rowToConversationListRow);
  if (rows.length === 0) return rows;

  const summaries = queryFirstTracePromptsForConversations(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const summary = summaries.get(r.id);
    return summary === undefined ? r : { ...r, summary };
  });
}

/**
 * Fetch a conversation plus all its traces / spans / invocations.
 * Returns null when no conversation matches `id`.
 */
export function queryConversationDetail(
  db: Database,
  id: string,
): ConversationDetail | null {
  const head = db
    .prepare(
      `${CONVERSATION_LIST_SELECT}
       WHERE c.id = ?
       LIMIT 1`,
    )
    .get(id) as ConversationListSqlRow | null;
  if (!head) return null;

  const traces = (
    db
      .prepare(
        `SELECT
           t.trace_id        AS trace_id,
           t.invocation_id   AS invocation_id,
           t.conversation_id AS conversation_id,
           t.started_at      AS started_at,
           t.ended_at        AS ended_at,
           COALESCE((SELECT COUNT(*) FROM spans s WHERE s.trace_id = t.trace_id), 0) AS span_count
         FROM traces t
         WHERE t.conversation_id = ?
         ORDER BY t.started_at ASC`,
      )
      .all(id) as TraceSummarySqlRow[]
  ).map(rowToTraceSummary);

  const spans = (
    db
      .prepare(
        `SELECT
           s.span_id, s.parent_span_id, s.trace_id, s.span_name, s.kind,
           s.model, s.in_tok, s.out_tok, s.cache_r, s.cache_w,
           s.duration_ms, s.started_at, s.ended_at, s.attrs_json, s.events_json
         FROM spans s
         JOIN traces t ON s.trace_id = t.trace_id
         WHERE t.conversation_id = ?
         ORDER BY s.started_at ASC`,
      )
      .all(id) as SpanSummarySqlRow[]
  ).map(rowToSpanSummary);

  const invocations = (
    db
      .prepare(
        `SELECT i.id, i.profile, i.agent, i.worktree_path,
                i.started_at, i.ended_at, i.exit_reason
         FROM invocations i
         WHERE i.id IN (
           SELECT DISTINCT t.invocation_id FROM traces t
           WHERE t.conversation_id = ?
         )
         ORDER BY i.started_at ASC`,
      )
      .all(id) as InvocationSqlRow[]
  ).map(rowToInvocationSummary);

  const modelTokenTotals = queryConversationModelTokenTotals(db, id);
  const logRecords = queryLogRecordsByConversation(db, id);

  // Derive summary from the earliest trace's user prompt. The sort key
  // here (started_at ASC, then trace_id ASC) matches the view-layer
  // `compareTurnOrder` deterministic order. Empty traces → null summary.
  let summary: string | null = null;
  if (traces.length > 0) {
    const firstTrace = traces.reduce((earliest, t) => {
      if (t.startedAt < earliest.startedAt) return t;
      if (t.startedAt > earliest.startedAt) return earliest;
      return t.traceId < earliest.traceId ? t : earliest;
    });
    const prompts = extractTracePrompts(logRecords, spans);
    summary = prompts.get(firstTrace.traceId) ?? null;
  }

  return {
    conversation: { ...rowToConversationListRow(head), summary },
    traces,
    spans,
    invocations,
    modelTokenTotals,
    logRecords,
  };
}

/**
 * Fetch an invocation plus all its traces / spans and the conversations
 * referenced by its traces (subagent fan-out yields multiple). Returns
 * null when no invocation matches `id`.
 */
export function queryInvocationDetail(
  db: Database,
  id: string,
): InvocationDetail | null {
  const invRow = db
    .prepare(
      `SELECT id, profile, agent, worktree_path,
              started_at, ended_at, exit_reason
       FROM invocations
       WHERE id = ?
       LIMIT 1`,
    )
    .get(id) as InvocationSqlRow | null;
  if (!invRow) return null;

  const traces = (
    db
      .prepare(
        `SELECT
           t.trace_id        AS trace_id,
           t.invocation_id   AS invocation_id,
           t.conversation_id AS conversation_id,
           t.started_at      AS started_at,
           t.ended_at        AS ended_at,
           COALESCE((SELECT COUNT(*) FROM spans s WHERE s.trace_id = t.trace_id), 0) AS span_count
         FROM traces t
         WHERE t.invocation_id = ?
         ORDER BY t.started_at ASC`,
      )
      .all(id) as TraceSummarySqlRow[]
  ).map(rowToTraceSummary);

  const spans = (
    db
      .prepare(
        `SELECT
           s.span_id, s.parent_span_id, s.trace_id, s.span_name, s.kind,
           s.model, s.in_tok, s.out_tok, s.cache_r, s.cache_w,
           s.duration_ms, s.started_at, s.ended_at, s.attrs_json, s.events_json
         FROM spans s
         JOIN traces t ON s.trace_id = t.trace_id
         WHERE t.invocation_id = ?
         ORDER BY s.started_at ASC`,
      )
      .all(id) as SpanSummarySqlRow[]
  ).map(rowToSpanSummary);

  const conversations = (
    db
      .prepare(
        `${CONVERSATION_LIST_SELECT}
         WHERE c.id IN (
           SELECT DISTINCT t.conversation_id FROM traces t
           WHERE t.invocation_id = ? AND t.conversation_id IS NOT NULL
         )
         ORDER BY c.last_seen_at DESC`,
      )
      .all(id) as ConversationListSqlRow[]
  ).map(rowToConversationListRow);

  return {
    invocation: rowToInvocationSummary(invRow),
    traces,
    spans,
    conversations,
  };
}

interface ModelTokenTotalsSqlRow {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  input_tokens_above_200k: number;
  output_tokens_above_200k: number;
  cache_read_above_200k: number;
  cache_write_above_200k: number;
}

/**
 * Per-span effective-input bucket projected on to the GROUP BY level.
 * Each span goes entirely into one bucket: when its
 * `in_tok + cache_r + cache_w` exceeds 200_000, all four token columns
 * for that span are folded into the `_above_200k` aggregate as well as
 * the unconditional total. The base bucket is therefore the difference
 * `total - above_200k`, computed once on the JS side.
 *
 * Anthropic's long-context (1M) pricing is "all-or-nothing per request":
 * a single API call whose prompt input crosses the threshold pays the
 * upper-tier rate on every cost field of that call (including its
 * generated output tokens), so the bucket is keyed off the per-span
 * effective input rather than off any individual column.
 */
const SPAN_BUCKETED_TOKEN_TOTALS_SELECT = `
  COALESCE(SUM(in_tok), 0)  AS input_tokens,
  COALESCE(SUM(out_tok), 0) AS output_tokens,
  COALESCE(SUM(cache_r), 0) AS cache_read,
  COALESCE(SUM(cache_w), 0) AS cache_write,
  COALESCE(SUM(CASE WHEN COALESCE(in_tok,0) + COALESCE(cache_r,0) + COALESCE(cache_w,0) > 200000 THEN in_tok ELSE 0 END), 0)  AS input_tokens_above_200k,
  COALESCE(SUM(CASE WHEN COALESCE(in_tok,0) + COALESCE(cache_r,0) + COALESCE(cache_w,0) > 200000 THEN out_tok ELSE 0 END), 0) AS output_tokens_above_200k,
  COALESCE(SUM(CASE WHEN COALESCE(in_tok,0) + COALESCE(cache_r,0) + COALESCE(cache_w,0) > 200000 THEN cache_r ELSE 0 END), 0) AS cache_read_above_200k,
  COALESCE(SUM(CASE WHEN COALESCE(in_tok,0) + COALESCE(cache_r,0) + COALESCE(cache_w,0) > 200000 THEN cache_w ELSE 0 END), 0) AS cache_write_above_200k
`;

const SPAN_BUCKETED_TOKEN_TOTALS_FROM_SPANS_SELECT =
  SPAN_BUCKETED_TOKEN_TOTALS_SELECT.replace(
    /\b(in_tok|out_tok|cache_r|cache_w)\b/g,
    "s.$1",
  );

function rowToModelTokenTotals(r: ModelTokenTotalsSqlRow): ModelTokenTotalsRow {
  return {
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheRead: r.cache_read,
    cacheWrite: r.cache_write,
    inputTokensAbove200k: r.input_tokens_above_200k,
    outputTokensAbove200k: r.output_tokens_above_200k,
    cacheReadAbove200k: r.cache_read_above_200k,
    cacheWriteAbove200k: r.cache_write_above_200k,
  };
}

/**
 * Aggregate `(in_tok, out_tok, cache_r, cache_w)` per `model` over spans
 * whose `started_at >= sinceIso`. The caller decides the window (e.g. 30d
 * for the UI dashboard); the store layer is window-agnostic.
 *
 * Notes:
 * - SQLite's `GROUP BY` collapses NULL values together, so a single row
 *   with `model = null` covers all model-less spans.
 * - `COALESCE(SUM(...), 0)` keeps an empty group from emitting NULL —
 *   in practice `SUM` on an empty result is NULL, but on a non-empty
 *   group with all-NULL values `SUM` is also NULL; both cases collapse
 *   to 0.
 * - Order is deterministic: `model ASC` with the NULL row last. Callers
 *   can rely on this stable order for diff-based change detection.
 * - `spans.started_at` is not currently indexed, so this is a full scan.
 *   Acceptable at current scale; revisit if span counts grow.
 */
export function queryModelTokenTotals(
  db: Database,
  options: { sinceIso: string },
): ModelTokenTotalsRow[] {
  const rows = db
    .prepare(
      `SELECT
         model AS model,
         ${SPAN_BUCKETED_TOKEN_TOTALS_SELECT}
       FROM spans
       WHERE started_at >= ?
       GROUP BY model
       ORDER BY model IS NULL, model`,
    )
    .all(options.sinceIso) as ModelTokenTotalsSqlRow[];
  return rows.map(rowToModelTokenTotals);
}

/**
 * Aggregate `(in_tok, out_tok, cache_r, cache_w)` per `model` over spans
 * belonging to a single conversation (joined through `traces.conversation_id`).
 *
 * Notes:
 * - Spans whose `model` is NULL collapse into one row per the GROUP BY rules,
 *   and `COALESCE(SUM(...), 0)` keeps all-NULL groups at 0 instead of NULL.
 * - Order is deterministic: `model ASC` with the NULL row last.
 * - Returns `[]` when no traces match the conversation_id.
 */
export function queryConversationModelTokenTotals(
  db: Database,
  conversationId: string,
): ModelTokenTotalsRow[] {
  const rows = db
    .prepare(
      `SELECT
         s.model AS model,
         ${SPAN_BUCKETED_TOKEN_TOTALS_FROM_SPANS_SELECT}
       FROM spans s
       JOIN traces t ON s.trace_id = t.trace_id
       WHERE t.conversation_id = ?
       GROUP BY s.model
       ORDER BY s.model IS NULL, s.model`,
    )
    .all(conversationId) as ModelTokenTotalsSqlRow[];
  return rows.map(rowToModelTokenTotals);
}

interface LogRecordSqlRow {
  invocation_id: string;
  conversation_id: string;
  prompt_id: string;
  sequence: number;
  event_name: string;
  time: string;
  request_id: string | null;
  attrs_json: string;
}

function rowToLogRecordSummary(r: LogRecordSqlRow): LogRecordSummaryRow {
  return {
    invocationId: r.invocation_id,
    conversationId: r.conversation_id,
    promptId: r.prompt_id,
    sequence: r.sequence,
    eventName: r.event_name,
    time: r.time,
    requestId: r.request_id,
    attrsJson: r.attrs_json,
  };
}

/**
 * Fetch all log records for a conversation, ordered by `sequence ASC`.
 * Because `sequence` is a conversation-scoped monotonic counter (not
 * prompt-local), a single `ORDER BY sequence ASC` is sufficient to
 * reconstruct the exact emission order across all prompts within the
 * conversation — no time-based or prompt_id tie-breaking is required.
 *
 * Returns `[]` when no log records have been written for the conversation.
 */
export function queryLogRecordsByConversation(
  db: Database,
  conversationId: string,
): LogRecordSummaryRow[] {
  const rows = db
    .prepare(
      `SELECT
         invocation_id, conversation_id, prompt_id, sequence,
         event_name, time, request_id, attrs_json
       FROM log_records
       WHERE conversation_id = ?
       ORDER BY sequence ASC`,
    )
    .all(conversationId) as LogRecordSqlRow[];
  return rows.map(rowToLogRecordSummary);
}

interface ConversationModelTokenTotalsSqlRow extends ModelTokenTotalsSqlRow {
  conversation_id: string;
}

const SQLITE_VARIABLE_CHUNK_SIZE = 500;

/**
 * Aggregate per-model token totals for many conversations in one reader call.
 *
 * The return shape always includes every requested id. Conversations with no
 * matching spans map to an empty array. Each sub-array is deterministically
 * ordered (`model ASC`, NULL last), and object keys are inserted in the same
 * order as `conversationIds`.
 */
export function queryConversationModelTokenTotalsByConversationIds(
  db: Database,
  conversationIds: ReadonlyArray<string>,
): Record<string, ModelTokenTotalsRow[]> {
  const out: Record<string, ModelTokenTotalsRow[]> = {};
  for (const id of conversationIds) {
    if (out[id] === undefined) out[id] = [];
  }
  const dedupedIds = Object.keys(out);
  if (dedupedIds.length === 0) return out;

  for (
    let offset = 0;
    offset < dedupedIds.length;
    offset += SQLITE_VARIABLE_CHUNK_SIZE
  ) {
    const chunk = dedupedIds.slice(offset, offset + SQLITE_VARIABLE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT
           t.conversation_id AS conversation_id,
           s.model AS model,
           ${SPAN_BUCKETED_TOKEN_TOTALS_FROM_SPANS_SELECT}
         FROM spans s
         JOIN traces t ON s.trace_id = t.trace_id
         WHERE t.conversation_id IN (${placeholders})
         GROUP BY t.conversation_id, s.model
         ORDER BY t.conversation_id, s.model IS NULL, s.model`,
      )
      .all(...chunk) as ConversationModelTokenTotalsSqlRow[];
    for (const row of rows) {
      out[row.conversation_id]?.push(rowToModelTokenTotals(row));
    }
  }
  return out;
}

interface FirstTraceSqlRow {
  conversation_id: string;
  trace_id: string;
}

/**
 * Resolve the first-trace user prompt for each conversation in three
 * fixed reader queries (regardless of `conversationIds.length`):
 *
 *  1. Earliest trace per conversation. Tie-break is `started_at ASC,
 *     trace_id ASC` to match the view-layer `compareTurnOrder` deterministic
 *     order — kept inline here so this module stays free of view imports.
 *  2. Spans belonging to those traces.
 *  3. Log records for those conversations.
 *
 * `extractTracePrompts` then runs once per chunk to fold log_records +
 * spans into a `traceId → prompt` map; we project that back onto each
 * conversationId. Conversations with no traces, or whose first trace
 * has no extractable prompt, do not appear in the returned Map (caller
 * treats absent entries as `summary: null`).
 *
 * Chunked by `SQLITE_VARIABLE_CHUNK_SIZE` so a list of 500+
 * conversations stays under SQLite's `?` placeholder limit.
 */
function queryFirstTracePromptsForConversations(
  db: Database,
  conversationIds: ReadonlyArray<string>,
): Map<string, string> {
  const summaries = new Map<string, string>();
  if (conversationIds.length === 0) return summaries;

  for (
    let offset = 0;
    offset < conversationIds.length;
    offset += SQLITE_VARIABLE_CHUNK_SIZE
  ) {
    const chunk = conversationIds.slice(
      offset,
      offset + SQLITE_VARIABLE_CHUNK_SIZE,
    );
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");

    // Earliest trace per conversation. The inner ORDER BY mirrors
    // `compareTurnOrder` (started_at ASC, trace_id ASC) so reader-derived
    // summaries agree with the view-layer turn order.
    const firstTraceRows = db
      .prepare(
        `SELECT
           c.id AS conversation_id,
           (SELECT t.trace_id
              FROM traces t
             WHERE t.conversation_id = c.id
             ORDER BY t.started_at ASC, t.trace_id ASC
             LIMIT 1) AS trace_id
         FROM conversations c
         WHERE c.id IN (${placeholders})`,
      )
      .all(...chunk) as FirstTraceSqlRow[];

    const traceIds = firstTraceRows
      .map((r) => r.trace_id)
      .filter((id): id is string => id !== null && id !== undefined);
    if (traceIds.length === 0) continue;

    const tracePlaceholders = traceIds.map(() => "?").join(", ");
    const spans = (
      db
        .prepare(
          `SELECT
             span_id, parent_span_id, trace_id, span_name, kind,
             model, in_tok, out_tok, cache_r, cache_w,
             duration_ms, started_at, ended_at, attrs_json, events_json
           FROM spans
           WHERE trace_id IN (${tracePlaceholders})`,
        )
        .all(...traceIds) as SpanSummarySqlRow[]
    ).map(rowToSpanSummary);

    const logRecords = (
      db
        .prepare(
          `SELECT
             invocation_id, conversation_id, prompt_id, sequence,
             event_name, time, request_id, attrs_json
           FROM log_records
           WHERE conversation_id IN (${placeholders})`,
        )
        .all(...chunk) as LogRecordSqlRow[]
    ).map(rowToLogRecordSummary);

    const prompts = extractTracePrompts(logRecords, spans);

    for (const row of firstTraceRows) {
      if (row.trace_id === null || row.trace_id === undefined) continue;
      const prompt = prompts.get(row.trace_id);
      if (prompt !== undefined) summaries.set(row.conversation_id, prompt);
    }
  }
  return summaries;
}
