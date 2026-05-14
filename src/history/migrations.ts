import type { Database } from "bun:sqlite";

/**
 * Schema version embedded in `PRAGMA user_version`.
 *
 * Writer-mode open auto-upgrades any file stamped at a known older version
 * (0 — fresh file — or 1, 2, ...) up to `HISTORY_DB_USER_VERSION`. A value
 * *greater* than this constant signals the file was written by a newer nas
 * binary and is refused via {@link HistoryDbVersionMismatchError}.
 *
 * Reader-mode open does not migrate: any mismatch (older or newer) is
 * refused. Reader callers are expected to either upgrade their nas binary
 * or run the writer (cli / hook) once to migrate the file in place.
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
 *
 * Each step's DDL is immutable: once a step ships, its `apply` body is frozen
 * so that historical version stamps remain meaningful. Schema evolution is
 * expressed by appending new steps with higher `target` values.
 */
export interface Migration {
  readonly target: number;
  apply(db: Database): void;
}

// v1 schema: initial set of 5 tables and 7 indexes. `spans.events_json` is
// added in M2; `conversation_summaries` and `log_records` arrive later.
const V1_SCHEMA_SQL = `
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

// v2 schema delta:
//  - new table `conversation_summaries`
//  - new column `spans.events_json TEXT` (optional JSON array of OTLP span
//    events; NULL when the span carried no events; populated for Claude
//    Code's `tool.output` event under OTEL_LOG_TOOL_CONTENT=1).
const V2_CONVERSATION_SUMMARIES_SQL = `
CREATE TABLE IF NOT EXISTS conversation_summaries (
  id           TEXT PRIMARY KEY REFERENCES conversations(id),
  summary      TEXT NOT NULL,
  captured_at  TEXT NOT NULL
);
`;

interface SpansColumnRow {
  name: string;
}

function spansHasEventsJsonColumn(db: Database): boolean {
  const rows = db
    .query("PRAGMA table_info(spans)")
    .all() as readonly SpansColumnRow[];
  return rows.some((row) => row.name === "events_json");
}

// v3 schema delta: log_records table plus three indexes.
// ON DELETE clauses are omitted (implicit RESTRICT), matching the policy on
// invocations / conversations: no delete paths exist yet, so RESTRICT is fine.
const V3_LOG_RECORDS_SQL = `
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

export const MIGRATION_V1: Migration = {
  target: 1,
  apply: (db) => {
    db.run(V1_SCHEMA_SQL);
  },
};

export const MIGRATION_V2: Migration = {
  target: 2,
  apply: (db) => {
    db.run(V2_CONVERSATION_SUMMARIES_SQL);
    // `ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite, so guard with
    // a `PRAGMA table_info` probe. This makes the step safe both for new dbs
    // arriving fresh through M1 and for any v1-stamped db that happens to
    // already carry the column.
    if (!spansHasEventsJsonColumn(db)) {
      db.run("ALTER TABLE spans ADD COLUMN events_json TEXT");
    }
  },
};

export const MIGRATION_V3: Migration = {
  target: 3,
  apply: (db) => {
    db.run(V3_LOG_RECORDS_SQL);
  },
};

/**
 * Ordered list of forward migration steps. Each entry's `target` is the
 * `user_version` value after the step completes; entries must be sorted by
 * `target` ascending. New schema changes append a new step.
 */
export const HISTORY_DB_MIGRATIONS: readonly Migration[] = [
  MIGRATION_V1,
  MIGRATION_V2,
  MIGRATION_V3,
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
 * Writer-only: this is invoked from the readwrite open path. Reader-mode
 * opens never call this — they refuse any mismatch (older or newer) so that
 * a read-only consumer cannot mutate a writer's file out from under it.
 *
 * Behaviour:
 * - `current > HISTORY_DB_USER_VERSION` (file from a newer nas build): throw
 *   `HistoryDbVersionMismatchError`. We cannot reason about a schema we do
 *   not know about.
 * - `current === HISTORY_DB_USER_VERSION`: no steps run.
 * - `current < HISTORY_DB_USER_VERSION` (fresh file at 0, or any known older
 *   stamp): every step with `target > current` runs in order, ending at the
 *   latest target.
 *
 * Each step is wrapped in a transaction together with the `PRAGMA user_version`
 * stamp so a crash mid-step cannot leave the version pointer ahead of the
 * actual schema state. If a step throws, the transaction rolls back and
 * `user_version` stays at its prior value, leaving the next open free to
 * retry from the same point.
 */
export function applyMigrations(db: Database, dbPath: string): void {
  const current = readUserVersion(db);
  if (current > HISTORY_DB_USER_VERSION) {
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
