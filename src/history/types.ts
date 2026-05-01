/**
 * Row types for the history SQLite store.
 *
 * Conventions:
 * - All TEXT timestamp fields are ISO-8601 strings with a trailing `Z` so
 *   lexicographic comparison agrees with chronological order (matches the
 *   audit store).
 * - Field names here are camelCase; the on-disk column names are snake_case
 *   (the writer functions handle the mapping).
 */

/** A single nas CLI invocation (one process). */
export interface InvocationRow {
  /** nas-issued sess_<hex>. */
  id: string;
  profile: string | null;
  agent: string | null;
  worktreePath: string | null;
  startedAt: string;
  endedAt: string | null;
  exitReason: string | null;
}

/**
 * An agent-side conversation. Persists across `--resume`. `agent` is
 * nullable because nas hook can observe a conversation before the OTLP
 * receiver classifies its agent type, and writes a row with `agent = null`.
 */
export interface ConversationRow {
  /** Agent-issued id (Claude session.id / Copilot gen_ai.conversation.id). */
  id: string;
  agent: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Junction between invocation and conversation. */
export interface TraceRow {
  traceId: string;
  invocationId: string;
  /** NULL until the receiver resolves it from a span attribute. */
  conversationId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface SpanRow {
  spanId: string;
  parentSpanId: string | null;
  traceId: string;
  spanName: string;
  kind: string;
  model: string | null;
  inTok: number | null;
  outTok: number | null;
  cacheR: number | null;
  cacheW: number | null;
  durationMs: number | null;
  startedAt: string;
  endedAt: string | null;
  /** Serialized JSON object of any attrs not promoted to dedicated columns. */
  attrsJson: string;
}

export interface TurnEventRow {
  invocationId: string;
  conversationId: string | null;
  ts: string;
  kind: string;
  payloadJson: string;
}
