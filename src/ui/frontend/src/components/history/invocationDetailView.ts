/**
 * Pure view-helpers for the invocation detail page.
 *
 * The trace, span, and shared-time helpers reuse the conversation
 * detail module's projections — both pages render the same row shapes
 * for those tables. This module only adds the invocation-specific
 * header and the conversation-link list (which can be multi-row when a
 * subagent invocation drives more than one conversation).
 *
 * Nullable backend columns flow through as `string | null` rather than
 * being mapped to placeholder strings; the page layer chooses how to
 * render absence (empty cell, em-dash, omitted row).
 */

import type {
  ConversationListRow,
  InvocationDetail,
  InvocationTurnEventRow,
} from "../../../../../history/types";
import {
  type TurnEventRowView,
  truncatePayload,
} from "./conversationDetailView";
import { formatRelativeTime, shortenId } from "./historyListView";

export interface InvocationHeaderView {
  readonly id: string;
  readonly idLabel: string;
  readonly profile: string | null;
  readonly agent: string | null;
  readonly worktreePath: string | null;
  readonly startedAt: string;
  readonly startedAtAbsolute: string;
  readonly endedAt: string | null;
  readonly endedAtAbsolute: string | null;
  readonly exitReason: string | null;
  readonly turnCount: number;
  readonly traceCount: number;
  readonly spanCount: number;
  readonly conversationCount: number;
  readonly tokenTotal: number;
}

export interface ConversationLinkRow {
  readonly id: string;
  readonly idLabel: string;
  readonly agent: string | null;
  readonly turnCount: number;
  readonly spanCount: number;
  readonly tokenTotal: number;
  readonly href: string;
}

/**
 * Build the invocation header. Aggregate counts are computed from the
 * detail's own arrays so the page does not depend on a redundant
 * `summary` field arriving over the wire.
 */
export function buildInvocationHeader(
  detail: InvocationDetail,
  nowMs: number,
): InvocationHeaderView {
  const inv = detail.invocation;
  const tokenTotal = detail.conversations.reduce(
    (acc, c) => acc + c.inputTokensTotal + c.outputTokensTotal,
    0,
  );
  return {
    id: inv.id,
    idLabel: shortenId(inv.id),
    profile: inv.profile,
    agent: inv.agent,
    worktreePath: inv.worktreePath,
    startedAt: formatRelativeTime(inv.startedAt, nowMs),
    startedAtAbsolute: inv.startedAt,
    endedAt:
      inv.endedAt === null ? null : formatRelativeTime(inv.endedAt, nowMs),
    endedAtAbsolute: inv.endedAt,
    exitReason: inv.exitReason,
    turnCount: detail.turnEvents.length,
    traceCount: detail.traces.length,
    spanCount: detail.spans.length,
    conversationCount: detail.conversations.length,
    tokenTotal,
  };
}

/**
 * Build one row per conversation referenced by the invocation. A
 * subagent-style invocation produces multiple rows here (parent + each
 * subagent conversation share the same invocation id).
 */
export function buildConversationLinks(
  detail: InvocationDetail,
): ConversationLinkRow[] {
  return detail.conversations.map((row) => toConversationLinkRow(row));
}

function toConversationLinkRow(row: ConversationListRow): ConversationLinkRow {
  return {
    id: row.id,
    idLabel: shortenId(row.id),
    agent: row.agent,
    turnCount: row.turnEventCount,
    spanCount: row.spanCount,
    tokenTotal: row.inputTokensTotal + row.outputTokensTotal,
    // Mirrors the list-page anchor encoding so ids round-trip safely
    // back through `decodeURIComponent` on the consuming side.
    href: `#/history/conversation/${encodeURIComponent(row.id)}`,
  };
}

/**
 * Project the invocation-scoped turn events. The shape mirrors the
 * conversation-side rows (same `TurnEventRowView`) but the link target
 * is the conversation, not the invocation, since the invocation is
 * already the page context.
 */
export function buildInvocationTurnEventRows(
  events: readonly InvocationTurnEventRow[],
  nowMs: number,
): TurnEventRowView[] {
  return events.map((row) => {
    const conversationId = row.conversationId;
    return {
      // The link-* fields point at the conversation here: the
      // invocation is already the page context, so the off-page jump
      // is to the conversation that emitted the event.
      linkId: conversationId ?? "",
      linkIdLabel: conversationId === null ? "—" : shortenId(conversationId),
      linkHref:
        conversationId === null
          ? ""
          : `#/history/conversation/${encodeURIComponent(conversationId)}`,
      ts: formatRelativeTime(row.ts, nowMs),
      tsAbsolute: row.ts,
      kind: row.kind,
      payloadPreview: truncatePayload(row.payloadJson),
    };
  });
}
