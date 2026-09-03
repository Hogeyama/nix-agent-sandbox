import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  _closeAuditDb,
  appendAuditLog,
  getRequestBody,
  queryAuditLogs,
  resolveAuditDir,
  storeRequestBody,
} from "./store.ts";
import type { AuditLogEntry } from "./types.ts";

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
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

test("appendAuditLog: round-trips request-policy outcome fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-request-policy-"));
  try {
    await appendAuditLog(
      makeEntry({
        requestId: "req-request-policy",
        phase: "request-policy",
        ruleId: "anthropic.messages.create",
        method: "POST",
        route: "/v1/messages",
        requestPolicyKind: "json",
        requestPolicyResult: "rewrite",
        reason: "masked-json",
      }),
      dir,
    );

    const [entry] = await queryAuditLogs({}, dir);
    expect(entry).toMatchObject({
      phase: "request-policy",
      ruleId: "anthropic.messages.create",
      method: "POST",
      route: "/v1/messages",
      requestPolicyKind: "json",
      requestPolicyResult: "rewrite",
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("appendAuditLog: stores body diagnostics as nullable JSON metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-body-diagnostic-"));
  try {
    await appendAuditLog(
      makeEntry({
        requestId: "req-with-diagnostic",
        bodyDiagnostic: {
          code: "body-too-large",
          byteLength: 8193,
          maxBodyBytes: 8192,
        },
      }),
      dir,
    );
    await appendAuditLog(
      makeEntry({ requestId: "req-without-diagnostic" }),
      dir,
    );

    const entries = await queryAuditLogs({}, dir);
    const withDiagnostic = entries.find(
      (entry) => entry.requestId === "req-with-diagnostic",
    );
    const withoutDiagnostic = entries.find(
      (entry) => entry.requestId === "req-without-diagnostic",
    );
    expect(withDiagnostic?.bodyDiagnostic).toEqual({
      code: "body-too-large",
      byteLength: 8193,
      maxBodyBytes: 8192,
    });
    expect(withoutDiagnostic?.bodyDiagnostic).toBeUndefined();

    _closeAuditDb(dir);
    const db = new Database(path.join(dir, "audit.db"));
    try {
      const columns = db.query("PRAGMA table_info(audit_log)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>;
      expect(
        columns.find((column) => column.name === "body_diagnostic"),
      ).toEqual(expect.objectContaining({ type: "TEXT", notnull: 0 }));
      expect(
        db
          .query("SELECT body_diagnostic FROM audit_log WHERE request_id = ?")
          .get("req-without-diagnostic"),
      ).toEqual({ body_diagnostic: null });
    } finally {
      db.close();
    }
  } finally {
    _closeAuditDb(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("appendAuditLog: stores request body status as metadata without body bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-body-status-"));
  try {
    await appendAuditLog(
      makeEntry({
        requestId: "req-with-body-status",
        requestBodyAuditStatus: {
          state: "attached",
          byteLength: 7,
          sha256: `sha256:${"a".repeat(64)}`,
        },
      }),
      dir,
    );
    await appendAuditLog(
      makeEntry({ requestId: "req-without-body-status" }),
      dir,
    );

    const entries = await queryAuditLogs({}, dir);
    expect(
      entries.find((entry) => entry.requestId === "req-with-body-status")
        ?.requestBodyAuditStatus,
    ).toEqual({
      state: "attached",
      byteLength: 7,
      sha256: `sha256:${"a".repeat(64)}`,
    });
    expect(
      entries.find((entry) => entry.requestId === "req-without-body-status")
        ?.requestBodyAuditStatus,
    ).toBeUndefined();

    _closeAuditDb(dir);
    const db = new Database(path.join(dir, "audit.db"));
    try {
      const stored = db
        .query("SELECT body_audit_status FROM audit_log WHERE request_id = ?")
        .get("req-with-body-status") as { body_audit_status: string };
      expect(JSON.parse(stored.body_audit_status)).toEqual({
        state: "attached",
        byteLength: 7,
        sha256: `sha256:${"a".repeat(64)}`,
      });
      expect(stored.body_audit_status).not.toContain("body bytes");
    } finally {
      db.close();
    }
  } finally {
    _closeAuditDb(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("queryAuditLogs: migrates legacy schema and preserves old rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-legacy-"));
  try {
    const db = new Database(path.join(dir, "audit.db"), { create: true });
    try {
      db.run(`
        CREATE TABLE audit_log (
          id               TEXT PRIMARY KEY,
          timestamp        TEXT NOT NULL,
          domain           TEXT NOT NULL,
          session_id       TEXT NOT NULL,
          request_id       TEXT NOT NULL,
          decision         TEXT NOT NULL,
          reason           TEXT NOT NULL,
          scope            TEXT,
          target           TEXT,
          command          TEXT,
          injected_headers TEXT
        )
      `);
      db.run(
        `INSERT INTO audit_log
           (id, timestamp, domain, session_id, request_id, decision, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          "legacy-id",
          "2026-03-27T12:00:00Z",
          "network",
          "legacy-session",
          "legacy-request",
          "allow",
          "legacy entry",
        ],
      );
    } finally {
      db.close();
    }

    const [entry] = await queryAuditLogs({}, dir);
    expect(entry.phase).toEqual("authorization");
    expect(entry.ruleId).toBeUndefined();
    expect(entry.method).toBeUndefined();
    expect(entry.route).toBeUndefined();
    expect(entry.requestPolicyKind).toBeUndefined();
    expect(entry.requestPolicyResult).toBeUndefined();
    expect(entry.bodyDiagnostic).toBeUndefined();

    await appendAuditLog(
      makeEntry({
        id: "request-policy-id",
        timestamp: "2026-03-28T12:00:00Z",
        phase: "request-policy",
        ruleId: "anthropic.messages.create",
        method: "POST",
        route: "/v1/messages",
        requestPolicyKind: "json",
        requestPolicyResult: "rewrite",
        reason: "masked-json",
      }),
      dir,
    );

    const entries = await queryAuditLogs({}, dir);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: "legacy-id",
      phase: "authorization",
    });
    expect(entries[1]).toMatchObject({
      id: "request-policy-id",
      phase: "request-policy",
      ruleId: "anthropic.messages.create",
      method: "POST",
      route: "/v1/messages",
      requestPolicyKind: "json",
      requestPolicyResult: "rewrite",
      reason: "masked-json",
    });
  } finally {
    _closeAuditDb(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("appendAuditLog: multiple entries coexist", async () => {
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

test("queryAuditLogs: per-day filter with multi-day entries", async () => {
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
    const single = await queryAuditLogs({ sessionIds: ["sess-a"] }, dir);
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
    const results = await queryAuditLogs({ sessionContains: "alpha" }, dir);
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
    const empty = await queryAuditLogs({ before: "2026-03-26T00:00:00Z" }, dir);
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

test("resolveAuditDir: uses XDG_DATA_HOME when set", () => {
  const originalXdg = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = "/tmp/custom-data";
    const result = resolveAuditDir();
    expect(result).toEqual("/tmp/custom-data/nas/audit");
  } finally {
    if (originalXdg !== undefined) {
      process.env.XDG_DATA_HOME = originalXdg;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
  }
});

test("resolveAuditDir: falls back to HOME/.local/share when XDG_DATA_HOME is unset", () => {
  const originalXdg = process.env.XDG_DATA_HOME;
  const originalHome = process.env.HOME;
  try {
    delete process.env.XDG_DATA_HOME;
    process.env.HOME = "/tmp/fakehome";
    const result = resolveAuditDir();
    expect(result).toEqual("/tmp/fakehome/.local/share/nas/audit");
  } finally {
    if (originalXdg !== undefined) {
      process.env.XDG_DATA_HOME = originalXdg;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  }
});

test("resolveAuditDir: throws when neither XDG_DATA_HOME nor HOME is set", () => {
  const originalXdg = process.env.XDG_DATA_HOME;
  const originalHome = process.env.HOME;
  try {
    delete process.env.XDG_DATA_HOME;
    delete process.env.HOME;
    expect(() => resolveAuditDir()).toThrow("Cannot resolve audit directory");
  } finally {
    if (originalXdg !== undefined) {
      process.env.XDG_DATA_HOME = originalXdg;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  }
});

test("appendAuditLog: concurrent writes all land", async () => {
  // Drive a handful of simultaneous inserts to exercise the WAL writer
  // lock. With the previous JSONL store, large concurrent entries could
  // interleave; with SQLite every row has to come through cleanly.
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    const N = 50;
    // Include a big payload so a write would span multiple kernel writes
    // if we were still appending to a plain file — this is the scenario
    // the old store got wrong.
    const bigTarget = "x".repeat(8192);
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendAuditLog(
          makeEntry({
            requestId: `req-${i}`,
            target: bigTarget,
          }),
          dir,
        ),
      ),
    );
    const results = await queryAuditLogs({}, dir);
    expect(results.length).toEqual(N);
    for (const r of results) {
      expect(r.target).toEqual(bigTarget);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("appendAuditLog: duplicate id is idempotent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-"));
  try {
    const entry = makeEntry();
    await appendAuditLog(entry, dir);
    // Same id, different reason — INSERT OR REPLACE keeps a single row.
    await appendAuditLog({ ...entry, reason: "updated" }, dir);

    const results = await queryAuditLogs({}, dir);
    expect(results.length).toEqual(1);
    expect(results[0].reason).toEqual("updated");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
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

function requestBodySha256(body: Uint8Array): string {
  const digest = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  return `sha256:${digest}`;
}

test("request body store: round-trips exact NUL and non-UTF-8 bytes outside audit rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-body-"));
  try {
    const body = Uint8Array.from([0x00, 0xff, 0xc3, 0x28, 0x00, 0x7f]);
    const sha256 = requestBodySha256(body);
    const status = await storeRequestBody(
      {
        sessionId: "sess-body",
        requestId: "req-body",
        capturedAt: "2099-01-01T00:00:00.000Z",
        contentType: "application/octet-stream",
        contentEncoding: "gzip",
        byteLength: body.byteLength,
        sha256,
        body,
      },
      { retentionSeconds: 60, maxTotalBytes: 1024 },
      dir,
    );

    expect(status).toEqual({
      state: "attached",
      byteLength: body.byteLength,
      sha256,
    });
    expect(await getRequestBody("sess-body", "req-body", dir)).toEqual({
      sessionId: "sess-body",
      requestId: "req-body",
      capturedAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:01:00.000Z",
      contentType: "application/octet-stream",
      contentEncoding: "gzip",
      byteLength: body.byteLength,
      sha256,
      body,
    });

    await appendAuditLog(makeEntry({ sessionId: "sess-body" }), dir);
    const [auditEntry] = await queryAuditLogs({}, dir);
    expect(auditEntry).not.toHaveProperty("body");

    _closeAuditDb(dir);
    const db = new Database(path.join(dir, "audit.db"));
    try {
      const columns = db.query("PRAGMA table_info(request_body)").all();
      expect(columns).toHaveLength(9);
      expect(
        columns.map((column) => (column as { name: string }).name),
      ).toEqual([
        "session_id",
        "request_id",
        "captured_at",
        "expires_at",
        "content_type",
        "content_encoding",
        "byte_length",
        "sha256",
        "body",
      ]);
    } finally {
      db.close();
    }
  } finally {
    _closeAuditDb(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("request body store: duplicate key is idempotent only for the same digest and length", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-body-idempotent-"));
  try {
    const original = Uint8Array.from([1, 2, 3]);
    const common = {
      sessionId: "sess-idempotent",
      requestId: "req-idempotent",
      capturedAt: "2099-01-01T00:00:00.000Z",
      contentType: null,
      contentEncoding: null,
    };
    const originalMetadata = {
      byteLength: original.byteLength,
      sha256: requestBodySha256(original),
    };
    const originalStatus = { state: "attached" as const, ...originalMetadata };

    expect(
      await storeRequestBody(
        {
          ...common,
          ...originalMetadata,
          body: original,
        },
        { retentionSeconds: 60, maxTotalBytes: 3 },
        dir,
      ),
    ).toEqual(originalStatus);
    expect(
      await storeRequestBody(
        {
          ...common,
          ...originalMetadata,
          capturedAt: "2099-01-02T00:00:00.000Z",
          body: original,
        },
        { retentionSeconds: 60, maxTotalBytes: 3 },
        dir,
      ),
    ).toEqual(originalStatus);

    const replacement = Uint8Array.from([9, 8, 7]);
    expect(
      await storeRequestBody(
        {
          ...common,
          byteLength: replacement.byteLength,
          sha256: requestBodySha256(replacement),
          body: replacement,
        },
        { retentionSeconds: 60, maxTotalBytes: 1024 },
        dir,
      ),
    ).toEqual({ state: "unavailable", code: "invalid-capture" });

    expect(
      (await getRequestBody("sess-idempotent", "req-idempotent", dir))?.body,
    ).toEqual(original);
  } finally {
    _closeAuditDb(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("request body store: rejects invalid length or digest without inserting", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-body-invalid-"));
  try {
    const body = Uint8Array.from([0, 1, 2, 3]);
    const base = {
      sessionId: "sess-invalid",
      capturedAt: "2099-01-01T00:00:00.000Z",
      contentType: null,
      contentEncoding: null,
      body,
    };

    expect(
      await storeRequestBody(
        {
          ...base,
          requestId: "bad-length",
          byteLength: body.byteLength + 1,
          sha256: requestBodySha256(body),
        },
        { retentionSeconds: 60, maxTotalBytes: 1024 },
        dir,
      ),
    ).toEqual({ state: "unavailable", code: "invalid-capture" });
    expect(
      await storeRequestBody(
        {
          ...base,
          requestId: "bad-digest",
          byteLength: body.byteLength,
          sha256: `sha256:${"0".repeat(64)}`,
        },
        { retentionSeconds: 60, maxTotalBytes: 1024 },
        dir,
      ),
    ).toEqual({ state: "unavailable", code: "invalid-capture" });
    expect(await getRequestBody("sess-invalid", "bad-length", dir)).toBeNull();
    expect(await getRequestBody("sess-invalid", "bad-digest", dir)).toBeNull();
  } finally {
    _closeAuditDb(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("request body store: prunes expired rows before reads and inserts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-body-expiry-"));
  try {
    const expired = Uint8Array.from([1, 2, 3, 4]);
    await storeRequestBody(
      {
        sessionId: "sess-expired-read",
        requestId: "req-expired-read",
        capturedAt: "2000-01-01T00:00:00.000Z",
        contentType: null,
        contentEncoding: null,
        byteLength: expired.byteLength,
        sha256: requestBodySha256(expired),
        body: expired,
      },
      { retentionSeconds: 1, maxTotalBytes: expired.byteLength },
      dir,
    );
    expect(
      await getRequestBody("sess-expired-read", "req-expired-read", dir),
    ).toBeNull();

    await storeRequestBody(
      {
        sessionId: "sess-expired-insert",
        requestId: "req-expired-insert",
        capturedAt: "2000-01-01T00:00:00.000Z",
        contentType: null,
        contentEncoding: null,
        byteLength: expired.byteLength,
        sha256: requestBodySha256(expired),
        body: expired,
      },
      { retentionSeconds: 1, maxTotalBytes: expired.byteLength },
      dir,
    );
    const fresh = Uint8Array.from([5, 6, 7, 8]);
    expect(
      await storeRequestBody(
        {
          sessionId: "sess-fresh",
          requestId: "req-fresh",
          capturedAt: "2099-01-01T00:00:00.000Z",
          contentType: null,
          contentEncoding: null,
          byteLength: fresh.byteLength,
          sha256: requestBodySha256(fresh),
          body: fresh,
        },
        { retentionSeconds: 1, maxTotalBytes: fresh.byteLength },
        dir,
      ),
    ).toEqual({
      state: "attached",
      byteLength: fresh.byteLength,
      sha256: requestBodySha256(fresh),
    });
    expect(
      await getRequestBody("sess-expired-insert", "req-expired-insert", dir),
    ).toBeNull();
  } finally {
    _closeAuditDb(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function storeBody(
  dir: string,
  requestId: string,
  body: Uint8Array,
  capturedAt: string,
  maxTotalBytes: number,
) {
  return await storeRequestBody(
    {
      sessionId: "sess-capacity",
      requestId,
      capturedAt,
      contentType: null,
      contentEncoding: null,
      byteLength: body.byteLength,
      sha256: requestBodySha256(body),
      body,
    },
    { retentionSeconds: 60, maxTotalBytes },
    dir,
  );
}

test("request body store: evicts oldest-captured bodies to admit a new one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-body-capacity-"));
  try {
    const first = Uint8Array.from([0, 1, 2, 3]);
    const second = Uint8Array.from([4, 5, 6]);

    await storeBody(dir, "req-first", first, "2099-01-01T00:00:00.000Z", 6);
    expect(
      await storeBody(dir, "req-second", second, "2099-01-01T00:00:01.000Z", 6),
    ).toEqual({
      state: "attached",
      byteLength: second.byteLength,
      sha256: requestBodySha256(second),
    });

    expect(await getRequestBody("sess-capacity", "req-first", dir)).toBeNull();
    expect(
      (await getRequestBody("sess-capacity", "req-second", dir))?.body,
    ).toEqual(second);
  } finally {
    _closeAuditDb(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("request body store: evicts only as many bodies as the new one needs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-body-partial-"));
  try {
    const oldest = Uint8Array.from([0, 1, 2]);
    const middle = Uint8Array.from([3, 4, 5]);
    const newest = Uint8Array.from([6, 7, 8]);
    const incoming = Uint8Array.from([9, 10, 11]);

    await storeBody(dir, "req-oldest", oldest, "2099-01-01T00:00:00.000Z", 10);
    await storeBody(dir, "req-middle", middle, "2099-01-01T00:00:01.000Z", 10);
    await storeBody(dir, "req-newest", newest, "2099-01-01T00:00:02.000Z", 10);
    await storeBody(
      dir,
      "req-incoming",
      incoming,
      "2099-01-01T00:00:03.000Z",
      10,
    );

    expect(await getRequestBody("sess-capacity", "req-oldest", dir)).toBeNull();
    expect(
      (await getRequestBody("sess-capacity", "req-middle", dir))?.body,
    ).toEqual(middle);
    expect(
      (await getRequestBody("sess-capacity", "req-newest", dir))?.body,
    ).toEqual(newest);
    expect(
      (await getRequestBody("sess-capacity", "req-incoming", dir))?.body,
    ).toEqual(incoming);
  } finally {
    _closeAuditDb(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("request body store: a body larger than the whole budget evicts nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-body-oversize-"));
  try {
    const retained = Uint8Array.from([0, 1, 2, 3]);
    const oversize = Uint8Array.from([0, 1, 2, 3, 4, 5, 6]);

    await storeBody(
      dir,
      "req-retained",
      retained,
      "2099-01-01T00:00:00.000Z",
      6,
    );
    expect(
      await storeBody(
        dir,
        "req-oversize",
        oversize,
        "2099-01-01T00:00:01.000Z",
        6,
      ),
    ).toEqual({ state: "unavailable", code: "capacity" });

    expect(
      (await getRequestBody("sess-capacity", "req-retained", dir))?.body,
    ).toEqual(retained);
    expect(
      await getRequestBody("sess-capacity", "req-oversize", dir),
    ).toBeNull();
  } finally {
    _closeAuditDb(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Seed `count` entries one second apart so ordering is unambiguous and
 * the newest entries are identifiable by index.
 */
async function seedSequence(dir: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const entry = makeEntry({
      timestamp: `2026-03-28T12:00:${String(i).padStart(2, "0")}Z`,
      reason: `entry-${i}`,
    });
    ids.push(entry.id);
    await appendAuditLog(entry, dir);
  }
  return ids;
}

test("queryAuditLogs: limit keeps the newest entries in ascending order", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-limit-"));
  try {
    const ids = await seedSequence(dir, 10);

    const limited = await queryAuditLogs({ limit: 3 }, dir);

    // The bounded query must return exactly what slicing the tail off an
    // unbounded ascending result would: same entries, same order. That
    // equivalence is what makes pushing LIMIT into SQL a pure speedup
    // rather than a behaviour change.
    expect(limited.map((e) => e.id)).toEqual(ids.slice(-3));
    expect(limited.map((e) => e.reason)).toEqual([
      "entry-7",
      "entry-8",
      "entry-9",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("queryAuditLogs: a limited result matches the tail of the unlimited one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-limit-parity-"));
  try {
    await seedSequence(dir, 25);

    const all = await queryAuditLogs({}, dir);
    const limited = await queryAuditLogs({ limit: 8 }, dir);

    expect(limited).toEqual(all.slice(-8));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("queryAuditLogs: limit larger than the table returns everything", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-limit-big-"));
  try {
    const ids = await seedSequence(dir, 4);
    const limited = await queryAuditLogs({ limit: 100 }, dir);
    expect(limited.map((e) => e.id)).toEqual(ids);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("queryAuditLogs: composes limit with the other filters", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-limit-filter-"));
  try {
    for (let i = 0; i < 6; i++) {
      await appendAuditLog(
        makeEntry({
          timestamp: `2026-03-28T12:00:0${i}Z`,
          domain: i % 2 === 0 ? "network" : "hostexec",
          reason: `entry-${i}`,
        }),
        dir,
      );
    }

    // The limit must apply after the WHERE clause, not before it:
    // limiting first would return the newest rows and then filter them
    // down to fewer than asked for.
    const limited = await queryAuditLogs({ domain: "network", limit: 2 }, dir);
    expect(limited.map((e) => e.reason)).toEqual(["entry-2", "entry-4"]);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("queryAuditLogs: non-positive and non-integer limits are ignored", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-audit-limit-bad-"));
  try {
    const ids = await seedSequence(dir, 5);

    // Silently clamping a bad limit to 1 would hide a caller's bug behind
    // output that still looks plausible, so these fall back to "no limit".
    for (const limit of [0, -1, 2.5, Number.NaN]) {
      const rows = await queryAuditLogs({ limit }, dir);
      expect(rows.map((e) => e.id)).toEqual(ids);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
