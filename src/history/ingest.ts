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
import { classifySpan, pickConversationIdFromSpans } from "../agents/otlp.ts";
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

function readFirstStringAttr(
  attrs: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys) {
    const value = readStringAttr(attrs, key);
    if (value !== null) return value;
  }
  return null;
}

function readNumberAttr(
  attrs: Record<string, unknown>,
  key: string,
): number | null {
  const v = attrs[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/**
 * Read a token-count attribute from the first finite number among known
 * vendor/semantic-convention keys.
 */
function readTokenAttr(
  attrs: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | null {
  for (const key of keys) {
    const value = readNumberAttr(attrs, key);
    if (value !== null) return value;
  }
  return null;
}

function isCodexTokenUsageSpan(name: string): boolean {
  return name === "codex.turn.token_usage";
}

function isCodexResponseOrStreamSpan(name: string): boolean {
  return (
    name === "codex.response" ||
    name === "codex.responses" ||
    name === "model_client.stream_responses" ||
    name === "model_client.stream_responses_websocket" ||
    name === "responses.stream_request" ||
    name === "responses_websocket.stream_request"
  );
}

function isCodexTurnSpan(name: string): boolean {
  return name === "session_task.turn";
}

/**
 * Token-carrying attribute keys we recognise on Codex response/stream spans.
 * A response/stream span counts as a usage source only when at least one of
 * these resolves to a finite number. Older Codex builds emitted tokens here;
 * gpt-5.4-mini and newer leave these blank and put usage exclusively on
 * `session_task.turn` as `codex.turn.token_usage.*` attributes.
 */
const RESPONSE_STREAM_USAGE_KEYS = [
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "input_tokens",
  "output_tokens",
] as const;

function spanHasResponseStreamUsage(attrs: Record<string, unknown>): boolean {
  for (const key of RESPONSE_STREAM_USAGE_KEYS) {
    if (readNumberAttr(attrs, key) !== null) return true;
  }
  return false;
}

function shouldPromoteUsageColumns(
  kind: string,
  spanName: string,
  traceHasCodexTokenUsage: boolean,
  traceHasCodexResponseOrStreamWithUsage: boolean,
): boolean {
  if (isCodexTurnSpan(spanName)) {
    // session_task.turn is the lowest-priority fallback per ADR
    // 2026042901: only promote it when neither a `codex.turn.token_usage`
    // span nor a response/stream span carrying real token attrs is present
    // in the trace.
    return !traceHasCodexTokenUsage && !traceHasCodexResponseOrStreamWithUsage;
  }
  if (kind !== "chat") return false;
  if (traceHasCodexTokenUsage && isCodexResponseOrStreamSpan(spanName)) {
    return false;
  }
  return true;
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
        const traceHasCodexTokenUsage = acc.spansInOrder.some(({ raw }) =>
          isCodexTokenUsageSpan(raw.name),
        );
        const traceHasCodexResponseOrStreamWithUsage = acc.spansInOrder.some(
          ({ raw, attrs }) =>
            isCodexResponseOrStreamSpan(raw.name) &&
            spanHasResponseStreamUsage(attrs),
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
          const promoteUsage = shouldPromoteUsageColumns(
            kind,
            raw.name,
            traceHasCodexTokenUsage,
            traceHasCodexResponseOrStreamWithUsage,
          );

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
            model: promoteUsage
              ? readFirstStringAttr(attrs, [
                  "gen_ai.response.model",
                  "gen_ai.request.model",
                  "model",
                ])
              : null,
            inTok: promoteUsage
              ? readTokenAttr(attrs, [
                  "gen_ai.usage.input_tokens",
                  "input_tokens",
                  "codex.turn.token_usage.input_tokens",
                ])
              : null,
            outTok: promoteUsage
              ? readTokenAttr(attrs, [
                  "gen_ai.usage.output_tokens",
                  "output_tokens",
                  "codex.turn.token_usage.output_tokens",
                ])
              : null,
            cacheR: promoteUsage
              ? readTokenAttr(attrs, [
                  "gen_ai.usage.cache_read.input_tokens",
                  "gen_ai.usage.cache_read_input_tokens",
                  "cache_read_tokens",
                  "codex.turn.token_usage.cache_read_input_tokens",
                  "codex.turn.token_usage.cache_read.input_tokens",
                ])
              : null,
            cacheW: promoteUsage
              ? readTokenAttr(attrs, [
                  "gen_ai.usage.cache_creation.input_tokens",
                  "gen_ai.usage.cache_creation_input_tokens",
                  "cache_creation_tokens",
                  "codex.turn.token_usage.cache_creation_input_tokens",
                  "codex.turn.token_usage.cache_creation.input_tokens",
                ])
              : null,
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
