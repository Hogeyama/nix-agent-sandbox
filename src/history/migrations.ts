import type { Database } from "bun:sqlite";

/**
 * Schema version embedded in `PRAGMA user_version`. Open refuses (in either
 * mode) when the on-disk value disagrees. Migrations are not attempted —
 * the operator is expected to `rm history.db` and let the writer recreate.
 */
export const HISTORY_DB_USER_VERSION = 3;

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

/**
 * A single forward-only migration step. `target` is the `user_version` value
 * stamped after `apply` succeeds. Steps are applied in `target` order; each
 * step is responsible for transitioning the db from `target - 1` (or any
 * earlier state covered by `apply`) up to `target`.
 */
export interface Migration {
  readonly target: number;
  apply(db: Database): void;
}

// spans.events_json: optional JSON array of OTLP span events. NULL when the
// span carried no events. Each element: { name, time, attrs }. Populated for
// Claude Code's `tool.output` event (tool I/O bodies emitted under
// OTEL_LOG_TOOL_CONTENT=1) and any other span-attached annotations.
const CONSOLIDATED_SCHEMA_SQL = `
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
  attrs_json      TEXT NOT NULL DEFAULT '{}',
  events_json     TEXT
);

CREATE TABLE IF NOT EXISTS turn_events (
  invocation_id   TEXT NOT NULL REFERENCES invocations(id),
  conversation_id TEXT REFERENCES conversations(id),
  ts              TEXT NOT NULL,
  kind            TEXT NOT NULL,
  payload_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id           TEXT PRIMARY KEY REFERENCES conversations(id),
  summary      TEXT NOT NULL,
  captured_at  TEXT NOT NULL
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

-- ON DELETE 句は省略（暗黙の RESTRICT）。invocations / conversations テーブルと
-- 同じ方針: 削除機能は現時点で未実装のため、RESTRICT のままで問題ない。
CREATE TABLE IF NOT EXISTS log_records (
  invocation_id    TEXT NOT NULL REFERENCES invocations(id),
  conversation_id  TEXT NOT NULL REFERENCES conversations(id),
  prompt_id        TEXT NOT NULL,
  sequence         INTEGER NOT NULL,
  event_name       TEXT NOT NULL,
  time             TEXT NOT NULL,
  request_id       TEXT,
  attrs_json       TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (conversation_id, sequence)
);
-- invocation 単位でログをまとめて取得するためのインデックス（例: invocation 削除時の cascade 対象確認、invocation 単位のレコード数集計）
CREATE INDEX IF NOT EXISTS idx_log_records_invocation ON log_records(invocation_id);
-- prompt_id でフィルタする将来の turn 単位クエリ（WHERE conversation_id = ? AND prompt_id = ?）のためのインデックス。
-- 現時点では queryLogRecordsByConversation が conversation 全件取得するのみ。
CREATE INDEX IF NOT EXISTS idx_log_records_conv_prompt ON log_records(conversation_id, prompt_id);
-- This index exists for the reader-side JS in-memory join (matching
-- api_request event request_id against span trace_id). Currently only
-- queryLogRecordsByConversation fetches full conversation batches, but
-- the index is retained for future direct request_id lookups.
CREATE INDEX IF NOT EXISTS idx_log_records_request_id ON log_records(request_id) WHERE request_id IS NOT NULL;
`;

/**
 * Ordered list of forward migration steps. Each entry's `target` is the
 * `user_version` value after the step completes; entries must be sorted by
 * `target` ascending. New schema changes append a new step.
 */
export const HISTORY_DB_MIGRATIONS: readonly Migration[] = [
  {
    target: 3,
    apply: (db) => {
      db.run(CONSOLIDATED_SCHEMA_SQL);
    },
  },
];

interface UserVersionRow {
  user_version: number;
}

export function readUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as UserVersionRow | null;
  return row?.user_version ?? 0;
}

/**
 * Bring `db` up to the latest `HISTORY_DB_USER_VERSION` by running every
 * pending migration step in order.
 *
 * Behaviour:
 * - `current === 0` (fresh file): every step runs, ending at the latest target.
 * - `current === HISTORY_DB_USER_VERSION`: no steps run.
 * - Any other value (older but non-zero, or newer than this build knows about):
 *   throw `HistoryDbVersionMismatchError`. We do not attempt to migrate
 *   partially-stamped databases; the operator is expected to remove the file.
 *
 * Each step is wrapped in a transaction together with the `PRAGMA user_version`
 * stamp so a crash mid-step cannot leave the version pointer ahead of the
 * actual schema state.
 */
export function applyMigrations(db: Database, dbPath: string): void {
  const current = readUserVersion(db);
  if (current !== 0 && current !== HISTORY_DB_USER_VERSION) {
    throw new HistoryDbVersionMismatchError(dbPath, current);
  }
  for (const migration of HISTORY_DB_MIGRATIONS) {
    if (migration.target <= current) continue;
    const tx = db.transaction(() => {
      migration.apply(db);
      // `PRAGMA user_version = N` cannot be parameterised; `target` comes from
      // a compile-time const list so this isn't a SQL-injection vector.
      db.run(`PRAGMA user_version = ${migration.target}`);
    });
    tx();
  }
}
