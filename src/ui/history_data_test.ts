import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  _closeHistoryDb,
  openHistoryDb,
  upsertConversation,
} from "../history/store.ts";
import {
  readConversationDetail,
  readConversationList,
  readInvocationDetail,
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
