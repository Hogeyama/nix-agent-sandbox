/**
 * Ingester for OTLP/JSON `ExportTraceServiceRequest` payloads.
 *
 * Walks `resourceSpans`, requires `nas.session.id` on the resource (warn-drop
 * otherwise), groups spans by `trace_id`, resolves a conversation id per
 * trace, and writes traces / conversations / spans through the writer
 * functions in `store.ts` inside a single transaction. Invocations are
 * assumed to already exist.
 */

import type { Database } from "bun:sqlite";
import {
  analyzeTraceUsageSources,
  classifySpan,
  pickConversationIdFromSpans,
  resolveSpanUsageColumns,
} from "../agents/otlp.ts";
import { insertSpans, upsertConversation, upsertTrace } from "./store.ts";
import type { SpanRow } from "./types.ts";

// ---------------------------------------------------------------------------
// OTLP/JSON wire types
// ---------------------------------------------------------------------------

export type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string | number }
  | { boolValue: boolean }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAttributeValue[] } }
  | Record<string, unknown>;

export interface OtlpKeyValue {
  key: string;
  value: OtlpAttributeValue;
}

export interface OtlpJsonSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  kind?: number;
  attributes?: ReadonlyArray<OtlpKeyValue>;
}

export interface OtlpJsonScopeSpans {
  scope?: { name?: string; version?: string };
  spans?: ReadonlyArray<OtlpJsonSpan>;
}

export interface OtlpJsonResourceSpans {
  resource?: { attributes?: ReadonlyArray<OtlpKeyValue> };
  scopeSpans?: ReadonlyArray<OtlpJsonScopeSpans>;
}

export interface OtlpJsonExportPayload {
  resourceSpans?: ReadonlyArray<OtlpJsonResourceSpans>;
}

// ---------------------------------------------------------------------------
// Result counters
// ---------------------------------------------------------------------------

export interface IngestResult {
  acceptedSpans: number;
  /** Resource-spans dropped because `nas.session.id` was missing. */
  droppedTraces: number;
  resolvedConversations: number;
}

// ---------------------------------------------------------------------------
// PII redaction
// ---------------------------------------------------------------------------

/**
 * OTLP attribute keys that carry user-identifying PII (real email, account ids,
 * hashed user id). Stripped from attrs before persistence; nothing in this
 * codebase consumes them.
 */
const PII_ATTR_KEYS: ReadonlySet<string> = new Set([
  "user.id",
  "user.email",
  "user.account_id",
  "user.account_uuid",
]);

