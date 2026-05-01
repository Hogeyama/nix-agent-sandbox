/**
 * Pure view-helpers for the conversation list page.
 *
 * Kept as side-effect-free functions so the rendering logic can be
 * unit-tested without a Solid runtime or DOM. The component layer
 * (`HistoryListPage.tsx`) is a thin presentation shell over these.
 */

import type { ConversationListRow } from "../../../../../history/types";

/**
 * Reduced row-shape consumed by the list page. Mirrors
 * `ConversationListRow` field-by-field but stays explicit so the
 * page does not silently start depending on backend-only fields.
 */
export interface HistoryListRowDisplay {
  /** Full conversation id (used for the row href). */
  id: string;
  /** Short display id, capped at 8 chars. */
  shortId: string;
  /** Agent label, or `"—"` when null. */
  agent: string;
  /** Relative-time label of `last_seen_at`. */
  relativeTime: string;
  /** Title attribute = full ISO timestamp; useful as a tooltip. */
  fullTimestamp: string;
  /** Aggregate counts, pre-formatted for display. */
  turnCount: number;
  spanCount: number;
  /** Sum of in + out tokens. */
  tokenTotal: number;
  /** Hash href for the row anchor. */
  href: string;
}

const SHORT_ID_LEN = 8;

/**
 * Trim a long id to the first `SHORT_ID_LEN` characters. Short ids are
 * passed through unchanged. The trim is a UI affordance only — the row
 * carries the full id in `href` so the navigation target stays intact.
 */
export function shortenId(id: string): string {
  if (id.length <= SHORT_ID_LEN) return id;
  return id.slice(0, SHORT_ID_LEN);
}

/**
 * Format a timestamp as a short relative-time string ("5s ago", "3m
 * ago", "2h ago", "yesterday", "3d ago"). Falls back to the raw input
 * when the timestamp does not parse, so a malformed row never produces
 * a nonsensical "NaN ago".
 *
 * `nowMs` is injected so tests can pin the reference time.
 */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return "yesterday";
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.round(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  const diffYr = Math.round(diffMo / 12);
  return `${diffYr}y ago`;
}

/**
 * Project a backend conversation row into the shape the page renders.
 * The function is total — every input produces a row, including ones
 * with a null agent (rendered as `"—"`).
 */
export function toHistoryListRowDisplay(
  row: ConversationListRow,
  nowMs: number,
): HistoryListRowDisplay {
  return {
    id: row.id,
    shortId: shortenId(row.id),
    agent: row.agent ?? "—",
    relativeTime: formatRelativeTime(row.lastSeenAt, nowMs),
    fullTimestamp: row.lastSeenAt,
    turnCount: row.turnEventCount,
    spanCount: row.spanCount,
    tokenTotal: row.inputTokensTotal + row.outputTokensTotal,
    // Defensive escape: backend ids flow into the hash unmodified, so a
    // value containing characters the router's safe-id allowlist rejects
    // (or url-reserved characters) would otherwise drop the user back to
    // the workspace fallback. `encodeURIComponent` keeps the link
    // round-trippable through `decodeURIComponent` on the consuming side.
    href: `#/history/conversation/${encodeURIComponent(row.id)}`,
  };
}
