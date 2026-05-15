import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  ingestLogRecords,
  type OtlpJsonExportLogsPayload,
} from "./ingest_logs.ts";
import type { OtlpKeyValue } from "./otlp_wire.ts";
import { _closeHistoryDb, openHistoryDb, upsertInvocation } from "./store.ts";

interface TmpHistoryDb {
  dir: string;
  dbPath: string;
}

async function makeTempDb(): Promise<TmpHistoryDb> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-history-ingest-logs-"));
  return { dir, dbPath: path.join(dir, "history.db") };
}

async function cleanup(t: TmpHistoryDb): Promise<void> {
  _closeHistoryDb(t.dbPath);
  await rm(t.dir, { recursive: true, force: true }).catch(() => {});
}

/** Helper to build a minimal valid log record attribute list. */
function makeAttrs(overrides: Record<string, string | number> = {}) {
  const base: Record<string, string | number> = {
    "event.name": "user_prompt",
    "session.id": "conv_logs_1",
    "prompt.id": "prompt_1",
    "event.sequence": 1,
    ...overrides,
  };
  return Object.entries(base).map(([key, value]) => ({
    key,
    value:
      typeof value === "number" ? { intValue: value } : { stringValue: value },
  }));
}

interface LogRecord {
  timeUnixNano?: string;
  attributes?: OtlpKeyValue[];
}

function makePayload(
  records: LogRecord[],
  invocationId = "sess_logs_1",
): OtlpJsonExportLogsPayload {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "nas.session.id", value: { stringValue: invocationId } },
          ],
        },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Setup helper: open a fresh in-test DB with a seed invocation row.
// ---------------------------------------------------------------------------

function setupDb(t: TmpHistoryDb, invocationId = "sess_logs_1") {
  const db = openHistoryDb({ path: t.dbPath, mode: "readwrite" });
  upsertInvocation(db, {
    id: invocationId,
    profile: "default",
    agent: "claude",
    worktreePath: null,
    startedAt: "2026-05-01T00:00:00Z",
    endedAt: null,
    exitReason: null,
  });
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("user_prompt event is inserted correctly", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload = makePayload([
      {
        timeUnixNano: "1746057600000000000", // 2025-05-01T00:00:00Z
        attributes: makeAttrs({
          "event.name": "user_prompt",
          "session.id": "conv_logs_1",
          "prompt.id": "prompt_abc",
          "event.sequence": 1,
        }),
      },
    ]);

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(1);
    expect(result.droppedRecords).toEqual(0);
    expect(result.unknownEvents).toEqual(0);

    const row = db
      .query(
        "SELECT invocation_id, conversation_id, prompt_id, sequence, event_name, time FROM log_records WHERE conversation_id = ?",
      )
      .get("conv_logs_1") as {
      invocation_id: string;
      conversation_id: string;
      prompt_id: string;
      sequence: number;
      event_name: string;
      time: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row!.invocation_id).toEqual("sess_logs_1");
    expect(row!.conversation_id).toEqual("conv_logs_1");
    expect(row!.prompt_id).toEqual("prompt_abc");
    expect(row!.sequence).toEqual(1);
    expect(row!.event_name).toEqual("user_prompt");
    expect(row!.time).toEqual("2025-05-01T00:00:00.000Z");
  } finally {
    await cleanup(t);
  }
});

test("api_request event persists request_id column", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload = makePayload([
      {
        timeUnixNano: "1746057600000000000",
        attributes: makeAttrs({
          "event.name": "api_request",
          "session.id": "conv_logs_2",
          "prompt.id": "prompt_api",
          "event.sequence": 10,
          request_id: "req_abc123",
        }),
      },
    ]);

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(1);

    const row = db
      .query(
        "SELECT event_name, request_id FROM log_records WHERE conversation_id = ?",
      )
      .get("conv_logs_2") as {
      event_name: string;
      request_id: string | null;
    } | null;

    expect(row).not.toBeNull();
    expect(row!.event_name).toEqual("api_request");
    expect(row!.request_id).toEqual("req_abc123");
  } finally {
    await cleanup(t);
  }
});

