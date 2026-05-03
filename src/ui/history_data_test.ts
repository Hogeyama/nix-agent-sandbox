import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  _closeHistoryDb,
  insertSpans,
  insertTurnEvent,
  openHistoryDb,
  upsertConversation,
  upsertInvocation,
  upsertTrace,
} from "../history/store.ts";
import {
  readConversationDetail,
  readConversationList,
  readConversationModelTokenTotals,
  readInvocationDetail,
  readModelTokenTotals,
} from "./history_data.ts";

interface Tmp {
  dir: string;
  dbPath: string;
}

async function makeTempDir(): Promise<Tmp> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-ui-history-"));
  return { dir, dbPath: path.join(dir, "history.db") };
}

async function cleanup(t: Tmp): Promise<void> {
  _closeHistoryDb(t.dbPath);
  await rm(t.dir, { recursive: true, force: true }).catch(() => {});
}

test("readConversationList: returns [] when db file does not exist", async () => {
  const t = await makeTempDir();
  try {
    expect(readConversationList({ dbPath: t.dbPath })).toEqual([]);
  } finally {
    await cleanup(t);
  }
});

test("readConversationDetail / readInvocationDetail: return null when db file does not exist", async () => {
  const t = await makeTempDir();
  try {
    expect(readConversationDetail("anything", { dbPath: t.dbPath })).toBeNull();
    expect(readInvocationDetail("anything", { dbPath: t.dbPath })).toBeNull();
  } finally {
    await cleanup(t);
  }
});

test("readConversationList: reads rows written by a separate writer handle", async () => {
  const t = await makeTempDir();
  try {
    const writer = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertConversation(writer, {
      id: "conv_a",
      agent: "claude",
      firstSeenAt: "2026-05-01T10:00:00Z",
      lastSeenAt: "2026-05-01T10:00:00Z",
    });
    upsertInvocation(writer, {
      id: "sess_a",
      profile: "default",
      agent: "claude",
      worktreePath: "/tmp/wt",
      startedAt: "2026-05-01T10:00:00Z",
      endedAt: null,
      exitReason: null,
    });
    insertTurnEvent(writer, {
      invocationId: "sess_a",
      conversationId: "conv_a",
      ts: "2026-05-01T10:00:00Z",
      kind: "user_prompt",
      payloadJson: "{}",
    });

    const list = readConversationList({ dbPath: t.dbPath });
    expect(list.length).toEqual(1);
    expect(list[0].id).toEqual("conv_a");
    expect(list[0].agent).toEqual("claude");
    // No spans / events — aggregates default to 0, not NULL.
    expect(list[0].spanCount).toEqual(0);
    expect(list[0].inputTokensTotal).toEqual(0);
  } finally {
    await cleanup(t);
  }
});

test("readConversationDetail: missing id returns null even when db is healthy", async () => {
  const t = await makeTempDir();
  try {
    openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    expect(readConversationDetail("nope", { dbPath: t.dbPath })).toBeNull();
  } finally {
    await cleanup(t);
  }
});

test("readers return []/null when the db file is not a valid SQLite database", async () => {
  const t = await makeTempDir();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    // Garbage bytes — Database open (or the immediate user_version probe)
    // will throw with something other than HistoryDbVersionMismatchError.
    await writeFile(
      t.dbPath,
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]),
    );

    expect(readConversationList({ dbPath: t.dbPath })).toEqual([]);
    expect(readConversationDetail("any", { dbPath: t.dbPath })).toBeNull();
    expect(readInvocationDetail("any", { dbPath: t.dbPath })).toBeNull();
  } finally {
    console.warn = originalWarn;
    await cleanup(t);
  }
});

test("schema mismatch is swallowed: reader returns []/null, no throw", async () => {
  const t = await makeTempDir();
  try {
    // Materialise a fresh db, then tamper user_version out-of-band.
    openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    _closeHistoryDb(t.dbPath);

    const raw = new Database(t.dbPath);
    raw.run("PRAGMA user_version = 999");
    raw.close();

    // Each call opens its own handle (cached after the first), so all three
    // exercise the version-mismatch path.
    expect(readConversationList({ dbPath: t.dbPath })).toEqual([]);
    expect(readConversationDetail("x", { dbPath: t.dbPath })).toBeNull();
    expect(readInvocationDetail("x", { dbPath: t.dbPath })).toBeNull();
  } finally {
    await cleanup(t);
  }
});

test("readModelTokenTotals: returns [] when db file does not exist", async () => {
  const t = await makeTempDir();
  try {
    expect(
      readModelTokenTotals("2026-04-01T00:00:00Z", { dbPath: t.dbPath }),
    ).toEqual([]);
  } finally {
    await cleanup(t);
  }
});

