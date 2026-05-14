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
  MIGRATION_V4,
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

test("openHistoryDb (readwrite) on fresh path produces final schema: 5 tables, 8 indexes, user_version = HISTORY_DB_USER_VERSION", async () => {
  const t = await makeTempDir();
  try {
    const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });

    expect(readUserVersion(db)).toEqual(HISTORY_DB_USER_VERSION);

    expect(listTables(db)).toEqual([
      "conversations",
      "invocations",
      "log_records",
      "spans",
      "traces",
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

test("MIGRATION_V4: drops turn_events and conversation_summaries from a v3-shape db", async () => {
  const t = await makeTempDir();
  try {
    const db = new Database(t.dbPath);
    try {
      MIGRATION_V1.apply(db);
      MIGRATION_V2.apply(db);
      MIGRATION_V3.apply(db);

      // Pre-condition: v3 carries both hook-side tables and their indexes.
      const tablesBefore = listTables(db);
      expect(tablesBefore).toContain("turn_events");
      expect(tablesBefore).toContain("conversation_summaries");
      const indexesBefore = listIndexes(db);
      expect(indexesBefore).toContain("idx_turn_events_invocation");
      expect(indexesBefore).toContain("idx_turn_events_conversation");

      MIGRATION_V4.apply(db);

      const tablesAfter = listTables(db);
      expect(tablesAfter).not.toContain("turn_events");
      expect(tablesAfter).not.toContain("conversation_summaries");
      // Other tables survive untouched.
      expect(tablesAfter).toContain("invocations");
      expect(tablesAfter).toContain("conversations");
      expect(tablesAfter).toContain("traces");
      expect(tablesAfter).toContain("spans");
      expect(tablesAfter).toContain("log_records");

      // Hook-side indexes are gone (SQLite would drop them on DROP TABLE
      // anyway, but the migration drops them explicitly first).
      const indexesAfter = listIndexes(db);
      expect(indexesAfter).not.toContain("idx_turn_events_invocation");
      expect(indexesAfter).not.toContain("idx_turn_events_conversation");
    } finally {
      db.close();
    }
  } finally {
    await cleanupTempDir(t);
  }
});

test("MIGRATION_V4: idempotent on a db that has never carried the hook tables", async () => {
  const t = await makeTempDir();
  try {
    const db = new Database(t.dbPath);
    try {
      // Lay down only invocations / conversations so the v4 drop targets
      // are guaranteed absent. The migration must succeed via IF EXISTS.
      db.run(
        "CREATE TABLE invocations (id TEXT PRIMARY KEY, started_at TEXT NOT NULL)",
      );
      db.run(
        "CREATE TABLE conversations (id TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)",
      );

      // Should not throw.
      MIGRATION_V4.apply(db);

      const tables = listTables(db);
      expect(tables).not.toContain("turn_events");
      expect(tables).not.toContain("conversation_summaries");
    } finally {
      db.close();
    }
  } finally {
    await cleanupTempDir(t);
  }
});

test("writer open auto-upgrades a v3-stamped db to HISTORY_DB_USER_VERSION (=4) and removes turn_events / conversation_summaries", async () => {
  const t = await makeTempDir();
  try {
    const raw = new Database(t.dbPath);
    try {
      MIGRATION_V1.apply(raw);
      MIGRATION_V2.apply(raw);
      MIGRATION_V3.apply(raw);
      raw.run("PRAGMA user_version = 3");
    } finally {
      raw.close();
    }

    const writer = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    expect(readUserVersion(writer)).toEqual(HISTORY_DB_USER_VERSION);

    const tables = listTables(writer);
    expect(tables).not.toContain("turn_events");
    expect(tables).not.toContain("conversation_summaries");
    expect(tables).toContain("log_records");
  } finally {
    await cleanupTempDir(t);
  }
});
