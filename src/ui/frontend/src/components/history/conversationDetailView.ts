/**
 * Pure view-helpers for the conversation detail page.
 *
 * Side-effect-free projections from the backend `ConversationDetail`
 * shape into row/header types the Solid component renders. Kept apart
 * from the component so the formatting logic — short ids, relative
 * times, payload truncation, duration formatting — can be unit-tested
 * without a Solid runtime or DOM.
 *
 * Nullable backend columns are propagated as `string | null` rather
 * than substituted with placeholder strings; the page chooses whether
 * to render an empty cell, an em-dash, or omit the row entirely.
 *
 * Time-of-day inputs are passed through `nowMs`; the helpers never
 * read the wall clock so tests can pin a deterministic reference.
 */

import {
  extractToolDetail,
  extractToolName,
} from "../../../../../agents/display";
import type {
  ConversationDetail,
  InvocationSummaryRow,
  ModelTokenTotalsRow,
  SpanSummaryRow,
  TraceSummaryRow,
} from "../../../../../history/types";
import { LONG_CONTEXT_THRESHOLD_TOKENS } from "../../../../../history/types";
import {
  formatCompactNumber,
  formatRelativeTime,
  projectDirectoryFromWorktree,
  shortenId,
  splitDirectoryDisplay,
} from "./historyListView";

/** Maximum payload preview length (chars) before the trailing ellipsis. */
const PAYLOAD_PREVIEW_MAX = 80;

/**
 * Proportional split of the four token kinds for the stacked bar shown
 * under the Tokens block. Percentages always sum to 100 (when the bar is
 * defined) or the bar is `null` (sum of all four kinds was zero — caller
 * renders nothing rather than a degenerate empty bar).
 */
export interface TokenBarShape {
  readonly inputPct: number;
  readonly outputPct: number;
  readonly cacheReadPct: number;
  readonly cacheWritePct: number;
}

export interface ConversationHeaderView {
  readonly id: string;
  readonly idLabel: string;
  readonly agent: string | null;
  readonly firstSeen: string;
  readonly firstSeenAbsolute: string;
  readonly lastSeen: string;
  readonly lastSeenAbsolute: string;
  readonly summary: string | null;
  /**
   * Project directory for this conversation, derived from the latest
   * invocation's worktree path with nas's `/.nas/worktree/<name>`
   * suffix stripped. Empty when no invocation supplied a path. Mirrors
   * the list-row treatment so the conversation detail header reads
   * like the list row it was opened from.
   */
  readonly directory: string;
  /** Dim parent half of `directory` (everything up to and including `/`). */
  readonly directoryParent: string;
  /** Bright basename half of `directory`. */
  readonly directoryBase: string;
  readonly turnCount: number;
  readonly spanCount: number;
  readonly invocationCount: number;
}

export interface InvocationLinkRow {
  readonly id: string;
  readonly idLabel: string;
  readonly profile: string | null;
  readonly worktreePath: string | null;
  readonly startedAt: string;
  readonly startedAtAbsolute: string;
  /** Relative-time label for the end timestamp, or null when running. */
  readonly endedAt: string | null;
  readonly endedAtAbsolute: string | null;
  readonly exitReason: string | null;
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
  readonly endedAt: string | null;
  readonly endedAtAbsolute: string | null;
  readonly spanCount: number;
}

