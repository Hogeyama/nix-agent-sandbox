/**
 * Ingester for OTLP/JSON `ExportLogsServiceRequest` payloads.
 *
 * Walks `resourceLogs`, warns when `nas.session.id` is absent or empty on the
 * resource (processing continues using `invocationId`), and for each log
 * record: validates the event whitelist, extracts required attributes
 * (`session.id`, `prompt.id`, `event.sequence`), strips PII, upserts the
 * conversation FK, and writes the record via `insertLogRecords`.
 *
 * Only events in `ALLOWED_EVENTS` are persisted; all others are dropped with a
 * `console.warn` and counted in `unknownEvents`.
 */

import type { Database } from "bun:sqlite";
import type { OtlpKeyValue } from "./ingest.ts";
import {
  flattenAttributes,
  nanoToIso,
  readStringAttr,
  stripPiiAttrs,
} from "./ingest.ts";
import { insertLogRecords, upsertConversation } from "./store.ts";
import type { LogRecordRow } from "./types.ts";

// ---------------------------------------------------------------------------
// OTLP/JSON wire types for the Logs signal
// ---------------------------------------------------------------------------

interface OtlpJsonLogRecord {
  timeUnixNano?: string;
  attributes?: OtlpKeyValue[];
}

interface OtlpJsonScopeLogs {
  logRecords?: OtlpJsonLogRecord[];
}

interface OtlpJsonResourceLogs {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeLogs?: OtlpJsonScopeLogs[];
}

export interface OtlpJsonExportLogsPayload {
  resourceLogs?: OtlpJsonResourceLogs[];
}

// ---------------------------------------------------------------------------
// Result counters
// ---------------------------------------------------------------------------

export interface IngestLogsResult {
  /**
   * Number of records passed to `insertLogRecords` (i.e. attempted inserts).
   * Because the store uses `INSERT OR IGNORE`, rows skipped due to duplicate
   * `(conversation_id, sequence)` are still counted here — this is the attempt
   * count, not the actual insert count.
   */
  acceptedRecords: number;
  droppedRecords: number;
  unknownEvents: number;
}

// ---------------------------------------------------------------------------
// Event whitelist
// ---------------------------------------------------------------------------

/**
 * Only log records whose `event.name` attribute matches one of these values
 * are persisted. All others are warn-dropped and counted in `unknownEvents`.
 */
const ALLOWED_EVENTS = new Set([
  "user_prompt",
  "api_request",
  "hook_execution_start",
  "hook_execution_complete",
]);

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Ingest an `ExportLogsServiceRequest` payload into the history database.
 *
 * Each log record requires:
 * - `event.name` attribute in `ALLOWED_EVENTS`
 * - `session.id` attribute (conversation FK)
 * - `prompt.id` attribute
 * - `event.sequence` attribute (conversation-scoped monotonic integer)
 *
 * Missing required attributes cause the record to be warn-dropped. The
 * `invocationId` parameter is the `nas.session.id` from the resource
 * attributes and is passed through by the caller (the OTLP receiver) which
 * already holds the current session id.
 *
 * Records are written via `INSERT OR IGNORE` against the composite PRIMARY KEY
 * `(conversation_id, sequence)`, so re-delivering the same batch is safe.
 */