test("readModelTokenTotals: aggregates per-model totals from a writer-populated db", async () => {
  const t = await makeTempDir();
  try {
    const writer = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(writer, {
      id: "sess_a",
      profile: "default",
      agent: "claude",
      worktreePath: "/tmp/wt",
      startedAt: "2026-04-15T10:00:00Z",
      endedAt: null,
      exitReason: null,
    });
    upsertConversation(writer, {
      id: "conv_a",
      agent: "claude",
      firstSeenAt: "2026-04-15T10:00:00Z",
      lastSeenAt: "2026-04-15T10:00:00Z",
    });
    upsertTrace(writer, {
      traceId: "trace_a",
      invocationId: "sess_a",
      conversationId: "conv_a",
      startedAt: "2026-04-15T10:00:00Z",
      endedAt: null,
    });
    insertSpans(writer, [
      {
        spanId: "s1",
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
        startedAt: "2026-04-15T10:00:00Z",
        endedAt: "2026-04-15T10:00:01Z",
        attrsJson: "{}",
      },
    ]);

    const totals = readModelTokenTotals("2026-04-01T00:00:00Z", {
      dbPath: t.dbPath,
    });
    expect(totals.length).toEqual(1);
    expect(totals[0].model).toEqual("claude-sonnet");
    expect(totals[0].inputTokens).toEqual(100);
    expect(totals[0].outputTokens).toEqual(200);
    expect(totals[0].cacheRead).toEqual(10);
    expect(totals[0].cacheWrite).toEqual(20);
  } finally {
    await cleanup(t);
  }
});

test("readModelTokenTotals: returns [] when the db file is not a valid SQLite database", async () => {
  const t = await makeTempDir();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await writeFile(
      t.dbPath,
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]),
    );
    expect(
      readModelTokenTotals("2026-04-01T00:00:00Z", { dbPath: t.dbPath }),
    ).toEqual([]);
  } finally {
    console.warn = originalWarn;
    await cleanup(t);
  }
});

test("readModelTokenTotals: schema mismatch is swallowed, returns []", async () => {
  const t = await makeTempDir();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    _closeHistoryDb(t.dbPath);

    const raw = new Database(t.dbPath);
    raw.run("PRAGMA user_version = 999");
    raw.close();

    expect(
      readModelTokenTotals("2026-04-01T00:00:00Z", { dbPath: t.dbPath }),
    ).toEqual([]);
  } finally {
    console.warn = originalWarn;
    await cleanup(t);
  }
});

test("readConversationModelTokenTotals: returns [] when db file does not exist", async () => {
  const t = await makeTempDir();
  try {
    expect(
      readConversationModelTokenTotals("conv_a", { dbPath: t.dbPath }),
    ).toEqual([]);
  } finally {
    await cleanup(t);
  }
});

test("readConversationModelTokenTotals: returns [] when the db file is not a valid SQLite database", async () => {
  const t = await makeTempDir();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await writeFile(
      t.dbPath,
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]),
    );
    expect(
      readConversationModelTokenTotals("conv_a", { dbPath: t.dbPath }),
    ).toEqual([]);
  } finally {
    console.warn = originalWarn;
    await cleanup(t);
  }
});

test("readConversationModelTokenTotals: aggregates per-model totals from a writer-populated db", async () => {
  const t = await makeTempDir();
  try {
    const writer = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
    upsertInvocation(writer, {
      id: "sess_a",
      profile: "default",
      agent: "claude",
      worktreePath: "/tmp/wt",
      startedAt: "2026-04-15T10:00:00Z",
      endedAt: null,
      exitReason: null,
    });
    upsertConversation(writer, {
      id: "conv_a",
      agent: "claude",
      firstSeenAt: "2026-04-15T10:00:00Z",
      lastSeenAt: "2026-04-15T10:00:00Z",
    });
    upsertTrace(writer, {
      traceId: "trace_a",
      invocationId: "sess_a",
      conversationId: "conv_a",
      startedAt: "2026-04-15T10:00:00Z",
      endedAt: null,
    });
    insertSpans(writer, [
      {
        spanId: "s1",
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
        startedAt: "2026-04-15T10:00:00Z",
        endedAt: "2026-04-15T10:00:01Z",
        attrsJson: "{}",
      },
      {
        spanId: "s2",
        parentSpanId: null,
        traceId: "trace_a",
        spanName: "chat",
        kind: "chat",
        model: "claude-haiku",
        inTok: 5,
        outTok: 6,
        cacheR: 1,
        cacheW: 2,
        durationMs: 100,
        startedAt: "2026-04-15T10:01:00Z",
        endedAt: "2026-04-15T10:01:01Z",
        attrsJson: "{}",
      },
    ]);

    const totals = readConversationModelTokenTotals("conv_a", {
      dbPath: t.dbPath,
    });
    expect(totals.map((r) => r.model)).toEqual([
      "claude-haiku",
      "claude-sonnet",
    ]);
    const sonnet = totals.find((r) => r.model === "claude-sonnet");
    expect(sonnet?.inputTokens).toEqual(100);
    expect(sonnet?.outputTokens).toEqual(200);
    expect(sonnet?.cacheRead).toEqual(10);
    expect(sonnet?.cacheWrite).toEqual(20);
  } finally {
    await cleanup(t);
  }
});