export interface SpanRowView {
  readonly spanId: string;
  readonly spanIdLabel: string;
  /** Parent span id (short) or null when the span is a trace root. */
  readonly parentSpanIdLabel: string | null;
  readonly traceId: string;
  readonly traceIdLabel: string;
  readonly spanName: string;
  readonly kind: string;
  /** Short kind label ("chat" / "tool" / "agent") or the raw kind. */
  readonly kindLabel: string;
  /** CSS variant fragment for the kind pill ("is-chat", …) or "". */
  readonly kindClass: string;
  readonly model: string | null;
  /** Compact-formatted token cell, or null for an absent backend value. */
  readonly inTok: string | null;
  readonly outTok: string | null;
  readonly cacheRTok: string | null;
  readonly cacheWTok: string | null;
  /**
   * Joined "in / out" cell string for the merged I/O column. Empty when both
   * raw values are null; otherwise renders each side individually with an
   * em-dash placeholder for the missing side so the slash stays anchored.
   */
  readonly ioCell: string;
  /** Joined "read / write" cell for the merged Cache column. Same rules as `ioCell`. */
  readonly cacheCell: string;
  /** Compact-formatted duration ("234ms", "1.2s", …) or null. */
  readonly durationLabel: string | null;
  readonly startedAt: string;
  readonly startedAtAbsolute: string;
  /**
   * Display tool name for `execute_tool` spans, or null otherwise.
   * Result of `extractToolName(span)`; see that function for the
   * resolution order.
   */
  readonly toolName: string | null;
  /**
   * Trimmed, single-line summary of the tool invocation's input arguments,
   * resolved by `extractToolDetail`. `null` when the span is not an
   * `execute_tool` span or no recognised attribute is present. Used to
   * disambiguate parallel calls of the same tool (e.g. several Agent
   * sub-agents kicked off in one turn). The page renders this with CSS
   * truncation; the same string is used for hover (`title`) and copy.
   */
  readonly toolDetail: string | null;
  /**
   * Pretty-printed attrs JSON for the click-to-expand drawer. When the
   * raw `attrsJson` parses cleanly it is re-serialised with 2-space
   * indent; malformed input is passed through verbatim so the operator
   * never loses information; empty / "{}" inputs collapse to the
   * literal "{}" so the drawer always has something to render.
   */
  readonly attrsPretty: string;
  /**
   * Tree depth (root = 0) within the per-turn span tree. Set by
   * `buildSpanTreeByTurn`; left undefined by the flat `buildSpanRows`
   * projection that the Invocation detail page consumes.
   */
  readonly depth?: number;
}

/**
 * Per-turn group of span rows for the accordion rendering on the
 * conversation detail page. One group per trace, ordered by
 * `compareTurnOrder`; rows inside are DFS-flattened with `depth`
 * populated for indentation. Each accordion header summarises its
 * turn's LLM/tool counts and token totals.
 *
 * Token fields are `null` when every contributing span reports `null`
 * for that token kind, distinguishing "no data emitted" from the
 * legitimate zero of "emitted but counted no tokens". When at least
 * one span carries a numeric value, the others' `null`s contribute
 * nothing to the sum.
 */
export interface TurnSpanGroup {
  readonly traceId: string;
  readonly traceIdLabel: string;
  /** 1-based turn index assigned in `compareTurnOrder` order. */
  readonly turnIndex: number;
  readonly startedAt: string;
  readonly startedAtAbsolute: string;
  /** Compact-formatted duration ("2m11s", …); empty for an open turn. */
  readonly durationLabel: string;
  readonly spanCount: number;
  readonly llmCount: number;
  readonly toolCount: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  /**
   * Pre-formatted token cells, one per kind. Each cell is the
   * `formatCompactNumber` string when the corresponding raw field is a
   * number, or `"-"` (hyphen-minus) when it is `null`, so the header
   * grid distinguishes "no data emitted" from a true zero without the
   * caller re-deriving the placeholder.
   */
  readonly inputTokensCell: string;
  readonly outputTokensCell: string;
  readonly cacheReadTokensCell: string;
  readonly cacheWriteTokensCell: string;
  /** DFS-flattened span rows; each row carries `depth` for indentation. */
  readonly rows: SpanRowView[];
  /**
   * Per-model token totals over the spans of this turn, in the same shape
   * the daemon emits for the conversation-wide breakdown. Order is
   * deterministic — `model ASC` with the `null`-model row last — so the
   * downstream cost projection can sort by the same rule the SQL aggregate
   * uses for the whole conversation. Token=0 rows are retained; filtering
   * is the cost-projection caller's responsibility.
   */
  readonly perModelTotals: ModelTokenTotalsRow[];
}