test("hook_execution_start and hook_execution_complete are ingested", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload = makePayload([
      {
        timeUnixNano: "1746057601000000000",
        attributes: makeAttrs({
          "event.name": "hook_execution_start",
          "session.id": "conv_hooks",
          "prompt.id": "prompt_hook",
          "event.sequence": 5,
        }),
      },
      {
        timeUnixNano: "1746057602000000000",
        attributes: makeAttrs({
          "event.name": "hook_execution_complete",
          "session.id": "conv_hooks",
          "prompt.id": "prompt_hook",
          "event.sequence": 6,
        }),
      },
    ]);

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(2);
    expect(result.droppedRecords).toEqual(0);

    const rows = db
      .query(
        "SELECT event_name, sequence FROM log_records WHERE conversation_id = ? ORDER BY sequence",
      )
      .all("conv_hooks") as { event_name: string; sequence: number }[];

    expect(rows.length).toEqual(2);
    expect(rows[0].event_name).toEqual("hook_execution_start");
    expect(rows[0].sequence).toEqual(5);
    expect(rows[1].event_name).toEqual("hook_execution_complete");
    expect(rows[1].sequence).toEqual(6);
  } finally {
    await cleanup(t);
  }
});

test("known-excluded events (tool_result, internal_error, ...) are dropped without bumping unknownEvents", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    // One record per known-excluded event from ADR 2026051301, plus one
    // user_prompt to confirm the rest of the batch keeps flowing.
    const knownExcluded = [
      "internal_error",
      "tool_result",
      "tool_decision",
      "skill_activated",
      "api_request_body",
      "api_response_body",
    ];
    const payload = makePayload([
      ...knownExcluded.map((name, i) => ({
        timeUnixNano: `${1_746_057_600_000_000_000n + BigInt(i)}`,
        attributes: makeAttrs({
          "event.name": name,
          "session.id": "conv_known_excluded",
          "prompt.id": "prompt_ke",
          "event.sequence": i + 1,
        }),
      })),
      {
        timeUnixNano: "1746057700000000000",
        attributes: makeAttrs({
          "event.name": "user_prompt",
          "session.id": "conv_known_excluded",
          "prompt.id": "prompt_ke",
          "event.sequence": 100,
        }),
      },
    ]);

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(1);
    expect(result.droppedRecords).toEqual(knownExcluded.length);
    // Known-excluded events must NOT count toward unknownEvents — that
    // counter is reserved for events outside both ALLOWED and EXCLUDED sets.
    expect(result.unknownEvents).toEqual(0);

    const count = db
      .query("SELECT COUNT(*) AS c FROM log_records WHERE conversation_id = ?")
      .get("conv_known_excluded") as { c: number };
    expect(count.c).toEqual(1);
  } finally {
    await cleanup(t);
  }
});

test("truly-unknown events (outside ALLOWED and KNOWN_EXCLUDED) increment unknownEvents", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload = makePayload([
      {
        timeUnixNano: "1746057600000000000",
        attributes: makeAttrs({
          "event.name": "some_event_added_in_a_future_release",
          "session.id": "conv_unknown",
          "prompt.id": "prompt_u",
          "event.sequence": 1,
        }),
      },
    ]);

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(0);
    expect(result.droppedRecords).toEqual(1);
    expect(result.unknownEvents).toEqual(1);
  } finally {
    await cleanup(t);
  }
});

test("record missing session.id is dropped", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload: OtlpJsonExportLogsPayload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "nas.session.id", value: { stringValue: "sess_logs_1" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1746057600000000000",
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "user_prompt" },
                    },
                    { key: "prompt.id", value: { stringValue: "prompt_p" } },
                    { key: "event.sequence", value: { intValue: 1 } },
                    // session.id intentionally omitted
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(0);
    expect(result.droppedRecords).toEqual(1);

    const count = db.query("SELECT COUNT(*) AS c FROM log_records").get() as {
      c: number;
    };
    expect(count.c).toEqual(0);
  } finally {
    await cleanup(t);
  }
});

test("record missing prompt.id is dropped", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload: OtlpJsonExportLogsPayload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "nas.session.id", value: { stringValue: "sess_logs_1" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1746057600000000000",
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "user_prompt" },
                    },
                    {
                      key: "session.id",
                      value: { stringValue: "conv_noprompt" },
                    },
                    { key: "event.sequence", value: { intValue: 1 } },
                    // prompt.id intentionally omitted
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(0);
    expect(result.droppedRecords).toEqual(1);
  } finally {
    await cleanup(t);
  }
});

test("record missing event.sequence is dropped", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload: OtlpJsonExportLogsPayload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "nas.session.id", value: { stringValue: "sess_logs_1" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1746057600000000000",
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "user_prompt" },
                    },
                    { key: "session.id", value: { stringValue: "conv_noseq" } },
                    {
                      key: "prompt.id",
                      value: { stringValue: "prompt_noseq" },
                    },
                    // event.sequence intentionally omitted
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(0);
    expect(result.droppedRecords).toEqual(1);
  } finally {
    await cleanup(t);
  }
});

