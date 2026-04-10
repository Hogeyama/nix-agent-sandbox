import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { appendAuditLog, queryAuditLogs, resolveAuditDir } from "./store.ts";
import type { AuditLogEntry } from "./types.ts";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

function makeEntry(
  overrides: Partial<AuditLogEntry> = {},
): AuditLogEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: "2026-03-28T12:00:00Z",
    domain: "network",
    sessionId: "sess-1",
    requestId: "req-1",
    decision: "allow",
    reason: "matched allowlist",
    ...overrides,
  };
}

test("appendAuditLog: writes and reads back entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    const entry = makeEntry();
    await appendAuditLog(entry, dir);

    const results = await queryAuditLogs({}, dir);
    expect(results.length).toEqual(1);
    expect(results[0].id).toEqual(entry.id);
    expect(results[0].domain).toEqual("network");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("appendAuditLog: multiple entries go to same date file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    const e1 = makeEntry({ requestId: "req-1" });
    const e2 = makeEntry({ requestId: "req-2" });
    await appendAuditLog(e1, dir);
    await appendAuditLog(e2, dir);

    const results = await queryAuditLogs({}, dir);
    expect(results.length).toEqual(2);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("appendAuditLog: different dates go to different files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    const e1 = makeEntry({ timestamp: "2026-03-27T10:00:00Z" });
    const e2 = makeEntry({ timestamp: "2026-03-28T10:00:00Z" });
    await appendAuditLog(e1, dir);
    await appendAuditLog(e2, dir);

    const all = await queryAuditLogs({}, dir);
    expect(all.length).toEqual(2);

    const day27 = await queryAuditLogs(
      { startDate: "2026-03-27", endDate: "2026-03-27" },
      dir,
    );
    expect(day27.length).toEqual(1);
    expect(day27[0].timestamp).toEqual("2026-03-27T10:00:00Z");

    const day28 = await queryAuditLogs(
      { startDate: "2026-03-28", endDate: "2026-03-28" },
      dir,
    );
    expect(day28.length).toEqual(1);
    expect(day28[0].timestamp).toEqual("2026-03-28T10:00:00Z");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("queryAuditLogs: filter by sessionIds set", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    await appendAuditLog(makeEntry({ sessionId: "sess-a" }), dir);
    await appendAuditLog(makeEntry({ sessionId: "sess-b" }), dir);
    await appendAuditLog(makeEntry({ sessionId: "sess-c" }), dir);

    // Single-element set matches only that session
    const single = await queryAuditLogs(
      { sessionIds: ["sess-a"] },
      dir,
    );
    expect(single.length).toEqual(1);
    expect(single[0].sessionId).toEqual("sess-a");

    // Multi-element set matches any member
    const multi = await queryAuditLogs(
      { sessionIds: ["sess-a", "sess-c"] },
      dir,
    );
    const ids = new Set(multi.map((e) => e.sessionId));
    expect(ids.size).toEqual(2);
    expect(ids.has("sess-a")).toEqual(true);
    expect(ids.has("sess-c")).toEqual(true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("queryAuditLogs: filter by sessionContains substring", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    await appendAuditLog(makeEntry({ sessionId: "alpha-42" }), dir);
    await appendAuditLog(makeEntry({ sessionId: "beta-17" }), dir);
    await appendAuditLog(makeEntry({ sessionId: "ALPHA-99" }), dir);

    // Case-insensitive substring match
    const results = await queryAuditLogs(
      { sessionContains: "alpha" },
      dir,
    );
    const ids = new Set(results.map((e) => e.sessionId));
    expect(ids.size).toEqual(2);
    expect(ids.has("alpha-42")).toEqual(true);
    expect(ids.has("ALPHA-99")).toEqual(true);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("queryAuditLogs: filter by domain", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    await appendAuditLog(makeEntry({ domain: "network" }), dir);
    await appendAuditLog(makeEntry({ domain: "hostexec" }), dir);

    const networkOnly = await queryAuditLogs({ domain: "network" }, dir);
    expect(networkOnly.length).toEqual(1);
    expect(networkOnly[0].domain).toEqual("network");

    const hostexecOnly = await queryAuditLogs({ domain: "hostexec" }, dir);
    expect(hostexecOnly.length).toEqual(1);
    expect(hostexecOnly[0].domain).toEqual("hostexec");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("queryAuditLogs: filter by before cursor", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    // Three entries spread across two days
    await appendAuditLog(
      makeEntry({ timestamp: "2026-03-26T10:00:00Z", requestId: "a" }),
      dir,
    );
    await appendAuditLog(
      makeEntry({ timestamp: "2026-03-27T09:00:00Z", requestId: "b" }),
      dir,
    );
    await appendAuditLog(
      makeEntry({ timestamp: "2026-03-27T12:00:00Z", requestId: "c" }),
      dir,
    );

    // Cursor in the middle of day 27 should include a and b but not c
    // (before is exclusive).
    const olderThanNoon = await queryAuditLogs(
      { before: "2026-03-27T12:00:00Z" },
      dir,
    );
    expect(olderThanNoon.length).toEqual(2);
    const ids = new Set(olderThanNoon.map((e) => e.requestId));
    expect(ids.has("a")).toEqual(true);
    expect(ids.has("b")).toEqual(true);
    expect(ids.has("c")).toEqual(false);

    // Cursor before all entries yields nothing
    const empty = await queryAuditLogs(
      { before: "2026-03-26T00:00:00Z" },
      dir,
    );
    expect(empty.length).toEqual(0);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("queryAuditLogs: filter by date range", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    await appendAuditLog(makeEntry({ timestamp: "2026-03-26T10:00:00Z" }), dir);
    await appendAuditLog(makeEntry({ timestamp: "2026-03-27T10:00:00Z" }), dir);
    await appendAuditLog(makeEntry({ timestamp: "2026-03-28T10:00:00Z" }), dir);

    const results = await queryAuditLogs(
      { startDate: "2026-03-27", endDate: "2026-03-27" },
      dir,
    );
    expect(results.length).toEqual(1);
    expect(results[0].timestamp).toEqual("2026-03-27T10:00:00Z");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("queryAuditLogs: empty directory returns empty array", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    const results = await queryAuditLogs({}, dir);
    expect(results).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("queryAuditLogs: non-existent directory returns empty array", async () => {
  const results = await queryAuditLogs({}, "/tmp/nas-audit-nonexistent-dir");
  expect(results).toEqual([]);
});

test("readJsonlFile: skips malformed JSON lines", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    const entry = makeEntry();
    await appendAuditLog(entry, dir);

    // Append a malformed line to the JSONL file
    const filePath = path.join(dir, "2026-03-28.jsonl");
    await writeFile(filePath, "NOT VALID JSON\n", { flag: "a" });

    const results = await queryAuditLogs({}, dir);
    expect(results.length).toEqual(1);
    expect(results[0].id).toEqual(entry.id);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("resolveAuditDir: uses XDG_DATA_HOME when set", () => {
  const originalXdg = process.env["XDG_DATA_HOME"];
  try {
    process.env["XDG_DATA_HOME"] = "/tmp/custom-data";
    const result = resolveAuditDir();
    expect(result).toEqual("/tmp/custom-data/nas/audit");
  } finally {
    if (originalXdg !== undefined) {
      process.env["XDG_DATA_HOME"] = originalXdg;
    } else {
      delete process.env["XDG_DATA_HOME"];
    }
  }
});

test("resolveAuditDir: falls back to HOME/.local/share when XDG_DATA_HOME is unset", () => {
  const originalXdg = process.env["XDG_DATA_HOME"];
  const originalHome = process.env["HOME"];
  try {
    delete process.env["XDG_DATA_HOME"];
    process.env["HOME"] = "/tmp/fakehome";
    const result = resolveAuditDir();
    expect(result).toEqual("/tmp/fakehome/.local/share/nas/audit");
  } finally {
    if (originalXdg !== undefined) {
      process.env["XDG_DATA_HOME"] = originalXdg;
    } else {
      delete process.env["XDG_DATA_HOME"];
    }
    if (originalHome !== undefined) {
      process.env["HOME"] = originalHome;
    } else {
      delete process.env["HOME"];
    }
  }
});

test("resolveAuditDir: throws when neither XDG_DATA_HOME nor HOME is set", () => {
  const originalXdg = process.env["XDG_DATA_HOME"];
  const originalHome = process.env["HOME"];
  try {
    delete process.env["XDG_DATA_HOME"];
    delete process.env["HOME"];
    expect(() => resolveAuditDir()).toThrow("Cannot resolve audit directory");
  } finally {
    if (originalXdg !== undefined) {
      process.env["XDG_DATA_HOME"] = originalXdg;
    } else {
      delete process.env["XDG_DATA_HOME"];
    }
    if (originalHome !== undefined) {
      process.env["HOME"] = originalHome;
    } else {
      delete process.env["HOME"];
    }
  }
});

test("queryAuditLogs: compound filter with sessionIds and domain", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    await appendAuditLog(
      makeEntry({ sessionId: "sess-a", domain: "network" }),
      dir,
    );
    await appendAuditLog(
      makeEntry({ sessionId: "sess-a", domain: "hostexec" }),
      dir,
    );
    await appendAuditLog(
      makeEntry({ sessionId: "sess-b", domain: "network" }),
      dir,
    );

    const results = await queryAuditLogs(
      { sessionIds: ["sess-a"], domain: "network" },
      dir,
    );
    expect(results.length).toEqual(1);
    expect(results[0].sessionId).toEqual("sess-a");
    expect(results[0].domain).toEqual("network");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
