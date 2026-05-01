/**
 * Conversation-id resolution for an OTLP trace.
 *
 * Per ADR 2026042901 §"Trace と conversation 紐付けの解決ルール":
 * scan spans in input order; for each span prefer
 * `gen_ai.conversation.id` (Copilot CLI) and fall back to `session.id`
 * (Claude Code). Empty strings are treated as absent. The first non-empty
 * value wins. Pure function, no I/O.
 */

export interface ResolveConversationInput {
  spans: ReadonlyArray<{ attributes?: Record<string, unknown> }>;
}

export function pickConversationIdFromSpans(
  spans: ResolveConversationInput["spans"],
): string | null {
  for (const span of spans) {
    const attrs = span.attributes ?? {};
    const genAi = attrs["gen_ai.conversation.id"];
    if (typeof genAi === "string" && genAi.length > 0) {
      return genAi;
    }
    const sess = attrs["session.id"];
    if (typeof sess === "string" && sess.length > 0) {
      return sess;
    }
  }
  return null;
}
