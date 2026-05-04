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
} from "../../../../../history/types";
import { buildTokenBar, type TokenBarShape } from "./conversationDetailView";
import {
  formatCompactNumber,
  formatRelativeTime,
  shortenId,
} from "./historyListView";

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
  /** Number of user turns (one trace == one turn). */
  readonly turnCount: number;
  readonly spanCount: number;
  readonly conversationCount: number;
  readonly tokenTotal: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly tokenBar: TokenBarShape | null;
}

export interface ConversationLinkRow {
  readonly id: string;
  readonly idLabel: string;
  readonly agent: string | null;
  readonly turnCount: number;
  readonly spanCount: number;
  readonly tokenTotal: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** "Input 1.5k · Output 500 · Cache R 100 · Cache W 50" — empty if all zero. */
  readonly tokenBreakdownTitle: string;
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
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const c of detail.conversations) {
    inputTokens += c.inputTokensTotal;
    outputTokens += c.outputTokensTotal;
    cacheReadTokens += c.cacheReadTotal;
    cacheWriteTokens += c.cacheWriteTotal;
  }
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
    turnCount: detail.traces.length,
    spanCount: detail.spans.length,
    conversationCount: detail.conversations.length,
    tokenTotal: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tokenBar: buildTokenBar(
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    ),
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
  const breakdown: string[] = [];
  if (row.inputTokensTotal > 0) {
    breakdown.push(`Input ${formatCompactNumber(row.inputTokensTotal)}`);
  }
  if (row.outputTokensTotal > 0) {
    breakdown.push(`Output ${formatCompactNumber(row.outputTokensTotal)}`);
  }
  if (row.cacheReadTotal > 0) {
    breakdown.push(`Cache R ${formatCompactNumber(row.cacheReadTotal)}`);
  }
  if (row.cacheWriteTotal > 0) {
    breakdown.push(`Cache W ${formatCompactNumber(row.cacheWriteTotal)}`);
  }
  return {
    id: row.id,
    idLabel: shortenId(row.id),
    agent: row.agent,
    turnCount: row.turnCount,
    spanCount: row.spanCount,
    tokenTotal: row.inputTokensTotal + row.outputTokensTotal,
    inputTokens: row.inputTokensTotal,
    outputTokens: row.outputTokensTotal,
    cacheReadTokens: row.cacheReadTotal,
    cacheWriteTokens: row.cacheWriteTotal,
    tokenBreakdownTitle: breakdown.join(" · "),
    // Mirrors the list-page anchor encoding so ids round-trip safely
    // back through `decodeURIComponent` on the consuming side.
    href: `#/history/conversation/${encodeURIComponent(row.id)}`,
  };
}