/**
 * Row shape for the turn-event table on the invocation detail page.
 *
 * `linkId` / `linkIdLabel` / `linkHref` point at the conversation that
 * emitted the event; the invocation is already the page context, so the
 * off-page jump is to the conversation.
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
 * Format a nullable duration into a short, human-readable label.
 *
 *   < 1 s    → "234ms"
 *   < 1 min  → "12.3s"     (one decimal, truncated)
 *   < 1 h    → "1m24s"     (whole minutes + seconds)
 *   >= 1 h   → "1h23m"     (whole hours + minutes)
 *   null     → null        (caller decides empty / dash)
 */
export function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (!Number.isFinite(ms) || ms < 0) return `${ms}ms`;
  if (ms < 1000) return `${Math.trunc(ms)}ms`;
  if (ms < 60_000) {
    const tenths = Math.floor(ms / 100);
    const whole = Math.floor(tenths / 10);
    const frac = tenths % 10;
    return frac === 0 ? `${whole}s` : `${whole}.${frac}s`;
  }
  if (ms < 3_600_000) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s === 0 ? `${m}m` : `${m}m${s}s`;
  }
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/**
 * Format a compact-form integer cell, propagating null verbatim. Reused
 * by span row projections so a 0 stays "0" rather than collapsing to a
 * dash, while a null surfaces back to the caller for empty rendering.
 */
export function formatCountCell(value: number | null): string | null {
  if (value === null) return null;
  if (value === 0) return "0";
  // Use the compact helper for big numbers; small ones already render
  // as bare integers via the same helper.
  return formatCompactCell(value);
}

/**
 * Build the proportional split for the four token kinds. Returns `null`
 * when every kind is zero so the caller can omit the bar entirely rather
 * than render an empty rule.
 */
export function buildTokenBar(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): TokenBarShape | null {
  const total = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (total <= 0) return null;
  return {
    inputPct: (inputTokens / total) * 100,
    outputPct: (outputTokens / total) * 100,
    cacheReadPct: (cacheReadTokens / total) * 100,
    cacheWritePct: (cacheWriteTokens / total) * 100,
  };
}

/**
 * Join a pair of nullable counts into a "left / right" cell. Both null
 * collapses to empty (caller renders no cell content); a single null falls
 * back to an em-dash so the slash stays anchored and the reader can see at a
 * glance which side is missing.
 */
function joinPairCell(a: number | null, b: number | null): string {
  if (a === null && b === null) return "";
  const left = formatCountCell(a) ?? "—";
  const right = formatCountCell(b) ?? "—";
  return `${left} / ${right}`;
}

