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

// ---------------------------------------------------------------------------
// Reader row shapes (returned by query* helpers in store.ts and consumed by
// the UI / SSE layers). Kept in this file — separately from store.ts — so
// frontend bundles can `import type` them without dragging bun:sqlite into
// the resolver.
// ---------------------------------------------------------------------------

/**
 * Conversation list row with denormalized aggregates. Token totals collapse
 * NULL columns to 0 so a conversation recorded by the hook but with no
 * associated spans yet still produces 0 (never NULL).
 */
export interface ConversationListRow {
  readonly id: string;
  readonly agent: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /**
   * Number of user turns. Sourced from `traces` (one trace per
   * request → response cycle) — not from the `turn_events` stream, which
   * over-counts because it logs every assistant message / tool use / etc.
   */
  readonly turnCount: number;
  readonly spanCount: number;
  readonly invocationCount: number;
  readonly inputTokensTotal: number;
  readonly outputTokensTotal: number;
  readonly cacheReadTotal: number;
  readonly cacheWriteTotal: number;
  /**
   * First user prompt of the conversation, captured by the hook from the
   * agent's transcript. NULL when no transcript was available (e.g. agents
   * that do not emit a `transcript_path` in the hook payload, or when the
   * hook fired before the first user turn).
   */
  readonly summary: string | null;
  /**
   * `worktree_path` of the most recent invocation joined to this conversation
   * (via `traces.conversation_id`). NULL when no invocation has been linked
   * yet, or when every linked invocation recorded a NULL worktree path.
   * The list page strips the `/.nas/worktree/<name>` suffix to derive the
   * project directory shown in the row.
   */
  readonly worktreePath: string | null;
}

export interface TraceSummaryRow {
  readonly traceId: string;
  readonly invocationId: string;
  readonly conversationId: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly spanCount: number;
}

export interface SpanSummaryRow {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly traceId: string;
  readonly spanName: string;
  readonly kind: string;
  readonly model: string | null;
  readonly inTok: number | null;
  readonly outTok: number | null;
  readonly cacheR: number | null;
  readonly cacheW: number | null;
  readonly durationMs: number | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly attrsJson: string;
}

export interface InvocationSummaryRow {
  readonly id: string;
  readonly profile: string | null;
  readonly agent: string | null;
  readonly worktreePath: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitReason: string | null;
}

export interface ConversationDetail {
  readonly conversation: ConversationListRow;
  readonly traces: TraceSummaryRow[];
  readonly spans: SpanSummaryRow[];
  readonly invocations: InvocationSummaryRow[];
  /**
   * Per-model token totals over the whole life of this conversation. The
   * `ConversationListRow` aggregates above collapse all models into one
   * total; this breakdown carries the same numbers split by `spans.model`
   * (with a single NULL-model row collapsing model-less spans). Order is
   * deterministic — `model ASC` with the NULL row last — so SSE diff
   * hashing stays stable across polls.
   */
  readonly modelTokenTotals: ModelTokenTotalsRow[];
}

export interface InvocationDetail {
  readonly invocation: InvocationSummaryRow;
  readonly traces: TraceSummaryRow[];
  readonly spans: SpanSummaryRow[];
  /** All conversations referenced by this invocation's traces (subagents may produce multiple). */
  readonly conversations: ConversationListRow[];
}

/**
 * Per-model token totals aggregated over a time window. One row per distinct
 * `spans.model` value (including a single row for `model IS NULL` collected
 * separately by SQLite's `GROUP BY` NULL-grouping). Cache columns COALESCE
 * NULL to 0 so a row never carries a NULL aggregate.
 */
export interface ModelTokenTotalsRow {
  readonly model: string | null;
  /** Total tokens across every span. Always equals base + above200k. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /**
   * Tokens contributed by spans whose effective input
   * (`in_tok + cache_r + cache_w`) exceeded the long-context threshold
   * of 200_000. Anthropic charges every cost field on such requests at
   * the upper tier (`*_above_200k_tokens` in the LiteLLM catalogue),
   * including output tokens generated for that request, so all four
   * counters split into a base bucket (= total - above200k) and an
   * above-threshold bucket priced at the higher rate. Models without an
   * upper-tier rate fall back to the base rate so this split costs
   * nothing for non-1M-context models.
   */
  readonly inputTokensAbove200k: number;
  readonly outputTokensAbove200k: number;
  readonly cacheReadAbove200k: number;
  readonly cacheWriteAbove200k: number;
}

/**
 * Per-span effective-input threshold (in tokens) at which Anthropic
 * applies long-context (1M) pricing. Aggregation layers split totals
 * around this number; pricing layers map the above-threshold bucket to
 * `*_above_200k_tokens` rates from the LiteLLM catalogue.
 */
export const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000;
