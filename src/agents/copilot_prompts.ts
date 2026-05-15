/**
 * Copilot CLI prompt extraction.
 *
 * Browser-safe: imports only types from `../history/types`. No runtime
 * imports — safe to bundle into the UI frontend.
 *
 * Mines each trace's root `invoke_agent` span (`kind==="invoke_agent"` and
 * `parentSpanId===null`) for the OTEL GenAI semconv `gen_ai.input.messages`
 * attribute — a JSON-stringified array of `{role, parts:[{type,content}]}`.
 * Copilot CLI emits this when `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`
 * is set (see `observability.ts`).
 *
 * Subagent invocations have a non-null parent and are skipped — their
 * "prompt" is a synthesized handoff, not user-typed text.
 *
 * Within the messages array we keep the *last* `role==="user"` text
 * message whose content is not an auto-injected block. Currently filtered:
 *
 *   - `<system_notification` — injected when a subagent reports back.
 *   - `<skill-context` — injected when a skill is invoked, carrying the
 *     skill's system-prompt / instructions.
 *
 * These would shadow the user's actual prompt. "Last wins" so that, in a
 * trace whose attribute happens to carry full history, the most recent
 * user input is what surfaces.
 *
 * Any parse failure or missing link silently produces no entry for that
 * traceId so the caller renders `null` without losing other entries.
 */

import type { SpanSummaryRow } from "../history/types";

export function extractCopilotTracePrompts(
  spans: readonly SpanSummaryRow[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const span of spans) {
    if (span.kind !== "invoke_agent") continue;
    if (span.parentSpanId !== null) continue;
    let attrs: Record<string, unknown>;
    try {
      attrs = JSON.parse(span.attrsJson) as Record<string, unknown>;
    } catch {
      continue;
    }
    const rawMessages = attrs["gen_ai.input.messages"];
    if (typeof rawMessages !== "string") continue;
    let messages: unknown;
    try {
      messages = JSON.parse(rawMessages);
    } catch {
      continue;
    }
    if (!Array.isArray(messages)) continue;
    let candidate: string | null = null;
    for (const m of messages) {
      if (typeof m !== "object" || m === null) continue;
      if ((m as Record<string, unknown>).role !== "user") continue;
      const text = extractGenAiUserText(m as Record<string, unknown>);
      if (text === null) continue;
      if (isAutoInjectedBlock(text)) continue;
      candidate = text;
    }
    if (candidate !== null) result.set(span.traceId, candidate);
  }
  return result;
}

/** XML tag prefixes injected automatically by the runtime (not user-typed). */
const AUTO_INJECTED_PREFIXES = [
  "<system_notification",
  "<skill-context",
] as const;

function isAutoInjectedBlock(text: string): boolean {
  return AUTO_INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * Concatenate the `parts[*].content` of a single OTEL GenAI message where
 * `parts[*].type === "text"`. Returns `null` if no text part survives.
 */
function extractGenAiUserText(message: Record<string, unknown>): string | null {
  const parts = message.parts;
  if (!Array.isArray(parts)) return null;
  let out = "";
  for (const p of parts) {
    if (typeof p !== "object" || p === null) continue;
    const obj = p as Record<string, unknown>;
    if (obj.type !== "text") continue;
    if (typeof obj.content !== "string") continue;
    out += obj.content;
  }
  return out.length > 0 ? out : null;
}
