import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  HISTORY_DB_USER_VERSION,
  MIGRATION_V1,
  MIGRATION_V2,
  MIGRATION_V3,
  readUserVersion,
} from "./migrations.ts";
import { _closeHistoryDb, openHistoryDb } from "./store.ts";

interface TmpHistoryDb {
  dir: string;
  dbPath: string;
}

async function makeTempDir(): Promise<TmpHistoryDb> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-migrations-"));
  return { dir, dbPath: path.join(dir, "history.db") };
}

async function cleanupTempDir(t: TmpHistoryDb): Promise<void> {
  _closeHistoryDb(t.dbPath);
  await rm(t.dir, { recursive: true, force: true }).catch(() => {});
}

interface NameRow {
  name: string;
}

function listTables(db: Database): readonly string[] {
  const rows = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as readonly NameRow[];
  return rows.map((r) => r.name);
}

function listIndexes(db: Database): readonly string[] {
  const rows = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as readonly NameRow[];
  return rows.map((r) => r.name);
}

function spansColumns(db: Database): readonly string[] {
  const rows = db.query("PRAGMA table_info(spans)").all() as readonly {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

test("MIGRATION_V1: empty db ends with v1 tables only (no events_json, no summaries, no log_records)", async () => {
  const t = await makeTempDir();
  try {
    const db = new Database(t.dbPath);
    try {
      MIGRATION_V1.apply(db);

      expect(listTables(db)).toEqual([
        "conversations",
        "invocations",
        "spans",
        "traces",
        "turn_events",
      ]);

      expect(listIndexes(db)).toEqual([
        "idx_conversations_lastseen",
        "idx_invocations_started",
        "idx_spans_trace",
        "idx_traces_conversation",
        "idx_traces_invocation",
        "idx_turn_events_conversation",
        "idx_turn_events_invocation",
      ]);

      const cols = spansColumns(db);
      expect(cols).not.toContain("events_json");
    } finally {
      db.close();
    }
  } finally {
    await cleanupTempDir(t);
  }
});

test("MIGRATION_V2: adds conversation_summaries and spans.events_json on top of v1", async () => {
  const t = await makeTempDir();
  try {
    const db = new Database(t.dbPath);
    try {
      MIGRATION_V1.apply(db);
      MIGRATION_V2.apply(db);

      const tables = listTables(db);
      expect(tables).toContain("conversation_summaries");
      // log_records arrives in v3, must not be present yet.
      expect(tables).not.toContain("log_records");

      const cols = spansColumns(db);
      expect(cols).toContain("events_json");
    } finally {
      db.close();
    }
  } finally {
    await cleanupTempDir(t);
  }
});

test("MIGRATION_V3: adds log_records table and its three indexes on top of v2", async () => {
  const t = await makeTempDir();
  try {
    const db = new Database(t.dbPath);
    try {
      MIGRATION_V1.apply(db);
      MIGRATION_V2.apply(db);
      MIGRATION_V3.apply(db);

      const tables = listTables(db);
      expect(tables).toContain("log_records");

      const indexes = listIndexes(db);
      expect(indexes).toContain("idx_log_records_invocation");
      expect(indexes).toContain("idx_log_records_conv_prompt");
      expect(indexes).toContain("idx_log_records_request_id");
    } finally {
      db.close();
    }
  } finally {
    await cleanupTempDir(t);
  }
});

test("openHistoryDb (readwrite) on fresh path produces final schema: 7 tables, 10 indexes, user_version = HISTORY_DB_USER_VERSION", async () => {
  const t = await makeTempDir();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });

    expect(readUserVersion(db)).toEqual(HISTORY_DB_USER_VERSION);

    expect(listTables(db)).toEqual([
      "conversation_summaries",
      "conversations",
      "invocations",
      "log_records",
      "spans",
      "traces",
      "turn_events",
    ]);

    expect(listIndexes(db)).toEqual([
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
    await cleanupTempDir(t);
  }
});

test("MIGRATION_V2: idempotent when spans.events_json already exists (no duplicate-column error)", async () => {
  const t = await makeTempDir();
  try {
    const db = new Database(t.dbPath);
    try {
      MIGRATION_V1.apply(db);
      // Simulate a v1-stamped db that already happens to carry the events_json
      // column (e.g. an out-of-band schema patch). Re-applying M2 must not
      // raise a duplicate-column error.
      db.run("ALTER TABLE spans ADD COLUMN events_json TEXT");

      // Should not throw.
      MIGRATION_V2.apply(db);

      const cols = spansColumns(db);
      // events_json must appear exactly once.
      expect(cols.filter((c) => c === "events_json").length).toEqual(1);
      expect(listTables(db)).toContain("conversation_summaries");
    } finally {
      db.close();
    }
  } finally {
    await cleanupTempDir(t);
  }
});