export function ingestLogRecords(
  db: Database,
  payload: OtlpJsonExportLogsPayload,
  invocationId: string,
): IngestLogsResult {
  const result: IngestLogsResult = {
    acceptedRecords: 0,
    droppedRecords: 0,
    unknownEvents: 0,
  };

  const resourceLogs = payload?.resourceLogs;
  if (!Array.isArray(resourceLogs)) {
    console.warn("ingestLogRecords: payload has no resourceLogs");
    return result;
  }
  if (resourceLogs.length === 0) {
    return result;
  }

  // Collect valid rows before writing so all writes happen in one transaction.
  const rowsToInsert: Array<LogRecordRow> = [];

  for (const rl of resourceLogs) {
    const resAttrs = flattenAttributes(rl?.resource?.attributes);
    const nasSessionId = readStringAttr(resAttrs, "nas.session.id");
    // The invocationId passed by the caller is authoritative; the resource
    // attribute is used only for a sanity-warn when it disagrees or is absent.
    if (nasSessionId === null || nasSessionId.length === 0) {
      console.warn(
        `ingestLogRecords: resource nas.session.id is absent or empty, using invocationId (${invocationId})`,
      );
    } else if (nasSessionId !== invocationId) {
      console.warn(
        `ingestLogRecords: resource nas.session.id (${nasSessionId}) differs from invocationId (${invocationId}), using invocationId`,
      );
    }

    const scopeLogs = Array.isArray(rl?.scopeLogs) ? rl.scopeLogs : [];
    for (const sl of scopeLogs) {
      const logRecords = Array.isArray(sl?.logRecords) ? sl.logRecords : [];
      for (const lr of logRecords) {
        const attrs = flattenAttributes(lr?.attributes);

        // Resolve event name from `event.name` attribute.
        const eventName = readStringAttr(attrs, "event.name");
        if (eventName === null || eventName.length === 0) {
          console.warn(
            "ingestLogRecords: log record missing event.name attribute, dropping",
          );
          result.droppedRecords += 1;
          continue;
        }

        // Whitelist check
        if (!ALLOWED_EVENTS.has(eventName)) {
          console.warn(
            `ingestLogRecords: unknown event "${eventName}", dropping`,
          );
          result.unknownEvents += 1;
          result.droppedRecords += 1;
          continue;
        }

        // Required: session.id → conversation_id
        const conversationId = readStringAttr(attrs, "session.id");
        if (conversationId === null || conversationId.length === 0) {
          console.warn(
            `ingestLogRecords: log record for event "${eventName}" missing session.id, dropping`,
          );
          result.droppedRecords += 1;
          continue;
        }

        // Required: prompt.id
        const promptId = readStringAttr(attrs, "prompt.id");
        if (promptId === null || promptId.length === 0) {
          console.warn(
            `ingestLogRecords: log record for event "${eventName}" missing prompt.id, dropping`,
          );
          result.droppedRecords += 1;
          continue;
        }

        // Required: event.sequence (OTLP int64 may come as number or string)
        const sequenceStr =
          readStringAttr(attrs, "event.sequence") ??
          (attrs["event.sequence"] !== undefined
            ? String(attrs["event.sequence"])
            : null);
        const sequenceParsed = sequenceStr !== null ? Number(sequenceStr) : NaN;
        const sequence = Number.isInteger(sequenceParsed)
          ? sequenceParsed
          : null;
        if (sequence === null) {
          console.warn(
            `ingestLogRecords: log record for event "${eventName}" missing or invalid event.sequence, dropping`,
          );
          result.droppedRecords += 1;
          continue;
        }

        // Optional: request_id
        const requestId = readStringAttr(attrs, "request_id");

        // Timestamp
        const timeResolved = nanoToIso(lr?.timeUnixNano);
        if (timeResolved === null) {
          console.warn(
            `ingestLogRecords: log record for event "${eventName}" missing timeUnixNano, using epoch fallback`,
          );
        }
        const time = timeResolved ?? "1970-01-01T00:00:00.000Z";

        // Strip PII before persisting attrs
        const cleanAttrs = stripPiiAttrs(attrs);

        rowsToInsert.push({
          invocationId,
          conversationId,
          promptId,
          sequence,
          eventName,
          time,
          requestId,
          attrsJson: JSON.stringify(cleanAttrs),
        });
      }
    }
  }

  if (rowsToInsert.length === 0) return result;

  // Write inside a single transaction: upsert conversations first (FK
  // prerequisite), then bulk-insert the log records.
  const tx = db.transaction(() => {
    // Aggregate min/max time per conversation_id so that last_seen_at reflects
    // the latest record in the batch regardless of iteration order.
    const convTimes = new Map<
      string,
      { firstSeenAt: string; lastSeenAt: string }
    >();
    for (const row of rowsToInsert) {
      const existing = convTimes.get(row.conversationId);
      if (existing === undefined) {
        convTimes.set(row.conversationId, {
          firstSeenAt: row.time,
          lastSeenAt: row.time,
        });
      } else {
        if (row.time < existing.firstSeenAt) existing.firstSeenAt = row.time;
        if (row.time > existing.lastSeenAt) existing.lastSeenAt = row.time;
      }
    }
    for (const [conversationId, times] of convTimes) {
      upsertConversation(db, {
        id: conversationId,
        agent: null,
        firstSeenAt: times.firstSeenAt,
        lastSeenAt: times.lastSeenAt,
      });
    }
    // Bun/SQLite handles nested transactions via savepoints, so calling
    // insertLogRecords (which itself opens a transaction) from within this
    // outer transaction works correctly.
    insertLogRecords(db, rowsToInsert);
  });
  tx();

  result.acceptedRecords = rowsToInsert.length;
  return result;
}
