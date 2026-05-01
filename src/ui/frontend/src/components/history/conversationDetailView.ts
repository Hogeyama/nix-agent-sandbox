/**
 * Pure view-helpers for the conversation detail page.
 *
 * Side-effect-free projections from the backend `ConversationDetail`
 * shape into row/header types the Solid component renders. Kept apart
 * from the component so the formatting logic — short ids, relative
 * times, null fallbacks, payload truncation — can be unit-tested
 * without a Solid runtime or DOM.
 *
 * Time-of-day inputs are passed through `nowMs`; the helpers never
 * read the wall clock so tests can pin a deterministic reference.
 */

import type {
  ConversationDetail,
  ConversationTurnEventRow,
  InvocationSummaryRow,
  SpanSummaryRow,
  TraceSummaryRow,
} from "../../../../../history/types";
import { formatRelativeTime, shortenId } from "./historyListView";

/** Placeholder string for nullable `agent` columns. */
const AGENT_FALLBACK = "(unknown)";
/** Placeholder string for nullable `profile` columns. */
const PROFILE_FALLBACK = "(none)";
/** Placeholder string for nullable path/text columns. */
const TEXT_FALLBACK = "(unknown)";
/** Placeholder string for tabular numeric/dash cells (span model, parent id, …). */
const DASH = "—";
/** Placeholder string for an invocation that has not ended yet. */
const RUNNING = "(running)";
/** Maximum payload preview length (chars) before the trailing ellipsis. */
const PAYLOAD_PREVIEW_MAX = 80;

export interface ConversationHeaderView {
  readonly id: string;
  readonly idLabel: string;
  readonly agent: string;
  readonly firstSeen: string;
  readonly firstSeenAbsolute: string;
  readonly lastSeen: string;
  readonly lastSeenAbsolute: string;
  readonly turnCount: number;
  readonly spanCount: number;
  readonly invocationCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly tokenTotal: number;
}

export interface InvocationLinkRow {
  readonly id: string;
  readonly idLabel: string;
  readonly profile: string;
  readonly worktreePath: string;
  readonly startedAt: string;
  readonly startedAtAbsolute: string;
  readonly endedAt: string;
  readonly endedAtAbsolute: string;
  readonly exitReason: string;
  readonly href: string;
}

export interface TraceRowView {
  readonly traceId: string;
  readonly traceIdLabel: string;
  readonly invocationId: string;
  readonly invocationIdLabel: string;
  readonly invocationHref: string;
  readonly startedAt: string;
  readonly startedAtAbsolute: string;
  readonly endedAt: string;
  readonly endedAtAbsolute: string;
  readonly spanCount: number;
}

export interface SpanRowView {
  readonly spanId: string;
  readonly spanIdLabel: string;
  readonly parentSpanIdLabel: string;
  readonly traceId: string;
  readonly traceIdLabel: string;
  readonly spanName: string;
  readonly kind: string;
  readonly model: string;
  readonly inTok: string;
  readonly outTok: string;
  readonly durationMs: string;
  readonly startedAt: string;
  readonly startedAtAbsolute: string;
}

/**
 * Row shape for the turn-event tables on both detail pages.
 *
 * The link-* fields are deliberately neutral: on the conversation page
 * they point at the row's invocation, and on the invocation page they
 * point at the row's conversation. The page that owns the table picks
 * the column header ("Invocation" vs "Conversation") to match.
 */
export interface TurnEventRowView {
  readonly linkId: string;
  readonly linkIdLabel: string;
  readonly linkHref: string;
  readonly ts: string;
  readonly tsAbsolute: string;
  readonly kind: string;
  readonly payloadPreview: string;
}

/**
 * Truncate the payload JSON for inline display. Returned string is
 * either the original (when short) or the leading `PAYLOAD_PREVIEW_MAX`
 * characters with an ellipsis. Whitespace is collapsed so a multi-line
 * JSON blob does not break the row layout.
 */
export function truncatePayload(json: string): string {
  const collapsed = json.replace(/\s+/g, " ").trim();
  if (collapsed.length <= PAYLOAD_PREVIEW_MAX) return collapsed;
  return `${collapsed.slice(0, PAYLOAD_PREVIEW_MAX)}…`;
}

/**
 * Format a nullable duration as `<n>ms`, falling back to the dash
 * placeholder when the column is null. The number is rendered with no
 * thousands separators so it lines up under tabular-nums.
 */
export function formatDurationMs(ms: number | null): string {
  if (ms === null) return DASH;
  return `${ms}ms`;
}

