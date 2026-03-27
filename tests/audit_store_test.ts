import { assertEquals, assertThrows } from "@std/assert";
import {
  appendAuditLog,
  queryAuditLogs,
  resolveAuditDir,
} from "../src/audit/store.ts";
import type { AuditLogEntry } from "../src/audit/types.ts";
import * as path from "@std/path";

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

Deno.test("appendAuditLog: writes and reads back entries", async () => {
  const dir = await Deno.makeTempDir({ prefix: "nas-audit-" });
  try {
    const entry = makeEntry();
    await appendAuditLog(entry, dir);

    const results = await queryAuditLogs({}, dir);
    assertEquals(results.length, 1);
    assertEquals(results[0].id, entry.id);
    assertEquals(results[0].domain, "network");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("appendAuditLog: multiple entries go to same date file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "nas-audit-" });
  try {
    const e1 = makeEntry({ requestId: "req-1" });
    const e2 = makeEntry({ requestId: "req-2" });
    await appendAuditLog(e1, dir);
    await appendAuditLog(e2, dir);

    const results = await queryAuditLogs({}, dir);
    assertEquals(results.length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("appendAuditLog: different dates go to different files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "nas-audit-" });
  try {
    const e1 = makeEntry({ timestamp: "2026-03-27T10:00:00Z" });
    const e2 = makeEntry({ timestamp: "2026-03-28T10:00:00Z" });
    await appendAuditLog(e1, dir);
    await appendAuditLog(e2, dir);

    const all = await queryAuditLogs({}, dir);
    assertEquals(all.length, 2);

    const day27 = await queryAuditLogs(
      { startDate: "2026-03-27", endDate: "2026-03-27" },
      dir,
    );
    assertEquals(day27.length, 1);
    assertEquals(day27[0].timestamp, "2026-03-27T10:00:00Z");

    const day28 = await queryAuditLogs(
      { startDate: "2026-03-28", endDate: "2026-03-28" },
      dir,
    );
    assertEquals(day28.length, 1);
    assertEquals(day28[0].timestamp, "2026-03-28T10:00:00Z");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("queryAuditLogs: filter by sessionId", async () => {
  const dir = await Deno.makeTempDir({ prefix: "nas-audit-" });
  try {
    await appendAuditLog(makeEntry({ sessionId: "sess-a" }), dir);
    await appendAuditLog(makeEntry({ sessionId: "sess-b" }), dir);

    const results = await queryAuditLogs({ sessionId: "sess-a" }, dir);
    assertEquals(results.length, 1);
    assertEquals(results[0].sessionId, "sess-a");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("queryAuditLogs: filter by domain", async () => {
  const dir = await Deno.makeTempDir({ prefix: "nas-audit-" });
  try {
    await appendAuditLog(makeEntry({ domain: "network" }), dir);
    await appendAuditLog(makeEntry({ domain: "hostexec" }), dir);

    const networkOnly = await queryAuditLogs({ domain: "network" }, dir);
    assertEquals(networkOnly.length, 1);
    assertEquals(networkOnly[0].domain, "network");

    const hostexecOnly = await queryAuditLogs({ domain: "hostexec" }, dir);
    assertEquals(hostexecOnly.length, 1);
    assertEquals(hostexecOnly[0].domain, "hostexec");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("queryAuditLogs: filter by date range", async () => {
  const dir = await Deno.makeTempDir({ prefix: "nas-audit-" });
  try {
    await appendAuditLog(makeEntry({ timestamp: "2026-03-26T10:00:00Z" }), dir);
    await appendAuditLog(makeEntry({ timestamp: "2026-03-27T10:00:00Z" }), dir);
    await appendAuditLog(makeEntry({ timestamp: "2026-03-28T10:00:00Z" }), dir);

    const results = await queryAuditLogs(
      { startDate: "2026-03-27", endDate: "2026-03-27" },
      dir,
    );
    assertEquals(results.length, 1);
    assertEquals(results[0].timestamp, "2026-03-27T10:00:00Z");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("queryAuditLogs: empty directory returns empty array", async () => {
  const dir = await Deno.makeTempDir({ prefix: "nas-audit-" });
  try {
    const results = await queryAuditLogs({}, dir);
    assertEquals(results, []);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("queryAuditLogs: non-existent directory returns empty array", async () => {
  const results = await queryAuditLogs({}, "/tmp/nas-audit-nonexistent-dir");
  assertEquals(results, []);
});

Deno.test("readJsonlFile: skips malformed JSON lines", async () => {
  const dir = await Deno.makeTempDir({ prefix: "nas-audit-" });
  try {
    const entry = makeEntry();
    await appendAuditLog(entry, dir);

    // Append a malformed line to the JSONL file
    const filePath = path.join(dir, "2026-03-28.jsonl");
    await Deno.writeTextFile(filePath, "NOT VALID JSON\n", { append: true });

    const results = await queryAuditLogs({}, dir);
    assertEquals(results.length, 1);
    assertEquals(results[0].id, entry.id);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("resolveAuditDir: uses XDG_DATA_HOME when set", () => {
  const originalXdg = Deno.env.get("XDG_DATA_HOME");
  try {
    Deno.env.set("XDG_DATA_HOME", "/tmp/custom-data");
    const result = resolveAuditDir();
    assertEquals(result, "/tmp/custom-data/nas/audit");
  } finally {
    if (originalXdg !== undefined) {
      Deno.env.set("XDG_DATA_HOME", originalXdg);
    } else {
      Deno.env.delete("XDG_DATA_HOME");
    }
  }
});

Deno.test("resolveAuditDir: falls back to HOME/.local/share when XDG_DATA_HOME is unset", () => {
  const originalXdg = Deno.env.get("XDG_DATA_HOME");
  const originalHome = Deno.env.get("HOME");
  try {
    Deno.env.delete("XDG_DATA_HOME");
    Deno.env.set("HOME", "/tmp/fakehome");
    const result = resolveAuditDir();
    assertEquals(result, "/tmp/fakehome/.local/share/nas/audit");
  } finally {
    if (originalXdg !== undefined) {
      Deno.env.set("XDG_DATA_HOME", originalXdg);
    } else {
      Deno.env.delete("XDG_DATA_HOME");
    }
    if (originalHome !== undefined) {
      Deno.env.set("HOME", originalHome);
    } else {
      Deno.env.delete("HOME");
    }
  }
});

Deno.test("resolveAuditDir: throws when neither XDG_DATA_HOME nor HOME is set", () => {
  const originalXdg = Deno.env.get("XDG_DATA_HOME");
  const originalHome = Deno.env.get("HOME");
  try {
    Deno.env.delete("XDG_DATA_HOME");
    Deno.env.delete("HOME");
    assertThrows(
      () => resolveAuditDir(),
      Error,
      "Cannot resolve audit directory",
    );
  } finally {
    if (originalXdg !== undefined) {
      Deno.env.set("XDG_DATA_HOME", originalXdg);
    } else {
      Deno.env.delete("XDG_DATA_HOME");
    }
    if (originalHome !== undefined) {
      Deno.env.set("HOME", originalHome);
    } else {
      Deno.env.delete("HOME");
    }
  }
});

Deno.test("queryAuditLogs: compound filter with sessionId and domain", async () => {
  const dir = await Deno.makeTempDir({ prefix: "nas-audit-" });
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
      { sessionId: "sess-a", domain: "network" },
      dir,
    );
    assertEquals(results.length, 1);
    assertEquals(results[0].sessionId, "sess-a");
    assertEquals(results[0].domain, "network");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