function formatCompactCell(n: number): string {
  // Local import-free copy of the kilo/mega bucket logic to avoid a
  // circular import at module init. Mirrors `formatCompactNumber`'s
  // truncate-not-round semantics.
  if (n === 0) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${Math.trunc(abs)}`;
  const buckets: Array<{ scale: number; suffix: string }> = [
    { scale: 1_000_000_000, suffix: "G" },
    { scale: 1_000_000, suffix: "M" },
    { scale: 1_000, suffix: "k" },
  ];
  for (const { scale, suffix } of buckets) {
    if (abs >= scale) {
      const tenths = Math.floor((abs / scale) * 10);
      const whole = Math.floor(tenths / 10);
      const frac = tenths % 10;
      const body = frac === 0 ? `${whole}` : `${whole}.${frac}`;
      return `${sign}${body}${suffix}`;
    }
  }
  return `${sign}${Math.trunc(abs)}`;
}

/**
 * Map a raw OTLP span kind / span name to a short display label and a
 * CSS variant class. The classifier looks at both signals so a span
 * named `chat.completion` and one named `tool.invoke` get distinct
 * pills even though their `kind` is the same OTLP `client`.
 */
function classifySpanKind(
  kind: string,
  spanName: string,
): { kindLabel: string; kindClass: string } {
  const k = kind.toLowerCase();
  const n = spanName.toLowerCase();
  if (n.includes("chat") || n.includes("completion")) {
    return { kindLabel: "chat", kindClass: "is-chat" };
  }
  if (n.includes("tool") || k === "internal") {
    return { kindLabel: "tool", kindClass: "is-tool" };
  }
  if (n.includes("agent") || n.includes("subagent")) {
    return { kindLabel: "agent", kindClass: "is-agent" };
  }
  return { kindLabel: kind, kindClass: "" };
}

/** Project an `InvocationSummaryRow` into the conversation-detail link row. */
function toInvocationLinkRow(
  row: InvocationSummaryRow,
  nowMs: number,
): InvocationLinkRow {
  return {
    id: row.id,
    idLabel: shortenId(row.id),
    profile: row.profile,
    worktreePath: row.worktreePath,
    startedAt: formatRelativeTime(row.startedAt, nowMs),
    startedAtAbsolute: row.startedAt,
    endedAt:
      row.endedAt === null ? null : formatRelativeTime(row.endedAt, nowMs),
    endedAtAbsolute: row.endedAt,
    exitReason: row.exitReason,
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
  const directory = projectDirectoryFromWorktree(c.worktreePath);
  const directoryParts = splitDirectoryDisplay(directory);
  return {
    id: c.id,
    idLabel: shortenId(c.id),
    agent: c.agent,
    firstSeen: formatRelativeTime(c.firstSeenAt, nowMs),
    firstSeenAbsolute: c.firstSeenAt,
    lastSeen: formatRelativeTime(c.lastSeenAt, nowMs),
    lastSeenAbsolute: c.lastSeenAt,
    summary: c.summary,
    directory,
    directoryParent: directoryParts.parent,
    directoryBase: directoryParts.base,
    // Match the Turns table on the page: count only turns that
    // survive `buildSpanTreeByTurn`'s zero-token filter so the
    // header total never diverges from the rows below.
    turnCount: buildSpanTreeByTurn(detail, nowMs).length,
    spanCount: c.spanCount,
    invocationCount: c.invocationCount,
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
      row.endedAt === null ? null : formatRelativeTime(row.endedAt, nowMs),
    endedAtAbsolute: row.endedAt,
    spanCount: row.spanCount,
  }));
}

/**
 * Comparator that orders turns deterministically: by `startedAt`
 * ascending, with `traceId` lexicographic ascending as the tie-breaker
 * so two turns sharing a millisecond timestamp still sort stably.
 *
 * Exported so callers that need to walk turns in display order (for
 * example when grouping spans under their parent turn) can reuse the
 * same ordering without re-deriving it.
 */
export function compareTurnOrder(
  a: { readonly startedAt: string; readonly traceId: string },
  b: { readonly startedAt: string; readonly traceId: string },
): number {
  if (a.startedAt < b.startedAt) return -1;
  if (a.startedAt > b.startedAt) return 1;
  if (a.traceId < b.traceId) return -1;
  if (a.traceId > b.traceId) return 1;
  return 0;
}

/**
 * Sum a token column across spans, treating `null` as "no data".
 *
 * Returns `null` when every span reports `null` for the column —
 * "the backend never emitted this token kind" — so the caller can
 * render a hyphen-minus placeholder instead of a misleading `0`.
 * When at least one span carries a numeric value the result is the
 * sum of those numerics, with `null` entries contributing nothing.
 */
function sumNullableColumn(
  spans: readonly SpanSummaryRow[],
  pick: (s: SpanSummaryRow) => number | null,
): number | null {
  let total = 0;
  let sawNumeric = false;
  for (const s of spans) {
    const v = pick(s);
    if (v === null) continue;
    total += v;
    sawNumeric = true;
  }
  return sawNumeric ? total : null;
}

/**
 * Format a single turn-level token total for one cell of the header
 * grid. Numeric values pass through `formatCompactNumber`; `null`
 * collapses to a `"-"` (hyphen-minus) placeholder so the operator can
 * tell "backend never emitted this" apart from a true zero.
 */
function formatTurnTokenCell(n: number | null): string {
  return n === null ? "-" : formatCompactNumber(n);
}

/**
 * Aggregate the spans of a single trace into the counts and token
 * totals shown in the per-turn accordion header. Counts split by
 * `kind` literal (`"chat"` → `llmCount`, `"execute_tool"` →
 * `toolCount`); token totals use `sumNullableColumn` so a column that
 * is `null` on every span surfaces back to the caller as `null`. The
 * four `*TokensCell` strings render each kind as its own grid cell so
 * the header can place them in fixed-width slots aligned across turns.
 */
function summariseTraceSpans(traceSpans: readonly SpanSummaryRow[]): {
  llmCount: number;
  toolCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  inputTokensCell: string;
  outputTokensCell: string;
  cacheReadTokensCell: string;
  cacheWriteTokensCell: string;
} {
  let llmCount = 0;
  let toolCount = 0;
  for (const s of traceSpans) {
    if (s.kind === "chat") llmCount += 1;
    else if (s.kind === "execute_tool") toolCount += 1;
  }
  const inputTokens = sumNullableColumn(traceSpans, (s) => s.inTok);
  const outputTokens = sumNullableColumn(traceSpans, (s) => s.outTok);
  const cacheReadTokens = sumNullableColumn(traceSpans, (s) => s.cacheR);
  const cacheWriteTokens = sumNullableColumn(traceSpans, (s) => s.cacheW);
  return {
    llmCount,
    toolCount,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    inputTokensCell: formatTurnTokenCell(inputTokens),
    outputTokensCell: formatTurnTokenCell(outputTokens),
    cacheReadTokensCell: formatTurnTokenCell(cacheReadTokens),
    cacheWriteTokensCell: formatTurnTokenCell(cacheWriteTokens),
  };
}

/**
 * Aggregate `traceSpans` into per-model token totals, mirroring the daemon's
 * conversation-wide `modelTokenTotals` shape but scoped to one turn.
 *
 * Spans are grouped by their `model` value (with `null` as a distinct key, so
 * model-less spans collapse to a single dedicated row rather than vanishing).
 * Token columns COALESCE `null` to `0` so a span that emitted no number for
 * a kind contributes nothing to that kind's total without forcing the whole
 * row to `null`.
 *
 * Output order matches the SQL aggregate the daemon uses for the whole
 * conversation: `model ASC` lexicographic, with the `null`-model row last.
 * Zero-token rows are retained — filtering belongs to the cost projection
 * downstream so this helper stays free of pricing concerns.
 */
export function summariseTraceSpansByModel(
  traceSpans: ReadonlyArray<SpanSummaryRow>,
): ModelTokenTotalsRow[] {
  const byModel = new Map<string | null, ModelTokenTotalsRow>();
  for (const s of traceSpans) {
    const key = s.model;
    const existing = byModel.get(key);
    const inTok = s.inTok ?? 0;
    const outTok = s.outTok ?? 0;
    const cacheR = s.cacheR ?? 0;
    const cacheW = s.cacheW ?? 0;
    // Anthropic 1M-context billing is all-or-nothing per request: when
    // a single span's effective input crosses 200_000 tokens, every cost
    // field of that span (including the output it generates) maps to the
    // upper-tier rate. We mirror the daemon's SQL bucketing here so the
    // turn-level cost cell agrees with the conversation-level totals.
    const overThreshold =
      inTok + cacheR + cacheW > LONG_CONTEXT_THRESHOLD_TOKENS;
    const inAbove = overThreshold ? inTok : 0;
    const outAbove = overThreshold ? outTok : 0;
    const cacheRAbove = overThreshold ? cacheR : 0;
    const cacheWAbove = overThreshold ? cacheW : 0;
    if (existing === undefined) {
      byModel.set(key, {
        model: key,
        inputTokens: inTok,
        outputTokens: outTok,
        cacheRead: cacheR,
        cacheWrite: cacheW,
        inputTokensAbove200k: inAbove,
        outputTokensAbove200k: outAbove,
        cacheReadAbove200k: cacheRAbove,
        cacheWriteAbove200k: cacheWAbove,
      });
    } else {
      byModel.set(key, {
        model: key,
        inputTokens: existing.inputTokens + inTok,
        outputTokens: existing.outputTokens + outTok,
        cacheRead: existing.cacheRead + cacheR,
        cacheWrite: existing.cacheWrite + cacheW,
        inputTokensAbove200k: existing.inputTokensAbove200k + inAbove,
        outputTokensAbove200k: existing.outputTokensAbove200k + outAbove,
        cacheReadAbove200k: existing.cacheReadAbove200k + cacheRAbove,
        cacheWriteAbove200k: existing.cacheWriteAbove200k + cacheWAbove,
      });
    }
  }
  const rows = Array.from(byModel.values());
  rows.sort((a, b) => {
    if (a.model === null && b.model === null) return 0;
    if (a.model === null) return 1;
    if (b.model === null) return -1;
    if (a.model < b.model) return -1;
    if (a.model > b.model) return 1;
    return 0;
  });
  return rows;
}

/**
 * Format `attrsJson` for the expandable drawer.
 *
 *   ""   / "{}"  → "{}"        (literal so the drawer is never blank)
 *   valid JSON   → re-serialised with 2-space indent
 *   malformed    → original string unchanged (no information lost)
 */
function formatAttrsPretty(attrsJson: string): string {
  if (attrsJson === "" || attrsJson === "{}") return "{}";
  try {
    const parsed = JSON.parse(attrsJson);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return attrsJson;
  }
}

/**
 * Project a single `SpanSummaryRow` into the view-row consumed by both
 * the flat Spans table on the Invocation page and the per-turn
 * accordion tree on the Conversation page. `depth` is left undefined
 * here; the tree builder fills it in for indentation.
 */
function toSpanRowView(row: SpanSummaryRow, nowMs: number): SpanRowView {
  const { kindLabel, kindClass } = classifySpanKind(row.kind, row.spanName);
  return {
    spanId: row.spanId,
    spanIdLabel: shortenId(row.spanId),
    parentSpanIdLabel:
      row.parentSpanId === null ? null : shortenId(row.parentSpanId),
    traceId: row.traceId,
    traceIdLabel: shortenId(row.traceId),
    spanName: row.spanName,
    kind: row.kind,
    kindLabel,
    kindClass,
    model: row.model,
    inTok: formatCountCell(row.inTok),
    outTok: formatCountCell(row.outTok),
    cacheRTok: formatCountCell(row.cacheR),
    cacheWTok: formatCountCell(row.cacheW),
    ioCell: joinPairCell(row.inTok, row.outTok),
    cacheCell: joinPairCell(row.cacheR, row.cacheW),
    durationLabel: formatDuration(row.durationMs),
    startedAt: formatRelativeTime(row.startedAt, nowMs),
    startedAtAbsolute: row.startedAt,
    toolName: extractToolName(row),
    toolDetail: extractToolDetail(row),
    attrsPretty: formatAttrsPretty(row.attrsJson),
  };
}

export function buildSpanRows(
  spans: readonly SpanSummaryRow[],
  nowMs: number,
): SpanRowView[] {
  return spans.map((row) => toSpanRowView(row, nowMs));
}

/**
 * Return `true` for a turn whose four LLM token totals are each either
 * `null` or `0`. Turns whose LLM spans report no token consumption
 * (e.g. aborted requests) are hidden from the conversation detail page
 * so the Turns section is dominated by turns that did real work.
 */
function isZeroTokenTurn(group: TurnSpanGroup): boolean {
  const isZeroOrNull = (n: number | null): boolean => n === null || n === 0;
  return (
    isZeroOrNull(group.inputTokens) &&
    isZeroOrNull(group.outputTokens) &&
    isZeroOrNull(group.cacheReadTokens) &&
    isZeroOrNull(group.cacheWriteTokens)
  );
}

/**
 * Group `detail.spans` by their parent turn (= trace) and DFS-flatten
 * each group so the Conversation detail page can render one
 * accordion per turn with indented child spans.
 *
 * Rules:
 *   - Turns are ordered by `compareTurnOrder`; `turnIndex` is 1-based
 *     in that order, assigned before zero-token filtering so the
 *     surviving rows can show a gap (Turn 1, Turn 2, Turn 4, …) when
 *     a turn has been hidden.
 *   - Within a turn, spans are filtered by `traceId`. A span is a tree
 *     root when `parentSpanId === null` or when its parent is not part
 *     of the same turn (orphans surface as roots so nothing is dropped).
 *   - Siblings at any depth are sorted by `startedAt` ASC.
 *   - DFS pre-order produces the row sequence; each row carries the
 *     `depth` (root = 0) so the page can left-pad the Name cell.
 *   - `durationLabel` uses the trace's wall-clock duration, or "" when
 *     the trace is still open (`endedAt === null`).
 *   - Turns whose four LLM token totals are each `null` or `0` are
 *     dropped from the result (see `isZeroTokenTurn`); the page consumes
 *     only turns with measurable LLM activity.
 */
export function buildSpanTreeByTurn(
  detail: ConversationDetail,
  nowMs: number,
): TurnSpanGroup[] {
  const orderedTraces = detail.traces.slice().sort(compareTurnOrder);
  const groups = orderedTraces.map((trace, idx) => {
    const traceSpans = detail.spans.filter((s) => s.traceId === trace.traceId);
    const ids = new Set(traceSpans.map((s) => s.spanId));
    // Bucket children by parent id; orphans (parent missing from the
    // same turn) and true roots both land in the `roots` array.
    const childrenByParent = new Map<string, SpanSummaryRow[]>();
    const roots: SpanSummaryRow[] = [];
    for (const span of traceSpans) {
      if (span.parentSpanId === null || !ids.has(span.parentSpanId)) {
        roots.push(span);
        continue;
      }
      const arr = childrenByParent.get(span.parentSpanId);
      if (arr === undefined) {
        childrenByParent.set(span.parentSpanId, [span]);
      } else {
        arr.push(span);
      }
    }
    const bySiblingTime = (a: SpanSummaryRow, b: SpanSummaryRow): number => {
      if (a.startedAt < b.startedAt) return -1;
      if (a.startedAt > b.startedAt) return 1;
      if (a.spanId < b.spanId) return -1;
      if (a.spanId > b.spanId) return 1;
      return 0;
    };
    roots.sort(bySiblingTime);
    for (const arr of childrenByParent.values()) arr.sort(bySiblingTime);

    const rows: SpanRowView[] = [];
    const visit = (span: SpanSummaryRow, depth: number): void => {
      rows.push({ ...toSpanRowView(span, nowMs), depth });
      const kids = childrenByParent.get(span.spanId);
      if (kids === undefined) return;
      for (const child of kids) visit(child, depth + 1);
    };
    for (const root of roots) visit(root, 0);

    // Guard against unparseable timestamps; an invalid duration is
    // reported as an open turn.
    const durationMs =
      trace.endedAt === null
        ? null
        : Date.parse(trace.endedAt) - Date.parse(trace.startedAt);
    const durationLabel =
      durationMs === null || !Number.isFinite(durationMs)
        ? ""
        : (formatDuration(durationMs) ?? "");
    const summary = summariseTraceSpans(traceSpans);
    const perModelTotals = summariseTraceSpansByModel(traceSpans);
    return {
      traceId: trace.traceId,
      traceIdLabel: shortenId(trace.traceId),
      turnIndex: idx + 1,
      startedAt: formatRelativeTime(trace.startedAt, nowMs),
      startedAtAbsolute: trace.startedAt,
      durationLabel,
      spanCount: traceSpans.length,
      llmCount: summary.llmCount,
      toolCount: summary.toolCount,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      cacheReadTokens: summary.cacheReadTokens,
      cacheWriteTokens: summary.cacheWriteTokens,
      inputTokensCell: summary.inputTokensCell,
      outputTokensCell: summary.outputTokensCell,
      cacheReadTokensCell: summary.cacheReadTokensCell,
      cacheWriteTokensCell: summary.cacheWriteTokensCell,
      rows,
      perModelTotals,
    };
  });
  return groups.filter((g) => !isZeroTokenTurn(g));
}
