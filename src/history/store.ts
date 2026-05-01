import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import type {
  ConversationDetail,
  ConversationListRow,
  ConversationRow,
  InvocationDetail,
  InvocationRow,
  InvocationSummaryRow,
  SpanRow,
  SpanSummaryRow,
  TraceRow,
  TraceSummaryRow,
  TurnEventRow,
} from "./types.ts";

export type {
  ConversationDetail,
  ConversationListRow,
  ConversationTurnEventRow,
  InvocationDetail,
  InvocationSummaryRow,
  InvocationTurnEventRow,
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

/**
 * Schema version embedded in `PRAGMA user_version`. Open refuses (in either
 * mode) when the on-disk value disagrees. Migrations are not attempted —
 * the operator is expected to `rm history.db` and let the writer recreate.
 */
export const HISTORY_DB_USER_VERSION = 1;

export class HistoryDbVersionMismatchError extends Error {
  readonly actual: number;
  constructor(path: string, actual: number) {
    super(
      `history db schema version mismatch at ${path}: expected ${HISTORY_DB_USER_VERSION}, got ${actual}`,
    );
    this.name = "HistoryDbVersionMismatchError";
    this.actual = actual;
  }
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

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS invocations (
  id              TEXT PRIMARY KEY,
  profile         TEXT,
  agent           TEXT,
  worktree_path   TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  exit_reason     TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  agent           TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
  trace_id        TEXT PRIMARY KEY,
  invocation_id   TEXT NOT NULL REFERENCES invocations(id),
  conversation_id TEXT REFERENCES conversations(id),
  started_at      TEXT NOT NULL,
  ended_at        TEXT
);

CREATE TABLE IF NOT EXISTS spans (
  span_id         TEXT PRIMARY KEY,
  parent_span_id  TEXT,
  trace_id        TEXT NOT NULL REFERENCES traces(trace_id),
  span_name       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  model           TEXT,
  in_tok          INTEGER,
  out_tok         INTEGER,
  cache_r         INTEGER,
  cache_w         INTEGER,
  duration_ms     INTEGER,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  attrs_json      TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS turn_events (
  invocation_id   TEXT NOT NULL REFERENCES invocations(id),
  conversation_id TEXT REFERENCES conversations(id),
  ts              TEXT NOT NULL,
  kind            TEXT NOT NULL,
  payload_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_traces_invocation
  ON traces(invocation_id);
CREATE INDEX IF NOT EXISTS idx_traces_conversation
  ON traces(conversation_id);
CREATE INDEX IF NOT EXISTS idx_spans_trace
  ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_turn_events_invocation
  ON turn_events(invocation_id, ts);
CREATE INDEX IF NOT EXISTS idx_turn_events_conversation
  ON turn_events(conversation_id, ts);
CREATE INDEX IF NOT EXISTS idx_invocations_started
  ON invocations(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_lastseen
  ON conversations(last_seen_at DESC);
`;

interface UserVersionRow {
  user_version: number;
}

function readUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as UserVersionRow | null;
  return row?.user_version ?? 0;
}

/**
 * Open (or fetch the cached) history database handle.
 *
 * - readwrite: creates the file (and parent dir) on first open, applies
 *   PRAGMAs, runs CREATE TABLE/INDEX (IF NOT EXISTS), and stamps
 *   `user_version` if it's still 0. Mismatched non-zero versions throw.
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

    db.run(SCHEMA_SQL);

    const actual = readUserVersion(db);
    if (actual === 0) {
      // `PRAGMA user_version = N` cannot be parameterised; the value is a
      // compile-time const so this isn't a SQL-injection vector.
      db.run(`PRAGMA user_version = ${HISTORY_DB_USER_VERSION}`);
    } else if (actual !== HISTORY_DB_USER_VERSION) {
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
        duration_ms, started_at, ended_at, attrs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    }
  });
  tx(rows);
}

/** Append a single turn_events row. No PK; duplicates are allowed. */
export function insertTurnEvent(db: Database, row: TurnEventRow): void {
  db.prepare(
    `INSERT INTO turn_events
       (invocation_id, conversation_id, ts, kind, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.invocationId,
    row.conversationId,
    row.ts,
    row.kind,
    row.payloadJson,
  );
}

// ---------------------------------------------------------------------------
// Reader API
// ---------------------------------------------------------------------------

/**
 * Conversation list row, including aggregate columns derived from related
 * traces / spans / turn_events / invocations.
 *
 * Aggregates use COALESCE/SUM-with-default-0 so a conversation that has been
 * recorded by the hook but has no associated spans yet still produces 0
 * (never NULL).
 */
interface ConversationListSqlRow {
  id: string;
  agent: string | null;
  first_seen_at: string;
  last_seen_at: string;
  turn_event_count: number;
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
    COALESCE(
      (SELECT COUNT(*) FROM turn_events te WHERE te.conversation_id = c.id),
      0
    ) AS turn_event_count,
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

function rowToConversationListRow(
  r: ConversationListSqlRow,
): ConversationListRow {
  return {
    id: r.id,
    agent: r.agent,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    turnEventCount: r.turn_event_count,
    spanCount: r.span_count,
    invocationCount: r.invocation_count,
    inputTokensTotal: r.input_tokens_total,
    outputTokensTotal: r.output_tokens_total,
    cacheReadTotal: r.cache_read_total,
    cacheWriteTotal: r.cache_write_total,
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
 *
 * Default limit is 200; callers can override but should keep results bounded
 * since the consumer renders them as a single list.
 */
export function queryConversationList(
  db: Database,
  options?: { limit?: number },
): ConversationListRow[] {
  const limit = options?.limit ?? 200;
  const rows = db
    .prepare(
      `${CONVERSATION_LIST_SELECT}
       ORDER BY c.last_seen_at DESC
       LIMIT ?`,
    )
    .all(limit) as ConversationListSqlRow[];
  return rows.map(rowToConversationListRow);
}

/**
 * Fetch a conversation plus all its traces / spans / turn_events /
 * invocations. Returns null when no conversation matches `id`.
 *
 * `turnEvents` are filtered by `conversation_id = id` exactly; rows whose
 * `conversation_id` is NULL (= hook wrote them before resolution) are not
 * included here.
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
           s.duration_ms, s.started_at, s.ended_at, s.attrs_json
         FROM spans s
         JOIN traces t ON s.trace_id = t.trace_id
         WHERE t.conversation_id = ?
         ORDER BY s.started_at ASC`,
      )
      .all(id) as SpanSummarySqlRow[]
  ).map(rowToSpanSummary);

  const turnEvents = db
    .prepare(
      `SELECT invocation_id, ts, kind, payload_json
       FROM turn_events
       WHERE conversation_id = ?
       ORDER BY ts ASC`,
    )
    .all(id) as {
    invocation_id: string;
    ts: string;
    kind: string;
    payload_json: string;
  }[];

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

  return {
    conversation: rowToConversationListRow(head),
    traces,
    spans,
    turnEvents: turnEvents.map((r) => ({
      invocationId: r.invocation_id,
      ts: r.ts,
      kind: r.kind,
      payloadJson: r.payload_json,
    })),
    invocations,
  };
}

/**
 * Fetch an invocation plus all its traces / spans / turn_events and the
 * conversations referenced by its traces (subagent fan-out yields multiple).
 * Returns null when no invocation matches `id`.
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
           s.duration_ms, s.started_at, s.ended_at, s.attrs_json
         FROM spans s
         JOIN traces t ON s.trace_id = t.trace_id
         WHERE t.invocation_id = ?
         ORDER BY s.started_at ASC`,
      )
      .all(id) as SpanSummarySqlRow[]
  ).map(rowToSpanSummary);

  const turnEventRows = db
    .prepare(
      `SELECT conversation_id, ts, kind, payload_json
       FROM turn_events
       WHERE invocation_id = ?
       ORDER BY ts ASC`,
    )
    .all(id) as {
    conversation_id: string | null;
    ts: string;
    kind: string;
    payload_json: string;
  }[];

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
    turnEvents: turnEventRows.map((r) => ({
      conversationId: r.conversation_id,
      ts: r.ts,
      kind: r.kind,
      payloadJson: r.payload_json,
    })),
    conversations,
  };
}