test("event.sequence as string (OTLP int64) is parsed correctly", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload: OtlpJsonExportLogsPayload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "nas.session.id", value: { stringValue: "sess_logs_1" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1746057600000000000",
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "user_prompt" },
                    },
                    {
                      key: "session.id",
                      value: { stringValue: "conv_seq_str" },
                    },
                    { key: "prompt.id", value: { stringValue: "prompt_seq" } },
                    // event.sequence as string (OTLP int64 encoding)
                    { key: "event.sequence", value: { stringValue: "42" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(1);

    const row = db
      .query("SELECT sequence FROM log_records WHERE conversation_id = ?")
      .get("conv_seq_str") as { sequence: number } | null;
    expect(row).not.toBeNull();
    expect(row!.sequence).toEqual(42);
  } finally {
    await cleanup(t);
  }
});

test("PII attributes (user.email, user.id, user.account_uuid, user.account_id) are stripped from attrs_json", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload: OtlpJsonExportLogsPayload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "nas.session.id", value: { stringValue: "sess_logs_1" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1746057600000000000",
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "user_prompt" },
                    },
                    { key: "session.id", value: { stringValue: "conv_pii" } },
                    { key: "prompt.id", value: { stringValue: "prompt_pii" } },
                    { key: "event.sequence", value: { intValue: 1 } },
                    {
                      key: "user.email",
                      value: { stringValue: "alice@example.com" },
                    },
                    { key: "user.id", value: { stringValue: "hashed-id" } },
                    {
                      key: "user.account_uuid",
                      value: { stringValue: "uuid-123" },
                    },
                    {
                      key: "user.account_id",
                      value: { stringValue: "acct-456" },
                    },
                    { key: "safe.attr", value: { stringValue: "keep-me" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(1);

    const row = db
      .query("SELECT attrs_json FROM log_records WHERE conversation_id = ?")
      .get("conv_pii") as { attrs_json: string } | null;
    expect(row).not.toBeNull();
    const attrs = JSON.parse(row!.attrs_json) as Record<string, unknown>;
    expect(attrs["safe.attr"]).toEqual("keep-me");
    expect(attrs["user.email"]).toBeUndefined();
    expect(attrs["user.id"]).toBeUndefined();
    expect(attrs["user.account_uuid"]).toBeUndefined();
    expect(attrs["user.account_id"]).toBeUndefined();
  } finally {
    await cleanup(t);
  }
});

test("duplicate ingest (same conversation_id + sequence) is deduped by INSERT OR IGNORE", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload = makePayload([
      {
        timeUnixNano: "1746057600000000000",
        attributes: makeAttrs({
          "event.name": "user_prompt",
          "session.id": "conv_dedup",
          "prompt.id": "prompt_dup",
          "event.sequence": 1,
        }),
      },
    ]);

    // Ingest the same payload twice
    const r1 = ingestLogRecords(db, payload, "sess_logs_1");
    const r2 = ingestLogRecords(db, payload, "sess_logs_1");

    expect(r1.acceptedRecords).toEqual(1);
    // Second ingest: the row is collected and attempted but INSERT OR IGNORE
    // silently skips it; acceptedRecords reflects rows passed to insertLogRecords
    // (the store layer handles dedup transparently).
    expect(r2.acceptedRecords).toEqual(1);

    // Only one row should exist in the DB.
    const count = db
      .query(
        "SELECT COUNT(*) AS c FROM log_records WHERE conversation_id = ? AND sequence = ?",
      )
      .get("conv_dedup", 1) as { c: number };
    expect(count.c).toEqual(1);
  } finally {
    await cleanup(t);
  }
});

test("same conversation_id multiple records: last_seen_at reflects latest record time", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    // Three records for the same conversation with different times.
    const payload = makePayload([
      {
        timeUnixNano: "1746057601000000000", // 2025-05-01T00:00:01Z
        attributes: makeAttrs({
          "event.name": "user_prompt",
          "session.id": "conv_multi_time",
          "prompt.id": "prompt_1",
          "event.sequence": 1,
        }),
      },
      {
        timeUnixNano: "1746057603000000000", // 2025-05-01T00:00:03Z (latest)
        attributes: makeAttrs({
          "event.name": "api_request",
          "session.id": "conv_multi_time",
          "prompt.id": "prompt_1",
          "event.sequence": 3,
        }),
      },
      {
        timeUnixNano: "1746057602000000000", // 2025-05-01T00:00:02Z
        attributes: makeAttrs({
          "event.name": "hook_execution_start",
          "session.id": "conv_multi_time",
          "prompt.id": "prompt_1",
          "event.sequence": 2,
        }),
      },
    ]);

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(3);

    const conv = db
      .query(
        "SELECT first_seen_at, last_seen_at FROM conversations WHERE id = ?",
      )
      .get("conv_multi_time") as {
      first_seen_at: string;
      last_seen_at: string;
    } | null;

    expect(conv).not.toBeNull();
    expect(conv!.first_seen_at).toEqual("2025-05-01T00:00:01.000Z");
    expect(conv!.last_seen_at).toEqual("2025-05-01T00:00:03.000Z");
  } finally {
    await cleanup(t);
  }
});

