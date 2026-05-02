/**
 * Conversation-id resolution for an OTLP trace.
 *
 * Per ADR 2026042901 §"Trace と conversation 紐付けの解決ルール":
 * first scan all spans in input order for `gen_ai.conversation.id` (Copilot
 * CLI) or `session.id` (Claude Code), then scan all spans again for Codex's
 * `conversation.id` / `thread.id` fallback. Empty strings are treated as
 * absent. The first non-empty value within the active scan wins. Pure
 * function, no I/O.
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
  for (const span of spans) {
    const attrs = span.attributes ?? {};
    const codexConversation = attrs["conversation.id"];
    if (typeof codexConversation === "string" && codexConversation.length > 0) {
      return codexConversation;
    }
    const codexThread = attrs["thread.id"];
    if (typeof codexThread === "string" && codexThread.length > 0) {
      return codexThread;
    }
  }
  return null;
}