function stripPiiAttrs(
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (PII_ATTR_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

function unwrapAttrValue(v: OtlpAttributeValue): unknown {
  if (v === null || typeof v !== "object") return v;
  const obj = v as Record<string, unknown>;
  if (typeof obj.stringValue === "string") return obj.stringValue;
  if (obj.intValue !== undefined) {
    // OTLP/JSON encodes int64 as either string or number; coerce to number.
    const raw = obj.intValue;
    if (typeof raw === "number") return raw;
    if (typeof raw === "string") {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : raw;
    }
  }
  if (typeof obj.boolValue === "boolean") return obj.boolValue;
  if (typeof obj.doubleValue === "number") return obj.doubleValue;
  if (
    obj.arrayValue !== undefined &&
    typeof obj.arrayValue === "object" &&
    obj.arrayValue !== null
  ) {
    const arr = (obj.arrayValue as { values?: OtlpAttributeValue[] }).values;
    if (Array.isArray(arr)) return arr.map(unwrapAttrValue);
  }
  return v;
}

function flattenAttributes(
  rawAttrs: ReadonlyArray<OtlpKeyValue> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!rawAttrs) return out;
  for (const kv of rawAttrs) {
    if (typeof kv?.key !== "string") continue;
    out[kv.key] = unwrapAttrValue(kv.value);
  }
  return out;
}

function readStringAttr(
  attrs: Record<string, unknown>,
  key: string,
): string | null {
  const v = attrs[key];
  return typeof v === "string" ? v : null;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * OTLP encodes timestamps as Unix nanoseconds, often as a decimal string to
 * preserve int64 precision. We need an ISO-8601 Z string with millisecond
 * precision (the rest of the schema uses that). Returns null on absent /
 * non-finite input.
 */
function nanoToIso(nano: string | number | undefined): string | null {
  if (nano === undefined || nano === null) return null;
  let ms: number;
  if (typeof nano === "number") {
    if (!Number.isFinite(nano)) return null;
    ms = Math.floor(nano / 1_000_000);
  } else if (typeof nano === "string") {
    if (nano.length === 0) return null;
    // Use BigInt to avoid losing precision on large nanosecond values, then
    // divide down to milliseconds where Number is sufficient.
    let big: bigint;
    try {
      big = BigInt(nano);
    } catch {
      return null;
    }
    ms = Number(big / 1_000_000n);
  } else {
    return null;
  }
  return new Date(ms).toISOString();
}

function nanoToNumber(nano: string | number | undefined): number | null {
  if (nano === undefined || nano === null) return null;
  if (typeof nano === "number") return Number.isFinite(nano) ? nano : null;
  if (typeof nano === "string") {
    if (nano.length === 0) return null;
    const n = Number(nano);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

interface PerTraceAccum {
  traceId: string;
  // Spans in the order they were observed in the payload (matters for the
  // conversation-id resolution rule).
  spansInOrder: Array<{ raw: OtlpJsonSpan; attrs: Record<string, unknown> }>;
  minStartNano: number | null;
  maxEndNano: number | null;
}

export function ingestResourceSpans(
  db: Database,
  payload: OtlpJsonExportPayload,
): IngestResult {
  const result: IngestResult = {
    acceptedSpans: 0,
    droppedTraces: 0,
    resolvedConversations: 0,
  };

  const resourceSpans = payload?.resourceSpans;
  if (!Array.isArray(resourceSpans) || resourceSpans.length === 0) {
    console.warn("ingestResourceSpans: payload has no resourceSpans");
    return result;
  }

  // Build per-resource work units: each carries the nas.session.id required
  // to write traces, plus the per-trace span groups.
  interface ResourceWork {
    nasSessionId: string;
    nasAgent: string | null;
    traces: Map<string, PerTraceAccum>;
  }
  const resourceWorks: ResourceWork[] = [];

  for (const rs of resourceSpans) {
    const resAttrs = flattenAttributes(rs?.resource?.attributes);
    const nasSessionId = readStringAttr(resAttrs, "nas.session.id");
    if (nasSessionId === null || nasSessionId.length === 0) {
      console.warn(
        "ingestResourceSpans: resource missing nas.session.id, dropping",
      );
      result.droppedTraces += 1;
      continue;
    }
    const nasAgent = readStringAttr(resAttrs, "nas.agent");

    const traces = new Map<string, PerTraceAccum>();
    const scopeSpans = Array.isArray(rs?.scopeSpans) ? rs.scopeSpans : [];
    for (const ss of scopeSpans) {
      const spans = Array.isArray(ss?.spans) ? ss.spans : [];
      for (const sp of spans) {
        if (
          typeof sp?.traceId !== "string" ||
          sp.traceId.length === 0 ||
          typeof sp?.spanId !== "string" ||
          sp.spanId.length === 0 ||
          typeof sp?.name !== "string"
        ) {
          console.warn(
            "ingestResourceSpans: span missing traceId/spanId/name, dropping span",
          );
          continue;
        }
        const attrs = flattenAttributes(sp.attributes);
        let acc = traces.get(sp.traceId);
        if (!acc) {
          acc = {
            traceId: sp.traceId,
            spansInOrder: [],
            minStartNano: null,
            maxEndNano: null,
          };
          traces.set(sp.traceId, acc);
        }
        acc.spansInOrder.push({ raw: sp, attrs });
        const startN = nanoToNumber(sp.startTimeUnixNano);
        if (startN !== null) {
          acc.minStartNano =
            acc.minStartNano === null
              ? startN
              : Math.min(acc.minStartNano, startN);
        }
        const endN = nanoToNumber(sp.endTimeUnixNano);
        if (endN !== null) {
          acc.maxEndNano =
            acc.maxEndNano === null ? endN : Math.max(acc.maxEndNano, endN);
        }
      }
    }
    resourceWorks.push({ nasSessionId, nasAgent, traces });
  }

  if (resourceWorks.length === 0) return result;

  // Single transaction over all writes from this export so a failure mid-way
  // doesn't leave partial trace/conversation rows behind.
  const tx = db.transaction(() => {
    for (const work of resourceWorks) {
      for (const acc of work.traces.values()) {
        const conversationId = pickConversationIdFromSpans(
          acc.spansInOrder.map((s) => ({ attributes: s.attrs })),
        );
        const traceStartedIso = nanoToIso(
          acc.minStartNano !== null ? acc.minStartNano : undefined,
        );
        const traceEndedIso = nanoToIso(
          acc.maxEndNano !== null ? acc.maxEndNano : undefined,
        );
        // started_at is NOT NULL in the schema; if every span lacked a start
        // timestamp we fall back to ended_at, then to "epoch" as a last resort
        // so the row can be written.
        const startedAt =
          traceStartedIso ?? traceEndedIso ?? "1970-01-01T00:00:00.000Z";

        // Insert the conversation row first so that traces.conversation_id's
        // FK to conversations(id) holds when we then upsert the trace.
        if (conversationId !== null) {
          upsertConversation(db, {
            id: conversationId,
            agent: work.nasAgent,
            firstSeenAt: startedAt,
            lastSeenAt: traceEndedIso ?? startedAt,
          });
          result.resolvedConversations += 1;
        }

        upsertTrace(db, {
          traceId: acc.traceId,
          invocationId: work.nasSessionId,
          conversationId,
          startedAt,
          endedAt: traceEndedIso,
        });

        const spanRows: SpanRow[] = [];
        const traceUsageSources = analyzeTraceUsageSources(
          acc.spansInOrder.map(({ raw, attrs }) => ({
            name: raw.name,
            attributes: attrs,
          })),
        );
        for (const { raw, attrs } of acc.spansInOrder) {
          const startNano = nanoToNumber(raw.startTimeUnixNano);
          const endNano = nanoToNumber(raw.endTimeUnixNano);
          let durationMs: number | null = null;
          if (startNano !== null && endNano !== null) {
            const d = Math.floor((endNano - startNano) / 1_000_000);
            durationMs = d >= 0 ? d : null;
          }
          const startedIso =
            nanoToIso(raw.startTimeUnixNano) ?? "1970-01-01T00:00:00.000Z";
          const endedIso = nanoToIso(raw.endTimeUnixNano);

          const kind = classifySpan(raw.name, attrs);
          const usage = resolveSpanUsageColumns({
            kind,
            spanName: raw.name,
            attrs,
            traceUsageSources,
          });

          spanRows.push({
            spanId: raw.spanId,
            parentSpanId:
              typeof raw.parentSpanId === "string" &&
              raw.parentSpanId.length > 0
                ? raw.parentSpanId
                : null,
            traceId: raw.traceId,
            spanName: raw.name,
            kind,
            model: usage.model,
            inTok: usage.inTok,
            outTok: usage.outTok,
            cacheR: usage.cacheR,
            cacheW: usage.cacheW,
            durationMs,
            startedAt: startedIso,
            endedAt: endedIso,
            attrsJson: JSON.stringify(stripPiiAttrs(attrs)),
          });
        }
        if (spanRows.length > 0) {
          insertSpans(db, spanRows);
          result.acceptedSpans += spanRows.length;
        }
      }
    }
  });
  tx();

  return result;
}
