import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { recordInvocationStart } from "./cli_lifecycle.ts";
import { appendConversationSummary, appendTurnEvent } from "./hook_writer.ts";
import { _closeHistoryDb, openHistoryDb } from "./store.ts";

interface TempEnv {
  dir: string;
  dbPath: string;
  prevXdg: string | undefined;
}

async function setupTempXdg(): Promise<TempEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-hook-writer-"));
  const prevXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dir;
  return {
    dir,
    dbPath: path.join(dir, "nas", "history.db"),
    prevXdg,
  };
}

async function teardownTempXdg(t: TempEnv): Promise<void> {
  _closeHistoryDb(t.dbPath);
  if (t.prevXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = t.prevXdg;
  await rm(t.dir, { recursive: true, force: true }).catch(() => {});
}

interface CapturedStderr {
  messages: string[];
  restore: () => void;
}

function captureStderr(): CapturedStderr {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map((a) => String(a)).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.error = original;
    },
  };
}

let env: TempEnv;
beforeEach(async () => {
  env = await setupTempXdg();
});
afterEach(async () => {
  await teardownTempXdg(env);
});

interface TurnEventRowDb {
  invocation_id: string;
  conversation_id: string | null;
  ts: string;
  kind: string;
  payload_json: string;
}

interface ConversationRowDb {
  id: string;
  agent: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

function readTurnEvents(invocationId: string): TurnEventRowDb[] {
  const db = openHistoryDb({ path: env.dbPath, mode: "readonly" });
  return db
    .query(
      "SELECT invocation_id, conversation_id, ts, kind, payload_json FROM turn_events WHERE invocation_id = ? ORDER BY rowid",
    )
    .all(invocationId) as TurnEventRowDb[];
}

function readConversation(id: string): ConversationRowDb | null {
  const db = openHistoryDb({ path: env.dbPath, mode: "readonly" });
  return (
    (db
      .query(
        "SELECT id, agent, first_seen_at, last_seen_at FROM conversations WHERE id = ?",
      )
      .get(id) as ConversationRowDb | null) ?? null
  );
}

// Seed an invocations row so the FK on turn_events.invocation_id is satisfied.
function seedInvocation(sessionId: string): void {
  const db = recordInvocationStart({
    sessionId,
    profileName: "dev",
    agent: "claude",
  });
  expect(db).not.toBeNull();
}

// ---------------------------------------------------------------------------
// happy paths
// ---------------------------------------------------------------------------

test("appendTurnEvent inserts a turn_event row and upserts conversations row", () => {
  seedInvocation("sess_a");
  appendTurnEvent({
    invocationId: "sess_a",
    conversationId: "conv_a",
    ts: "2026-04-11T10:00:00.000Z",
    kind: "start",
    payload: { hello: "world" },
  });

  const rows = readTurnEvents("sess_a");
  expect(rows).toHaveLength(1);
  expect(rows[0].conversation_id).toBe("conv_a");
  expect(rows[0].ts).toBe("2026-04-11T10:00:00.000Z");
  expect(rows[0].kind).toBe("start");
  expect(JSON.parse(rows[0].payload_json)).toEqual({ hello: "world" });

  const conv = readConversation("conv_a");
  expect(conv).not.toBeNull();
  expect(conv?.agent).toBeNull();
  expect(conv?.first_seen_at).toBe("2026-04-11T10:00:00.000Z");
  expect(conv?.last_seen_at).toBe("2026-04-11T10:00:00.000Z");
});

test("appendTurnEvent with null conversationId inserts row but no conversations row", () => {
  seedInvocation("sess_b");
  appendTurnEvent({
    invocationId: "sess_b",
    conversationId: null,
    ts: "2026-04-11T10:00:00.000Z",
    kind: "attention",
    payload: { foo: 1 },
  });

  const rows = readTurnEvents("sess_b");
  expect(rows).toHaveLength(1);
  expect(rows[0].conversation_id).toBeNull();

  const reader = openHistoryDb({ path: env.dbPath, mode: "readonly" });
  const count = (
    reader.query("SELECT COUNT(*) AS n FROM conversations").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

test("appendTurnEvent twice with same ids appends two rows (no PK)", () => {
  seedInvocation("sess_c");
  appendTurnEvent({
    invocationId: "sess_c",
    conversationId: "conv_c",
    ts: "2026-04-11T10:00:00.000Z",
    kind: "start",
    payload: {},
  });
  appendTurnEvent({
    invocationId: "sess_c",
    conversationId: "conv_c",
    ts: "2026-04-11T10:00:01.000Z",
    kind: "stop",
    payload: {},
  });

  const rows = readTurnEvents("sess_c");
  expect(rows).toHaveLength(2);
});

test("appendTurnEvent updates last_seen_at and preserves first_seen_at on re-append", () => {
  seedInvocation("sess_d");
  appendTurnEvent({
    invocationId: "sess_d",
    conversationId: "conv_d",
    ts: "2026-04-11T10:00:00.000Z",
    kind: "start",
    payload: {},
  });
  appendTurnEvent({
    invocationId: "sess_d",
    conversationId: "conv_d",
    ts: "2026-04-11T11:00:00.000Z",
    kind: "stop",
    payload: {},
  });

  const conv = readConversation("conv_d");
  expect(conv?.first_seen_at).toBe("2026-04-11T10:00:00.000Z");
  expect(conv?.last_seen_at).toBe("2026-04-11T11:00:00.000Z");
});

test("appendTurnEvent does not overwrite an existing non-null agent (COALESCE)", () => {
  seedInvocation("sess_e");
  // Simulate an OTLP receiver write that already classified the agent.
  const writer = openHistoryDb({ path: env.dbPath, mode: "readwrite" });
  writer
    .prepare(
      "INSERT INTO conversations (id, agent, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)",
    )
    .run(
      "conv_e",
      "claude",
      "2026-04-11T09:00:00.000Z",
      "2026-04-11T09:00:00.000Z",
    );

  // Hook now appends with agent=null; agent must remain "claude".
  appendTurnEvent({
    invocationId: "sess_e",
    conversationId: "conv_e",
    ts: "2026-04-11T10:00:00.000Z",
    kind: "start",
    payload: {},
  });

  const conv = readConversation("conv_e");
  expect(conv?.agent).toBe("claude");
});

// ---------------------------------------------------------------------------
// failure paths: never throw, warn to stderr
// ---------------------------------------------------------------------------

test("appendTurnEvent on schema mismatch warns and skips, does not throw", async () => {
  // Pre-create the history.db with a wrong user_version.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(env.dbPath), { recursive: true });
  const raw = new Database(env.dbPath, { create: true });
  raw.run("PRAGMA user_version = 999");
  raw.close();

  const cap = captureStderr();
  let threw: unknown;
  try {
    appendTurnEvent({
      invocationId: "sess_z",
      conversationId: "conv_z",
      ts: "2026-04-11T10:00:00.000Z",
      kind: "start",
      payload: {},
    });
  } catch (e) {
    threw = e;
  } finally {
    cap.restore();
  }

  expect(threw).toBeUndefined();
  expect(
    cap.messages.some(
      (m) =>
        m.includes("schema version mismatch") &&
        m.includes("Skipping turn_event"),
    ),
  ).toBe(true);

  // Confirm no turn_event row was inserted. (The schema mismatch path
  // throws *after* CREATE TABLE IF NOT EXISTS runs, so the table itself
  // may exist; what matters is that no insert reached it.)
  const probe = new Database(env.dbPath, { readonly: true });
  try {
    const tableExists = probe
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='turn_events'",
      )
      .get();
    if (tableExists !== null) {
      const count = (
        probe.query("SELECT COUNT(*) AS n FROM turn_events").get() as {
          n: number;
        }
      ).n;
      expect(count).toBe(0);
    }
  } finally {
    probe.close();
  }
});

test("appendTurnEvent on db open IO failure warns and skips, does not throw", async () => {
  // Point XDG_DATA_HOME at a regular file so mkdir of `nas/` underneath
  // it fails with ENOTDIR.
  const file = path.join(env.dir, "blocker");
  await Bun.write(file, "x");
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = file;

  const cap = captureStderr();
  let threw: unknown;
  try {
    appendTurnEvent({
      invocationId: "sess_io",
      conversationId: "conv_io",
      ts: "2026-04-11T10:00:00.000Z",
      kind: "start",
      payload: {},
    });
  } catch (e) {
    threw = e;
  } finally {
    cap.restore();
    process.env.XDG_DATA_HOME = prev;
  }

  expect(threw).toBeUndefined();
  expect(
    cap.messages.some(
      (m) =>
        m.includes("history db open failed") &&
        m.includes("Skipping turn_event"),
    ),
  ).toBe(true);
});

test("appendTurnEvent: cyclic-ref payload falls back to {} and warns", () => {
  seedInvocation("sess_cyc");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  const cap = captureStderr();
  let threw: unknown;
  try {
    appendTurnEvent({
      invocationId: "sess_cyc",
      conversationId: null,
      ts: "2026-05-01T10:00:00.000Z",
      kind: "stop",
      payload: cyclic,
    });
  } catch (e) {
    threw = e;
  } finally {
    cap.restore();
  }

  expect(threw).toBeUndefined();
  expect(
    cap.messages.some(
      (m) =>
        m.includes("payload serialize failed") &&
        m.includes("Storing empty payload"),
    ),
  ).toBe(true);

  const rows = readTurnEvents("sess_cyc");
  expect(rows).toHaveLength(1);
  expect(rows[0].payload_json).toBe("{}");
});

test("appendTurnEvent: warns and continues when insertTurnEvent fails", () => {
  seedInvocation("sess_partial");

  // Establish schema + cached writer handle via a happy-path append.
  appendTurnEvent({
    invocationId: "sess_partial",
    conversationId: "conv_partial",
    ts: "2026-05-01T10:00:00.000Z",
    kind: "stop",
    payload: { ok: true },
  });

  // Drop turn_events on the cached writer so the next insertTurnEvent
  // hits "no such table". The conversations upsert still succeeds.
  const writer = openHistoryDb({ path: env.dbPath, mode: "readwrite" });
  writer.exec("DROP TABLE turn_events");

  const cap = captureStderr();
  let threw: unknown;
  try {
    appendTurnEvent({
      invocationId: "sess_partial",
      conversationId: "conv_partial",
      ts: "2026-05-01T10:00:01.000Z",
      kind: "stop",
      payload: { ok: false },
    });
  } catch (e) {
    threw = e;
  } finally {
    cap.restore();
  }

  expect(threw).toBeUndefined();
  expect(
    cap.messages.some(
      (m) =>
        m.includes("history turn_event insert failed") &&
        m.includes("Skipping"),
    ),
  ).toBe(true);

  // The conversation upsert still ran: last_seen_at advanced.
  const conv = readConversation("conv_partial");
  expect(conv?.last_seen_at).toBe("2026-05-01T10:00:01.000Z");
});

// ---------------------------------------------------------------------------
// appendConversationSummary
// ---------------------------------------------------------------------------

interface SummaryRowDb {
  id: string;
  summary: string;
  captured_at: string;
}

function readSummary(id: string): SummaryRowDb | null {
  const db = openHistoryDb({ path: env.dbPath, mode: "readonly" });
  return (
    (db
      .query(
        "SELECT id, summary, captured_at FROM conversation_summaries WHERE id = ?",
      )
      .get(id) as SummaryRowDb | null) ?? null
  );
}

test("appendConversationSummary writes the supplied summary", () => {
  seedInvocation("sess_sum1");
  // Conversation row must exist for the FK on conversation_summaries.id.
  appendTurnEvent({
    invocationId: "sess_sum1",
    conversationId: "conv_sum1",
    ts: "2026-04-11T10:00:00.000Z",
    kind: "start",
    payload: {},
  });

  appendConversationSummary({
    conversationId: "conv_sum1",
    summary: "Refactor the auth flow",
    capturedAt: "2026-04-11T10:00:01.000Z",
  });

  const row = readSummary("conv_sum1");
  expect(row?.summary).toBe("Refactor the auth flow");
  expect(row?.captured_at).toBe("2026-04-11T10:00:01.000Z");
});

test("appendConversationSummary is idempotent (INSERT OR IGNORE)", () => {
  seedInvocation("sess_sum2");
  appendTurnEvent({
    invocationId: "sess_sum2",
    conversationId: "conv_sum2",
    ts: "2026-04-11T10:00:00.000Z",
    kind: "start",
    payload: {},
  });
  appendConversationSummary({
    conversationId: "conv_sum2",
    summary: "First prompt",
    capturedAt: "2026-04-11T10:00:01.000Z",
  });

  // Second call with a different summary must NOT overwrite.
  appendConversationSummary({
    conversationId: "conv_sum2",
    summary: "Different later prompt",
    capturedAt: "2026-04-11T11:00:00.000Z",
  });

  const row = readSummary("conv_sum2");
  expect(row?.summary).toBe("First prompt");
  expect(row?.captured_at).toBe("2026-04-11T10:00:01.000Z");
});

test("appendConversationSummary: schema mismatch warns and skips", async () => {
  await rm(path.dirname(env.dbPath), { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(env.dbPath), { recursive: true });
  const raw = new Database(env.dbPath, { create: true });
  raw.run("PRAGMA user_version = 999");
  raw.close();

  const cap = captureStderr();
  let threw: unknown;
  try {
    appendConversationSummary({
      conversationId: "conv_sum_mismatch",
      summary: "hello there",
      capturedAt: "2026-04-11T10:00:01.000Z",
    });
  } catch (e) {
    threw = e;
  } finally {
    cap.restore();
  }

  expect(threw).toBeUndefined();
  expect(
    cap.messages.some(
      (m) =>
        m.includes("schema version mismatch") &&
        m.includes("Skipping conversation summary"),
    ),
  ).toBe(true);
});

test("appendTurnEvent: payload_json contains the serialized payload", () => {
  seedInvocation("sess_p");
  const payload = { a: 1, b: "two", nested: { c: [1, 2, 3] } };
  appendTurnEvent({
    invocationId: "sess_p",
    conversationId: null,
    ts: "2026-04-11T10:00:00.000Z",
    kind: "start",
    payload,
  });

  const rows = readTurnEvents("sess_p");
  expect(JSON.parse(rows[0].payload_json)).toEqual(payload);
});
