/**
 * OTLP/HTTP receiver integration tests.
 *
 * Spins up the actual Bun.serve listener on an ephemeral 127.0.0.1 port and
 * exercises the protocol surface (status codes, content-type matching,
 * end-to-end ingest into a tmp SQLite db) plus the lifecycle contract
 * (port:0 expose, close idempotency, fail-closed after close).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { OtlpJsonExportPayload } from "./ingest.ts";
import { type OtlpReceiverHandle, startOtlpReceiver } from "./receiver.ts";
import { _closeHistoryDb, openHistoryDb, upsertInvocation } from "./store.ts";

interface TmpHistoryDb {
  dir: string;
  dbPath: string;
}

let tmp: TmpHistoryDb;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-receiver-"));
  tmp = { dir, dbPath: path.join(dir, "history.db") };
});

afterEach(async () => {
  if (tmp) {
    _closeHistoryDb(tmp.dbPath);
    await rm(tmp.dir, { recursive: true, force: true });
  }
});

const FIXTURES = path.join(import.meta.dir, "fixtures");

async function loadFixture(name: string): Promise<OtlpJsonExportPayload> {
  const buf = await readFile(path.join(FIXTURES, name), "utf8");
  return JSON.parse(buf) as OtlpJsonExportPayload;
}

function tracesUrl(handle: OtlpReceiverHandle): string {
  return `http://127.0.0.1:${handle.port}/v1/traces`;
}

test("startOtlpReceiver: port:0 yields an OS-chosen non-zero port", async () => {
  const db = openHistoryDb({ path: tmp.dbPath, mode: "readwrite" });
  const handle = await startOtlpReceiver({ db });
  try {
    expect(handle.port).toBeGreaterThan(0);
  } finally {
    await handle.close();
  }
});

test("POST /v1/traces with valid OTLP/JSON: 200 + partialSuccess body, spans persisted", async () => {
  const db = openHistoryDb({ path: tmp.dbPath, mode: "readwrite" });
  upsertInvocation(db, {
    id: "sess_aaa",
    profile: "default",
    agent: "copilot",
    worktreePath: null,
    startedAt: "2026-05-01T00:00:00Z",
    endedAt: null,
    exitReason: null,
  });

  const payload = await loadFixture("copilot_chat_minimal.json");
  const handle = await startOtlpReceiver({ db });
  try {
    const res = await fetch(tracesUrl(handle), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toEqual(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ partialSuccess: {} });

    const spanCount = db.query("SELECT COUNT(*) AS c FROM spans").get() as {
      c: number;
    };
    expect(spanCount.c).toEqual(3);
  } finally {
    await handle.close();
  }
});

test("POST /v1/traces with charset suffix on content-type: 200", async () => {
  const db = openHistoryDb({ path: tmp.dbPath, mode: "readwrite" });
  upsertInvocation(db, {
    id: "sess_aaa",
    profile: null,
    agent: "copilot",
    worktreePath: null,
    startedAt: "2026-05-01T00:00:00Z",
    endedAt: null,
    exitReason: null,
  });
  const payload = await loadFixture("copilot_chat_minimal.json");
  const handle = await startOtlpReceiver({ db });
  try {
    const res = await fetch(tracesUrl(handle), {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toEqual(200);
  } finally {
    await handle.close();
  }
});

test("POST /v1/traces with application/x-protobuf: 415", async () => {
  const db = openHistoryDb({ path: tmp.dbPath, mode: "readwrite" });
  const handle = await startOtlpReceiver({ db });
  try {
    const res = await fetch(tracesUrl(handle), {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: new Uint8Array([0x00, 0x01, 0x02]),
    });
    expect(res.status).toEqual(415);
  } finally {
    await handle.close();
  }
});

test("POST /v1/traces with no content-type: 415", async () => {
  const db = openHistoryDb({ path: tmp.dbPath, mode: "readwrite" });
  const handle = await startOtlpReceiver({ db });
  try {
    // fetch() will default to a content-type for string/blob bodies; use a
    // body where Bun does not auto-attach one (a Request built explicitly).
    const res = await fetch(tracesUrl(handle), {
      method: "POST",
      body: new Uint8Array([]),
    });
    expect(res.status).toEqual(415);
  } finally {
    await handle.close();
  }
});

test("POST /v1/traces with malformed JSON: 400, server still live", async () => {
  const db = openHistoryDb({ path: tmp.dbPath, mode: "readwrite" });
  upsertInvocation(db, {
    id: "sess_aaa",
    profile: null,
    agent: "copilot",
    worktreePath: null,
    startedAt: "2026-05-01T00:00:00Z",
    endedAt: null,
    exitReason: null,
  });
  const handle = await startOtlpReceiver({ db });
  try {
    const bad = await fetch(tracesUrl(handle), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(bad.status).toEqual(400);

    // Server must still process subsequent valid requests.
    const payload = await loadFixture("copilot_chat_minimal.json");
    const ok = await fetch(tracesUrl(handle), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(ok.status).toEqual(200);
  } finally {
    await handle.close();
  }
});

test("GET /v1/traces: 405 with Allow: POST", async () => {
  const db = openHistoryDb({ path: tmp.dbPath, mode: "readwrite" });
  const handle = await startOtlpReceiver({ db });
  try {
    const res = await fetch(tracesUrl(handle), { method: "GET" });
    expect(res.status).toEqual(405);
    expect(res.headers.get("allow")).toEqual("POST");
  } finally {
    await handle.close();
  }
});

test("POST /something_else: 404", async () => {
  const db = openHistoryDb({ path: tmp.dbPath, mode: "readwrite" });
  const handle = await startOtlpReceiver({ db });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/something_else`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toEqual(404);
  } finally {
    await handle.close();
  }
});

test("ingester throws (closed db handle): 500, server stays live", async () => {
  const db = openHistoryDb({ path: tmp.dbPath, mode: "readwrite" });
  upsertInvocation(db, {
    id: "sess_aaa",
    profile: null,
    agent: "copilot",
    worktreePath: null,
    startedAt: "2026-05-01T00:00:00Z",
    endedAt: null,
    exitReason: null,
  });
  const handle = await startOtlpReceiver({ db });
  try {
    // Force the ingester to throw on its next prepare() by closing the
    // underlying DB handle; the receiver must convert that into a 500
    // rather than crashing the listener.
    db.close();
    _closeHistoryDb(tmp.dbPath);

    const payload = await loadFixture("copilot_chat_minimal.json");
    const res = await fetch(tracesUrl(handle), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toEqual(500);

    // Listener still answers a subsequent (also-failing) request without
    // collapsing.
    const res2 = await fetch(tracesUrl(handle), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res2.status).toEqual(500);
  } finally {
    await handle.close();
  }
});

test("ingester throws mid-batch: 500 and DB row counts unchanged (transaction rollback)", async () => {
  // A payload with two resourceSpans: the first is valid (its
  // `nas.session.id` references an existing invocation), the second
  // references a non-existent invocation and therefore violates the
  // traces.invocation_id FK when ingestResourceSpans calls upsertTrace.
  // ingestResourceSpans wraps all writes in a single db.transaction, so
  // the FK violation must roll back the writes from the first
  // resourceSpan as well — DB row counts must equal the pre-POST state.
  const db = openHistoryDb({ path: tmp.dbPath, mode: "readwrite" });
  upsertInvocation(db, {
    id: "sess_aaa",
    profile: null,
    agent: "copilot",
    worktreePath: null,
    startedAt: "2026-05-01T00:00:00Z",
    endedAt: null,
    exitReason: null,
  });

  const validPayload = await loadFixture("copilot_chat_minimal.json");
  const validResource = validPayload.resourceSpans?.[0];
  if (validResource === undefined) {
    throw new Error("fixture missing resourceSpans[0]");
  }
  const invalidResource: typeof validResource = {
    resource: {
      attributes: [
        {
          key: "nas.session.id",
          value: { stringValue: "sess_does_not_exist" },
        },
      ],
    },
    scopeSpans: [
      {
        scope: { name: "test", version: "0" },
        spans: [
          {
            traceId: "trace_orphan",
            spanId: "span_orphan",
            name: "orphan",
            startTimeUnixNano: "1714550400000000000",
            endTimeUnixNano: "1714550401000000000",
          },
        ],
      },
    ],
  };
  const mixedPayload: OtlpJsonExportPayload = {
    resourceSpans: [validResource, invalidResource],
  };

  const countRow = (table: string): number =>
    (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

  const beforeSpans = countRow("spans");
  const beforeTraces = countRow("traces");
  const beforeConversations = countRow("conversations");

  const handle = await startOtlpReceiver({ db });
  try {
    const res = await fetch(tracesUrl(handle), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mixedPayload),
    });
    expect(res.status).toEqual(500);

    expect(countRow("spans")).toEqual(beforeSpans);
    expect(countRow("traces")).toEqual(beforeTraces);
    expect(countRow("conversations")).toEqual(beforeConversations);
  } finally {
    await handle.close();
  }
});

test("close(): subsequent requests fail to connect", async () => {
  const db = openHistoryDb({ path: tmp.dbPath, mode: "readwrite" });
  const handle = await startOtlpReceiver({ db });
  const url = tracesUrl(handle);
  await handle.close();

  let threw = false;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test("close(): idempotent — second call resolves without throwing", async () => {
  const db = openHistoryDb({ path: tmp.dbPath, mode: "readwrite" });
  const handle = await startOtlpReceiver({ db });
  await handle.close();
  await handle.close();
  await handle.close();
});
