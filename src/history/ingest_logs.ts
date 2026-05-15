/**
 * Ingester for OTLP/JSON `ExportLogsServiceRequest` payloads.
 *
 * Walks `resourceLogs`. The caller-supplied `invocationId` is the authoritative
 * conversation invocation id; the resource-level `nas.session.id` is not read.
 * For each log record: classifies the event, extracts required attributes
 * (`session.id`, `prompt.id`, `event.sequence`), strips PII, upserts the
 * conversation FK, and writes the record via `insertLogRecords`.
 *
 * Drop semantics:
 * - `ALLOWED_EVENTS` → persist
 * - `KNOWN_EXCLUDED_EVENTS` → drop, NOT counted in `unknownEvents`
 * - everything else → drop, counted in `unknownEvents` (signal that Claude
 *   Code shipped a new event we haven't classified yet)
 *
 * No console output: the receiver runs inside the NAS host process during an
 * agent session, where stdout/stderr must stay clean. All drops surface only
 * via the returned `IngestLogsResult` counters.
 */

import type { Database } from "bun:sqlite";
import {
  flattenAttributes,
  nanoToIso,
  type OtlpKeyValue,
  readStringAttr,
  stripPiiAttrs,
} from "./otlp_wire.ts";
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

/** Persisted events (ADR 2026051301 §"ingest 対象 whitelist"). */
const ALLOWED_EVENTS = new Set([
  "user_prompt",
  "api_request",
  "hook_execution_start",
  "hook_execution_complete",
]);

/**
 * Events documented in ADR 2026051301 as deliberately not ingested. They are
 * expected on every turn (especially `internal_error` and `tool_result`);
 * keeping them out of `unknownEvents` preserves that counter's value as a
 * signal for genuinely new events shipped by Claude Code.
 *
 * Kept in sync with the rejected rows of the ADR's whitelist table.
 */
const KNOWN_EXCLUDED_EVENTS = new Set([
  "internal_error",
  "tool_result",
  "tool_decision",
  "skill_activated",
  "api_request_body",
  "api_response_body",
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
 * Missing required attributes cause the record to be dropped (counted in
 * `droppedRecords`). The `invocationId` parameter is supplied by the caller
 * (the OTLP receiver, which already holds the current session id) and is the
 * authoritative invocation FK regardless of what the payload's resource
 * attributes claim.
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
  if (!Array.isArray(resourceLogs) || resourceLogs.length === 0) {
    return result;
  }

  // Collect valid rows before writing so all writes happen in one transaction.
  const rowsToInsert: Array<LogRecordRow> = [];

  for (const rl of resourceLogs) {
    // invocationId is authoritative; resource-level nas.session.id is not read.
    const scopeLogs = Array.isArray(rl?.scopeLogs) ? rl.scopeLogs : [];
    for (const sl of scopeLogs) {
      const logRecords = Array.isArray(sl?.logRecords) ? sl.logRecords : [];
      for (const lr of logRecords) {
        const attrs = flattenAttributes(lr?.attributes);

        const eventName = readStringAttr(attrs, "event.name");
        if (eventName === null || eventName.length === 0) {
          result.droppedRecords += 1;
          continue;
        }

        // Three-tier classification: persist / known-rejected / truly-unknown.
        // Bumping unknownEvents only for the third tier keeps it useful as a
        // "Claude Code shipped a new event we should classify" signal.
        if (!ALLOWED_EVENTS.has(eventName)) {
          if (!KNOWN_EXCLUDED_EVENTS.has(eventName)) {
            result.unknownEvents += 1;
          }
          result.droppedRecords += 1;
          continue;
        }

        const conversationId = readStringAttr(attrs, "session.id");
        if (conversationId === null || conversationId.length === 0) {
          result.droppedRecords += 1;
          continue;
        }

        const promptId = readStringAttr(attrs, "prompt.id");
        if (promptId === null || promptId.length === 0) {
          result.droppedRecords += 1;
          continue;
        }

        // event.sequence: OTLP int64 may arrive as number or string.
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
          result.droppedRecords += 1;
          continue;
        }

        const requestId = readStringAttr(attrs, "request_id");

        // `time` is NOT NULL in the schema; fall back to epoch when the
        // payload omits timeUnixNano rather than dropping the record.
        const time = nanoToIso(lr?.timeUnixNano) ?? "1970-01-01T00:00:00.000Z";

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
