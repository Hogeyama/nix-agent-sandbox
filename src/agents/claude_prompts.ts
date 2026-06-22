/**
 * Claude Code prompt extraction.
 *
 * Browser-safe: imports only types from `../history/types`. No runtime
 * imports — safe to bundle into the UI frontend.
 *
 * Joins OTLP log records against spans to recover each trace's user prompt.
 *
 * Join chain (ADR §Reader):
 *   1. `api_request` log records: requestId → promptId
 *   2. `claude_code.llm_request` spans: requestId → traceId
 *      (via `attrs_json.request_id`)
 *   3. `user_prompt` log records: promptId → promptText
 *      (via `attrs_json.prompt`).
 *
 * When multiple records share a key, the one with the smallest sequence
 * wins (first emission wins — ADR invariant). Duplicates emit a single
 * `console.warn`. Any parse failure or missing link silently produces no
 * entry for that traceId so the caller renders `null` without losing
 * other entries.
 */

import type { LogRecordSummaryRow, SpanSummaryRow } from "../history/types";

// ---------------------------------------------------------------------------
// Internal helper: shared join-map construction
// ---------------------------------------------------------------------------

interface JoinMaps {
  /** api_request log records: requestId → { sequence, promptId } */
  requestIdToPromptId: Map<string, { sequence: number; promptId: string }>;
  /** user_prompt log records: promptId → { sequence, text } */
  promptIdToText: Map<string, { sequence: number; text: string }>;
  /** claude_code.llm_request spans: requestId → traceId */
  requestIdToTraceId: Map<string, string>;
}

/**
 * Build the three intermediate maps consumed by the public API functions.
 *
 * Deduplication invariant: when multiple records share a key the one with
 * the smallest `sequence` wins (first emission wins). Duplicates emit a
 * single `console.warn`.
 */
function buildJoinMaps(
  logRecords: readonly LogRecordSummaryRow[],
  spans: readonly SpanSummaryRow[],
): JoinMaps {
  const requestIdToPromptId = new Map<
    string,
    { sequence: number; promptId: string }
  >();
  const promptIdToText = new Map<string, { sequence: number; text: string }>();
  for (const rec of logRecords) {
    if (rec.eventName === "api_request" && rec.requestId !== null) {
      const existing = requestIdToPromptId.get(rec.requestId);
      if (existing === undefined) {
        requestIdToPromptId.set(rec.requestId, {
          sequence: rec.sequence,
          promptId: rec.promptId,
        });
      } else if (rec.sequence < existing.sequence) {
        console.warn(
          `[claude_prompts] duplicate api_request for requestId=${rec.requestId}, keeping sequence=${rec.sequence}`,
        );
        requestIdToPromptId.set(rec.requestId, {
          sequence: rec.sequence,
          promptId: rec.promptId,
        });
      } else {
        console.warn(
          `[claude_prompts] duplicate api_request for requestId=${rec.requestId}, keeping sequence=${existing.sequence}`,
        );
      }
    } else if (rec.eventName === "user_prompt") {
      try {
        const attrs = JSON.parse(rec.attrsJson) as Record<string, unknown>;
        const prompt =
          typeof attrs.prompt === "string" ? attrs.prompt : undefined;
        if (prompt !== undefined) {
          const existing = promptIdToText.get(rec.promptId);
          if (existing === undefined) {
            promptIdToText.set(rec.promptId, {
              sequence: rec.sequence,
              text: prompt,
            });
          } else if (rec.sequence < existing.sequence) {
            console.warn(
              `[claude_prompts] duplicate user_prompt for promptId=${rec.promptId}, keeping sequence=${rec.sequence}`,
            );
            promptIdToText.set(rec.promptId, {
              sequence: rec.sequence,
              text: prompt,
            });
          } else {
            console.warn(
              `[claude_prompts] duplicate user_prompt for promptId=${rec.promptId}, keeping sequence=${existing.sequence}`,
            );
          }
        }
      } catch {
        // malformed attrsJson — skip this record
      }
    }
  }

  const requestIdToTraceId = new Map<string, string>();
  for (const span of spans) {
    if (span.spanName === "claude_code.llm_request") {
      try {
        const attrs = JSON.parse(span.attrsJson) as Record<string, unknown>;
        const requestId =
          typeof attrs.request_id === "string" ? attrs.request_id : undefined;
        if (requestId !== undefined) {
          requestIdToTraceId.set(requestId, span.traceId);
        }
      } catch {
        // malformed attrsJson — skip this span
      }
    }
  }

  return { requestIdToPromptId, promptIdToText, requestIdToTraceId };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve each trace's user prompt: `traceId → promptText`.
 *
 * Uses the three-step join chain documented in the module header.
 */
export function extractClaudeTracePrompts(
  logRecords: readonly LogRecordSummaryRow[],
  spans: readonly SpanSummaryRow[],
): Map<string, string> {
  const { requestIdToPromptId, promptIdToText, requestIdToTraceId } =
    buildJoinMaps(logRecords, spans);

  const result = new Map<string, string>();
  for (const [requestId, traceId] of requestIdToTraceId) {
    const apiEntry = requestIdToPromptId.get(requestId);
    if (apiEntry === undefined) continue;
    const entry = promptIdToText.get(apiEntry.promptId);
    if (entry === undefined) continue;
    result.set(traceId, entry.text);
  }
  return result;
}

/**
 * Build a mapping from `promptId → traceId`.
 *
 * Joins `api_request` log records (requestId → promptId) against
 * `claude_code.llm_request` spans (requestId → traceId) to produce the
 * reverse lookup. When multiple requestIds map to the same promptId, the
 * entry with the smallest sequence (from the api_request dedup) wins.
 */
export function buildClaudePromptToTraceMap(
  logRecords: readonly LogRecordSummaryRow[],
  spans: readonly SpanSummaryRow[],
): Map<string, string> {
  const { requestIdToPromptId, requestIdToTraceId } = buildJoinMaps(
    logRecords,
    spans,
  );

  const result = new Map<string, string>();
  for (const [requestId, traceId] of requestIdToTraceId) {
    const apiEntry = requestIdToPromptId.get(requestId);
    if (apiEntry === undefined) continue;
    const { promptId } = apiEntry;
    // When multiple requestIds map to the same promptId, keep the first
    // one encountered (iteration order of requestIdToTraceId is insertion
    // order, which follows span array order).
    if (!result.has(promptId)) {
      result.set(promptId, traceId);
    }
  }
  return result;
}