test("record with empty string event.name is dropped", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload: OtlpJsonExportLogsPayload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "nas.session.id", value: { stringValue: "sess_logs_1" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1746057600000000000",
                  attributes: [
                    // event.name is present but empty string
                    { key: "event.name", value: { stringValue: "" } },
                    {
                      key: "session.id",
                      value: { stringValue: "conv_empty_event" },
                    },
                    {
                      key: "prompt.id",
                      value: { stringValue: "prompt_empty" },
                    },
                    { key: "event.sequence", value: { intValue: 1 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(0);
    expect(result.droppedRecords).toEqual(1);
    expect(result.unknownEvents).toEqual(0);

    const count = db.query("SELECT COUNT(*) AS c FROM log_records").get() as {
      c: number;
    };
    expect(count.c).toEqual(0);
  } finally {
    await cleanup(t);
  }
});

test("payload with no resourceLogs returns zero counters and does not throw", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const result = ingestLogRecords(db, {}, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(0);
    expect(result.droppedRecords).toEqual(0);
    expect(result.unknownEvents).toEqual(0);
  } finally {
    await cleanup(t);
  }
});

test("invocationId is the authoritative FK regardless of payload-supplied nas.session.id", async () => {
  // The caller-supplied invocationId always wins. Three scenarios cover the
  // surface area: missing resource attrs, present-but-different nas.session.id,
  // and present-and-matching. The ingester treats all three identically — the
  // resource-level value is not read.
  const cases: Array<{
    label: string;
    resourceAttrs: OtlpKeyValue[];
    conversationId: string;
  }> = [
    { label: "missing", resourceAttrs: [], conversationId: "conv_missing" },
    {
      label: "mismatch",
      resourceAttrs: [
        { key: "nas.session.id", value: { stringValue: "wrong_id" } },
      ],
      conversationId: "conv_mismatch",
    },
    {
      label: "matching",
      resourceAttrs: [
        { key: "nas.session.id", value: { stringValue: "sess_logs_1" } },
      ],
      conversationId: "conv_match",
    },
  ];

  for (const c of cases) {
    const t = await makeTempDb();
    try {
      const db = setupDb(t);
      const payload: OtlpJsonExportLogsPayload = {
        resourceLogs: [
          {
            resource: { attributes: c.resourceAttrs },
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "1746057600000000000",
                    attributes: makeAttrs({
                      "event.name": "user_prompt",
                      "session.id": c.conversationId,
                      "prompt.id": `prompt_${c.label}`,
                      "event.sequence": 1,
                    }),
                  },
                ],
              },
            ],
          },
        ],
      };

      const result = ingestLogRecords(db, payload, "sess_logs_1");
      expect(result.acceptedRecords).toEqual(1);
      expect(result.droppedRecords).toEqual(0);

      const row = db
        .query(
          "SELECT invocation_id FROM log_records WHERE conversation_id = ?",
        )
        .get(c.conversationId) as { invocation_id: string } | null;
      expect(row).not.toBeNull();
      expect(row!.invocation_id).toEqual("sess_logs_1");
    } finally {
      await cleanup(t);
    }
  }
});

test("event.sequence = 0 is accepted (not treated as falsy/missing)", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload = makePayload([
      {
        timeUnixNano: "1746057600000000000",
        attributes: makeAttrs({
          "event.name": "user_prompt",
          "session.id": "conv_seq_zero",
          "prompt.id": "prompt_zero",
          "event.sequence": 0,
        }),
      },
    ]);

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(1);
    expect(result.droppedRecords).toEqual(0);

    const row = db
      .query("SELECT sequence FROM log_records WHERE conversation_id = ?")
      .get("conv_seq_zero") as { sequence: number } | null;
    expect(row).not.toBeNull();
    expect(row!.sequence).toEqual(0);
  } finally {
    await cleanup(t);
  }
});

