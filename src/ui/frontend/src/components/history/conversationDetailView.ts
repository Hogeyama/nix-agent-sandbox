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

import type {
  ConversationDetail,
  ConversationTurnEventRow,
  InvocationSummaryRow,
  SpanSummaryRow,
  TraceSummaryRow,
} from "../../../../../history/types";
import { formatRelativeTime, shortenId } from "./historyListView";

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
  readonly turnCount: number;
  readonly spanCount: number;
  readonly invocationCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly tokenTotal: number;
  readonly tokenBar: TokenBarShape | null;
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
   * Pretty-printed attrs JSON for the click-to-expand drawer. When the
   * raw `attrsJson` parses cleanly it is re-serialised with 2-space
   * indent; malformed input is passed through verbatim so the operator
   * never loses information; empty / "{}" inputs collapse to the
   * literal "{}" so the drawer always has something to render.
   */
  readonly attrsPretty: string;
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
  return {
    id: c.id,
    idLabel: shortenId(c.id),
    agent: c.agent,
    firstSeen: formatRelativeTime(c.firstSeenAt, nowMs),
    firstSeenAbsolute: c.firstSeenAt,
    lastSeen: formatRelativeTime(c.lastSeenAt, nowMs),
    lastSeenAbsolute: c.lastSeenAt,
    summary: c.summary,
    turnCount: c.turnEventCount,
    spanCount: c.spanCount,
    invocationCount: c.invocationCount,
    inputTokens: c.inputTokensTotal,
    outputTokens: c.outputTokensTotal,
    cacheReadTokens: c.cacheReadTotal,
    cacheWriteTokens: c.cacheWriteTotal,
    tokenTotal: c.inputTokensTotal + c.outputTokensTotal,
    tokenBar: buildTokenBar(
      c.inputTokensTotal,
      c.outputTokensTotal,
      c.cacheReadTotal,
      c.cacheWriteTotal,
    ),
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

export function buildSpanRows(
  spans: readonly SpanSummaryRow[],
  nowMs: number,
): SpanRowView[] {
  return spans.map((row) => {
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
      attrsPretty: formatAttrsPretty(row.attrsJson),
    };
  });
}

/**
 * Extract a display tool name from an `execute_tool` span.
 *
 * Gated on `kind === "execute_tool"` so chat spans that happen to carry a
 * `tool_name`-shaped attribute (e.g. function-calling parameter echoes) do
 * not bleed into the tool column.
 *
 * Resolution order:
 *   1. `attrsJson` parsed object, keyed by `tool_name`,
 *      `gen_ai.tool.name`, `claude_code.tool.name` (first non-empty string wins).
 *   2. `spanName` regex fallbacks for emitters that put the name into the
 *      span name itself: `execute_tool <name>` (Copilot) and
 *      `claude_code.tool.<subtype>` (Claude Code).
 *
 * Returns `null` when no source resolves to a non-empty string, when the
 * span kind is not `execute_tool`, or when `attrsJson` fails to parse
 * (malformed JSON does not crash the caller).
 */
export function extractToolName(span: SpanSummaryRow): string | null {
  if (span.kind !== "execute_tool") return null;
  let attrs: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(span.attrsJson);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      attrs = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  if (attrs !== null) {
    const keys = ["tool_name", "gen_ai.tool.name", "claude_code.tool.name"];
    for (const key of keys) {
      const v = attrs[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  const execMatch = /^execute_tool\s+(.+)$/.exec(span.spanName);
  if (execMatch !== null) return execMatch[1] ?? null;
  const ccMatch = /^claude_code\.tool\.(.+)$/.exec(span.spanName);
  if (ccMatch !== null) return ccMatch[1] ?? null;
  return null;
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
