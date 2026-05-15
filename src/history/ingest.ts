/**
 * Ingester for OTLP/JSON `ExportTraceServiceRequest` payloads.
 *
 * Walks `resourceSpans`, requires `nas.session.id` on the resource (silent
 * drop otherwise — counted in `droppedTraces`), groups spans by `trace_id`,
 * resolves a conversation id per trace, and writes traces / conversations /
 * spans through the writer functions in `store.ts` inside a single
 * transaction. Invocations are assumed to already exist.
 *
 * No console output: the receiver runs inside the NAS host process during an
 * agent session, where stdout/stderr must stay clean. All drops surface only
 * via the returned `IngestResult` counters.
 */

import type { Database } from "bun:sqlite";
import {
  analyzeTraceUsageSources,
  classifySpan,
  pickConversationIdFromSpans,
  resolveSpanUsageColumns,
} from "../agents/otlp.ts";
import {
  flattenAttributes,
  nanoToIso,
  type OtlpKeyValue,
  readStringAttr,
  stripPiiAttrs,
} from "./otlp_wire.ts";
import { insertSpans, upsertConversation, upsertTrace } from "./store.ts";
import type { SpanRow } from "./types.ts";

// ---------------------------------------------------------------------------
// OTLP/JSON wire types (traces-only)
// ---------------------------------------------------------------------------

export interface OtlpJsonSpanEvent {
  name?: string;
  timeUnixNano?: string | number;
  attributes?: ReadonlyArray<OtlpKeyValue>;
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
  events?: ReadonlyArray<OtlpJsonSpanEvent>;
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

/**
 * Persisted shape of a span event after ingest: ISO timestamp, sanitised
 * attributes, anonymous (no span_id — it lives on the parent span row).
 */
interface PersistedSpanEvent {
  name: string;
  time: string | null;
  attrs: Record<string, unknown>;
}

/**
 * Flatten and sanitise OTLP span events. Events without a name are dropped
 * (the OTLP spec requires `name` on span events). Returns `null` instead of
 * `[]` so the column stays NULL for the majority of spans that carry no
 * events.
 */
function extractSpanEvents(
  events: ReadonlyArray<OtlpJsonSpanEvent> | undefined,
): PersistedSpanEvent[] | null {
  if (!Array.isArray(events) || events.length === 0) return null;
  const out: PersistedSpanEvent[] = [];
  for (const ev of events) {
    if (typeof ev?.name !== "string" || ev.name.length === 0) continue;
    out.push({
      name: ev.name,
      time: nanoToIso(ev.timeUnixNano),
      attrs: stripPiiAttrs(flattenAttributes(ev.attributes)),
    });
  }
  return out.length === 0 ? null : out;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

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

          // Copilot CLI (OpenAI convention) reports input_tokens inclusive
          // of cached tokens, unlike Anthropic which reports them separately.
          // Subtract cacheR so inTok represents only non-cached input.
          const inTok =
            work.nasAgent === "copilot" &&
            usage.inTok !== null &&
            usage.cacheR !== null
              ? Math.max(usage.inTok - usage.cacheR, 0)
              : usage.inTok;

          const persistedEvents = extractSpanEvents(raw.events);
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
            inTok,
            outTok: usage.outTok,
            cacheR: usage.cacheR,
            cacheW: usage.cacheW,
            durationMs,
            startedAt: startedIso,
            endedAt: endedIso,
            attrsJson: JSON.stringify(stripPiiAttrs(attrs)),
            eventsJson:
              persistedEvents === null ? null : JSON.stringify(persistedEvents),
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
