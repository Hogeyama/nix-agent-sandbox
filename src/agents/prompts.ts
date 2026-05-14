/**
 * Per-agent prompt-extractor aggregator.
 *
 * The view layer asks "what is the user prompt for this trace?" without
 * caring which agent produced the OTLP data. This module hides that
 * dispatch by running each agent's extractor and merging the maps.
 *
 * Agent-specific logic lives in `claude_prompts.ts` / `copilot_prompts.ts`;
 * this file owns only the merge contract: **Claude takes precedence over
 * Copilot when both signals resolve for the same traceId**. In practice a
 * trace carries only one agent's signal, so the priority rule is defensive
 * only.
 *
 * Browser-safe (transitively only type imports + browser-safe agent
 * modules).
 */

import type { LogRecordSummaryRow, SpanSummaryRow } from "../history/types";
import { extractClaudeTracePrompts } from "./claude_prompts";
import { extractCopilotTracePrompts } from "./copilot_prompts";

export function extractTracePrompts(
  logRecords: readonly LogRecordSummaryRow[],
  spans: readonly SpanSummaryRow[],
): Map<string, string> {
  const result = extractClaudeTracePrompts(logRecords, spans);
  for (const [traceId, text] of extractCopilotTracePrompts(spans)) {
    if (!result.has(traceId)) {
      result.set(traceId, text);
    }
  }
  return result;
}