test("payload with resourceLogs: [] returns zero counters", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };
    try {
      const result = ingestLogRecords(db, { resourceLogs: [] }, "sess_logs_1");
      expect(result.acceptedRecords).toEqual(0);
      expect(result.droppedRecords).toEqual(0);
      expect(result.unknownEvents).toEqual(0);
      expect(warnMessages.length).toEqual(0);
    } finally {
      console.warn = origWarn;
    }
  } finally {
    await cleanup(t);
  }
});

test("record with absent timeUnixNano is persisted with the epoch fallback", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload: OtlpJsonExportLogsPayload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: "nas.session.id",
                value: { stringValue: "sess_logs_1" },
              },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  // timeUnixNano intentionally absent
                  attributes: makeAttrs({
                    "event.name": "user_prompt",
                    "session.id": "conv_no_time",
                    "prompt.id": "prompt_notime",
                    "event.sequence": 1,
                  }),
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(1);
    expect(result.droppedRecords).toEqual(0);

    const row = db
      .query("SELECT time FROM log_records WHERE conversation_id = ?")
      .get("conv_no_time") as { time: string } | null;
    expect(row).not.toBeNull();
    expect(row!.time).toEqual("1970-01-01T00:00:00.000Z");
  } finally {
    await cleanup(t);
  }
});

test("multiple resourceLogs blocks with same session.id: last_seen_at reflects globally latest record", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    // Two resourceLogs blocks, each containing one record for the same
    // conversation but with different timestamps.
    const payload: OtlpJsonExportLogsPayload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "nas.session.id", value: { stringValue: "sess_logs_1" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1746057601000000000", // 2025-05-01T00:00:01Z (earlier)
                  attributes: makeAttrs({
                    "event.name": "user_prompt",
                    "session.id": "conv_multi_rl",
                    "prompt.id": "prompt_1",
                    "event.sequence": 1,
                  }),
                },
              ],
            },
          ],
        },
        {
          resource: {
            attributes: [
              { key: "nas.session.id", value: { stringValue: "sess_logs_1" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1746057605000000000", // 2025-05-01T00:00:05Z (later)
                  attributes: makeAttrs({
                    "event.name": "api_request",
                    "session.id": "conv_multi_rl",
                    "prompt.id": "prompt_1",
                    "event.sequence": 2,
                  }),
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(2);

    const conv = db
      .query(
        "SELECT first_seen_at, last_seen_at FROM conversations WHERE id = ?",
      )
      .get("conv_multi_rl") as {
      first_seen_at: string;
      last_seen_at: string;
    } | null;

    expect(conv).not.toBeNull();
    expect(conv!.first_seen_at).toEqual("2025-05-01T00:00:01.000Z");
    expect(conv!.last_seen_at).toEqual("2025-05-01T00:00:05.000Z");
  } finally {
    await cleanup(t);
  }
});

test("event.sequence as non-integer float (e.g. '1.5') is dropped", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload: OtlpJsonExportLogsPayload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "nas.session.id", value: { stringValue: "sess_logs_1" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1746057600000000000",
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "user_prompt" },
                    },
                    {
                      key: "session.id",
                      value: { stringValue: "conv_floatseq" },
                    },
                    {
                      key: "prompt.id",
                      value: { stringValue: "prompt_floatseq" },
                    },
                    // Non-integer float: Number.isInteger(1.5) → false, should be dropped
                    { key: "event.sequence", value: { stringValue: "1.5" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(0);
    expect(result.droppedRecords).toEqual(1);

    const count = db.query("SELECT COUNT(*) AS c FROM log_records").get() as {
      c: number;
    };
    expect(count.c).toEqual(0);
  } finally {
    await cleanup(t);
  }
});

test("event.sequence with trailing non-numeric characters (e.g. '42abc') is dropped", async () => {
  const t = await makeTempDb();
  try {
    const db = setupDb(t);
    const payload: OtlpJsonExportLogsPayload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "nas.session.id", value: { stringValue: "sess_logs_1" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1746057600000000000",
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "user_prompt" },
                    },
                    {
                      key: "session.id",
                      value: { stringValue: "conv_badseq" },
                    },
                    {
                      key: "prompt.id",
                      value: { stringValue: "prompt_badseq" },
                    },
                    // Non-numeric suffix: Number("42abc") → NaN, should be dropped
                    { key: "event.sequence", value: { stringValue: "42abc" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = ingestLogRecords(db, payload, "sess_logs_1");
    expect(result.acceptedRecords).toEqual(0);
    expect(result.droppedRecords).toEqual(1);

    const count = db.query("SELECT COUNT(*) AS c FROM log_records").get() as {
      c: number;
    };
    expect(count.c).toEqual(0);
  } finally {
    await cleanup(t);
  }
});
