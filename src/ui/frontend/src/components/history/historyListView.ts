/**
 * Pure view-helpers for the conversation list page.
 *
 * Kept as side-effect-free functions so the rendering logic can be
 * unit-tested without a Solid runtime or DOM. The component layer
 * (`HistoryListPage.tsx`) is a thin presentation shell over these.
 */

import { bareAgentLabel, classifyAgent } from "../../../../../agents/display";
import type { ConversationListRow } from "../../../../../history/types";

/**
 * Reduced row-shape consumed by the list page. `summary` is the row's
 * primary label (with `idShort` substituted when the backend has no
 * captured summary yet). `metaLine` carries the secondary line — the
 * id (when summary is present), turn / span counts, and token total.
 */
export interface ConversationListRowView {
  /** Full conversation id (used for the row href). */
  readonly id: string;
  /** Short display id, capped at 8 chars. */
  readonly idShort: string;
  /** Raw agent label, or null when the backend reported none. */
  readonly agent: string | null;
  /** Bare display agent ("claude" / "copilot" / "codex" / ""). */
  readonly agentLabel: string;
  /** CSS class fragment for the agent pill ("is-claude", …) or "". */
  readonly agentClass: string;
  /** Primary row text — summary, falling back to idShort. */
  readonly summary: string;
  /** True iff `summary` is the idShort fallback (= no captured summary). */
  readonly summaryIsEmpty: boolean;
  /** Composed secondary line ("sess_aab · 3 turns · 12 spans · 1.2k tok"). */
  readonly metaLine: string;
  /** Relative-time label of `last_seen_at`. */
  readonly lastSeen: string;
  /** Title attribute = full ISO timestamp; useful as a tooltip. */
  readonly fullTimestamp: string;
  /**
   * Project directory shown alongside the row. Derived from the latest
   * invocation's worktree path by stripping the `/.nas/worktree/<name>`
   * suffix nas appends. Empty when no invocation supplied a path.
   */
  readonly directory: string;
  /**
   * Parent path of `directory` (everything up to and including the final
   * `/`). Rendered dim so the basename can take visual focus. Empty when
   * `directory` has no separator (e.g. a bare repo name).
   */
  readonly directoryParent: string;
  /**
   * Basename of `directory` — the project's own folder name. This is the
   * focal token of the path; rendered bright while the parent fades.
   */
  readonly directoryBase: string;
  /** Token total formatted with the compact-number helper ("1.2k"). */
  readonly tokenTotal: string;
  /**
   * Human-readable per-kind breakdown ("Input 1.5k · Output 500 · Cache R 100
   * · Cache W 50"), suitable as a `title` tooltip. Empty when every kind is 0.
   */
  readonly tokenBreakdownTitle: string;
  /** Hash href for the row anchor. */
  readonly href: string;
}

const SHORT_ID_LEN = 8;

/**
 * Strip nas's `/.nas/worktree/<name>` suffix to recover the project
 * directory the user actually invoked nas from. The trailing `<name>`
 * segment is optional so a worktree path that bottoms out at
 * `/.nas/worktree` (e.g. an unfinished setup) still collapses to the
 * project root. Paths without the marker pass through unchanged.
 */
export function projectDirectoryFromWorktree(
  worktreePath: string | null,
): string {
  if (worktreePath === null) return "";
  const match = worktreePath.match(/^(.*?)\/\.nas\/worktree(?:\/[^/]*)?\/?$/);
  if (match !== null && match[1] !== undefined) return match[1];
  return worktreePath;
}

/**
 * Split a project directory into a dim parent + bright basename so the
 * row can render the project's own folder name as the visual anchor.
 *
 * - `/home/me/proj` → `{ parent: "/home/me/", base: "proj" }`
 * - `/proj` → `{ parent: "/", base: "proj" }`
 * - `proj` → `{ parent: "", base: "proj" }`
 * - `""` → `{ parent: "", base: "" }`
 * The parent retains its trailing slash so the two halves concatenate
 * back to the original input.
 */
export function splitDirectoryDisplay(directory: string): {
  parent: string;
  base: string;
} {
  if (directory === "") return { parent: "", base: "" };
  const lastSlash = directory.lastIndexOf("/");
  if (lastSlash === -1) return { parent: "", base: directory };
  return {
    parent: directory.slice(0, lastSlash + 1),
    base: directory.slice(lastSlash + 1),
  };
}