/**
 * Render a nullable token-count column. Null becomes the dash
 * placeholder so an empty cell is visually distinct from a `0` count.
 */
export function formatTokenCell(value: number | null): string {
  if (value === null) return DASH;
  return String(value);
}

/** Project an `InvocationSummaryRow` into the conversation-detail link row. */
function toInvocationLinkRow(
  row: InvocationSummaryRow,
  nowMs: number,
): InvocationLinkRow {
  return {
    id: row.id,
    idLabel: shortenId(row.id),
    profile: row.profile ?? PROFILE_FALLBACK,
    worktreePath: row.worktreePath ?? TEXT_FALLBACK,
    startedAt: formatRelativeTime(row.startedAt, nowMs),
    startedAtAbsolute: row.startedAt,
    endedAt:
      row.endedAt === null ? RUNNING : formatRelativeTime(row.endedAt, nowMs),
    endedAtAbsolute: row.endedAt ?? "",
    exitReason: row.exitReason ?? TEXT_FALLBACK,
    // `encodeURIComponent` mirrors the conversation-list link helper so
    // ids containing characters outside the router's allowlist still
    // round-trip back through `decodeURIComponent`.
    href: `#/history/invocation/${encodeURIComponent(row.id)}`,
  };
}

export function buildConversationHeader(
  detail: ConversationDetail,
  nowMs: number,
): ConversationHeaderView {
  const c = detail.conversation;
  return {
    id: c.id,
    idLabel: shortenId(c.id),
    agent: c.agent ?? AGENT_FALLBACK,
    firstSeen: formatRelativeTime(c.firstSeenAt, nowMs),
    firstSeenAbsolute: c.firstSeenAt,
    lastSeen: formatRelativeTime(c.lastSeenAt, nowMs),
    lastSeenAbsolute: c.lastSeenAt,
    turnCount: c.turnEventCount,
    spanCount: c.spanCount,
    invocationCount: c.invocationCount,
    inputTokens: c.inputTokensTotal,
    outputTokens: c.outputTokensTotal,
    cacheReadTokens: c.cacheReadTotal,
    cacheWriteTokens: c.cacheWriteTotal,
    tokenTotal: c.inputTokensTotal + c.outputTokensTotal,
  };
}

export function buildInvocationLinks(
  detail: ConversationDetail,
  nowMs: number,
): InvocationLinkRow[] {
  return detail.invocations.map((row) => toInvocationLinkRow(row, nowMs));
}

export function buildTraceRows(
  traces: readonly TraceSummaryRow[],
  nowMs: number,
): TraceRowView[] {
  return traces.map((row) => ({
    traceId: row.traceId,
    traceIdLabel: shortenId(row.traceId),
    invocationId: row.invocationId,
    invocationIdLabel: shortenId(row.invocationId),
    invocationHref: `#/history/invocation/${encodeURIComponent(row.invocationId)}`,
    startedAt: formatRelativeTime(row.startedAt, nowMs),
    startedAtAbsolute: row.startedAt,
    endedAt:
      row.endedAt === null ? RUNNING : formatRelativeTime(row.endedAt, nowMs),
    endedAtAbsolute: row.endedAt ?? "",
    spanCount: row.spanCount,
  }));
}

export function buildSpanRows(
  spans: readonly SpanSummaryRow[],
  nowMs: number,
): SpanRowView[] {
  return spans.map((row) => ({
    spanId: row.spanId,
    spanIdLabel: shortenId(row.spanId),
    parentSpanIdLabel:
      row.parentSpanId === null ? DASH : shortenId(row.parentSpanId),
    traceId: row.traceId,
    traceIdLabel: shortenId(row.traceId),
    spanName: row.spanName,
    kind: row.kind,
    model: row.model ?? DASH,
    inTok: formatTokenCell(row.inTok),
    outTok: formatTokenCell(row.outTok),
    durationMs: formatDurationMs(row.durationMs),
    startedAt: formatRelativeTime(row.startedAt, nowMs),
    startedAtAbsolute: row.startedAt,
  }));
}

export function buildConversationTurnEventRows(
  events: readonly ConversationTurnEventRow[],
  nowMs: number,
): TurnEventRowView[] {
  return events.map((row) => ({
    linkId: row.invocationId,
    linkIdLabel: shortenId(row.invocationId),
    linkHref: `#/history/invocation/${encodeURIComponent(row.invocationId)}`,
    ts: formatRelativeTime(row.ts, nowMs),
    tsAbsolute: row.ts,
    kind: row.kind,
    payloadPreview: truncatePayload(row.payloadJson),
  }));
}