/** U+00B7 mid-dot used as the meta-line segment separator. */
const SEP = " · ";

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
 * Render a non-negative integer as a short-form, k/M/G suffixed string
 * with at most one decimal digit. Trailing-zero decimals collapse so
 * `1000` formats as `"1k"` rather than `"1.0k"`. Truncates (does not
 * round) so a near-boundary value stays in its own bucket — `1499`
 * formats as `"1.4k"`, not `"1.5k"`.
 *
 * Negative values flip sign on the suffix output (`"-1.2k"`); zero stays
 * `"0"` to match the bare-integer rendering used for small values.
 */
export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
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
      // truncate to one decimal: floor(abs / scale * 10) / 10
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
 * Compose the secondary meta line. When `includeId` is true the short
 * id is prepended; the page passes `false` when summary is the id
 * fallback (so the same id does not appear on both lines). Numeric
 * segments with a value of 0 are dropped — an empty conversation reads
 * as "sess_aab" rather than "sess_aab · 0 turns · 0 spans · 0 tok".
 */
function composeMetaLine(opts: {
  idShort: string;
  includeId: boolean;
  turns: number;
  spans: number;
  tokenTotal: number;
}): string {
  const parts: string[] = [];
  if (opts.includeId) parts.push(opts.idShort);
  if (opts.turns > 0) {
    parts.push(`${opts.turns} ${opts.turns === 1 ? "turn" : "turns"}`);
  }
  if (opts.spans > 0) {
    parts.push(`${opts.spans} ${opts.spans === 1 ? "span" : "spans"}`);
  }
  if (opts.tokenTotal > 0) {
    parts.push(`${formatCompactNumber(opts.tokenTotal)} tok`);
  }
  return parts.join(SEP);
}

/**
 * Build the per-kind token breakdown shown in the row's tooltip. Each
 * non-zero kind contributes one segment; an all-zero row returns an empty
 * string so the caller can omit the `title` attribute entirely.
 */
function composeTokenBreakdownTitle(row: ConversationListRow): string {
  const parts: string[] = [];
  if (row.inputTokensTotal > 0) {
    parts.push(`Input ${formatCompactNumber(row.inputTokensTotal)}`);
  }
  if (row.outputTokensTotal > 0) {
    parts.push(`Output ${formatCompactNumber(row.outputTokensTotal)}`);
  }
  if (row.cacheReadTotal > 0) {
    parts.push(`Cache R ${formatCompactNumber(row.cacheReadTotal)}`);
  }
  if (row.cacheWriteTotal > 0) {
    parts.push(`Cache W ${formatCompactNumber(row.cacheWriteTotal)}`);
  }
  return parts.join(" · ");
}

/**
 * Project a backend conversation row into the shape the page renders.
 * The function is total — every input produces a row, including ones
 * with a null agent or absent summary.
 */
export function toConversationListRowView(
  row: ConversationListRow,
  nowMs: number,
): ConversationListRowView {
  const idShort = shortenId(row.id);
  const tokenTotal = row.inputTokensTotal + row.outputTokensTotal;
  const tokenBreakdownTitle = composeTokenBreakdownTitle(row);
  const summary = row.summary;
  const summaryIsEmpty = summary === null;
  const directory = projectDirectoryFromWorktree(row.worktreePath);
  const directoryParts = splitDirectoryDisplay(directory);
  return {
    id: row.id,
    idShort,
    agent: row.agent,
    agentLabel: bareAgentLabel(row.agent),
    agentClass: classifyAgent(row.agent),
    summary: summary ?? idShort,
    summaryIsEmpty,
    metaLine: composeMetaLine({
      idShort,
      // When summary stands in for the id (no backend summary), the id
      // is already the row's primary text — re-emitting it on the meta
      // line would just duplicate.
      includeId: !summaryIsEmpty,
      turns: row.turnEventCount,
      spans: row.spanCount,
      tokenTotal,
    }),
    lastSeen: formatRelativeTime(row.lastSeenAt, nowMs),
    fullTimestamp: row.lastSeenAt,
    directory: directory,
    directoryParent: directoryParts.parent,
    directoryBase: directoryParts.base,
    tokenTotal: formatCompactNumber(tokenTotal),
    tokenBreakdownTitle,
    // Defensive escape: backend ids flow into the hash unmodified, so a
    // value containing characters the router's safe-id allowlist rejects
    // (or url-reserved characters) would otherwise drop the user back to
    // the workspace fallback. `encodeURIComponent` keeps the link
    // round-trippable through `decodeURIComponent` on the consuming side.
    href: `#/history/conversation/${encodeURIComponent(row.id)}`,
  };
}
