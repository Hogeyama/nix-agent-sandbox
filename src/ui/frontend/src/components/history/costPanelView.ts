/**
 * Pure view-helpers for the history cost panel.
 *
 * Side-effect-free so the projection logic — model normalisation,
 * USD computation, sort order, and label formatting — can be unit
 * tested without a Solid runtime or DOM. The component layer
 * (`CostPanel.tsx`) is a thin presentation shell over these helpers.
 *
 * Critical contracts pinned by tests:
 *   - Unknown-model rows never contribute to the panel total. A model
 *     whose price lookup fails is rendered with USD columns of `"—"`
 *     and a row total of 0; the panel total sums known rows only.
 *   - Per-field unit prices are independent: a model that lists an
 *     `input_cost_per_token` but no `cache_read_input_token_cost` shows
 *     a numeric input USD and `"—"` for cache read. The row total
 *     includes only the fields that resolved to a number.
 *   - When the snapshot's `source` is `"unavailable"`, every row is
 *     forced into the unknown bucket so the panel total is 0 — the
 *     daemon explicitly signals "no prices to apply".
 */

import type { ModelTokenTotalsRow } from "../../../../../history/types";
import type { FourCosts, PricingSnapshot } from "../../api/client";

/** Result of resolving a raw model string against the snapshot. */
export type NormalizedModel =
  | { kind: "known"; key: string; rates: FourCosts }
  | { kind: "unknown"; raw: string };

/** Per-row projection consumed by the table renderer. */
export type CostRow = {
  /** Display label — the resolved snapshot key, or the raw model string. */
  model: string;
  /** True iff the model could not be resolved against the snapshot. */
  isUnknown: boolean;
  /** The raw backend model string, retained for tooltip / debugging. */
  rawModel: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD computed per field; `undefined` when the unit price is missing. */
  inputUsd?: number;
  outputUsd?: number;
  cacheReadUsd?: number;
  cacheWriteUsd?: number;
  /** Sum of the four `*Usd` fields that resolved to a number. */
  totalUsd: number;
};

/** Top-level projection consumed by the panel renderer. */
export type CostPanelView = {
  rows: CostRow[];
  /** Sum of `totalUsd` across known rows only. */
  totalUsd: number;
  /** True iff at least one row is in the unknown bucket. */
  hasUnknown: boolean;
  source: "litellm" | "unavailable";
  /** Human-readable "X ago" label. */
  fetchedAtRelative: string;
  /** Mirror of the snapshot's `stale` flag, for the badge. */
  stale: boolean;
  /** ISO boundary the daemon used to build `modelTokenTotals`. */
  sinceIso: string;
};

/** Provider prefixes the LiteLLM catalogue uses for namespaced keys. */
const PROVIDER_PREFIXES = [
  "anthropic/",
  "openai/",
  "azure/",
  "bedrock/",
  "vertex_ai/",
];

/**
 * Hand-curated alias map for "-latest" tags and other rolling pointers
 * the agent SDKs emit but that LiteLLM keys as a fixed dated snapshot.
 * Keep small and explicit — this is not a fuzzy-match layer, just a
 * shim over the names callers genuinely send.
 */
const MODEL_ALIASES: Record<string, string> = {
  "claude-3-5-sonnet-latest": "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-latest": "claude-3-5-haiku-20241022",
  "claude-3-opus-latest": "claude-3-opus-20240229",
  "gpt-4o-latest": "gpt-4o",
  "gpt-4-turbo-latest": "gpt-4-turbo",
};

/**
 * Try every fallback rule against `snapshot.models` and return the
 * first hit, including the matched key so the caller can render a
 * stable display label. Returns `null` when nothing resolves.
 */
function resolveAgainstSnapshot(
  raw: string,
  snapshot: PricingSnapshot,
): { key: string; rates: FourCosts } | null {
  // 1. Exact match.
  const exact = snapshot.models[raw];
  if (exact !== undefined) return { key: raw, rates: exact };

  // 2. Provider-prefixed.
  for (const prefix of PROVIDER_PREFIXES) {
    const prefixed = `${prefix}${raw}`;
    const hit = snapshot.models[prefixed];
    if (hit !== undefined) return { key: prefixed, rates: hit };
  }

  return null;
}

/**
 * Normalise `raw` against the snapshot. Walks a fixed sequence of
 * fallbacks — exact, provider-prefixed, bracketed-tag-stripped,
 * version-suffix-stripped, alias — and reports the matched key on
 * success. A null/empty raw is treated as unknown without inspecting
 * the snapshot at all.
 */
export function normalizeModel(
  raw: string | null | undefined,
  snapshot: PricingSnapshot,
): NormalizedModel {
  if (raw === null || raw === undefined || raw === "") {
    return { kind: "unknown", raw: raw ?? "" };
  }

  // 1 + 2: exact / provider-prefixed.
  const direct = resolveAgainstSnapshot(raw, snapshot);
  if (direct !== null) {
    return { kind: "known", key: direct.key, rates: direct.rates };
  }

  // 2.5: drop a trailing bracketed tag (e.g. "[1M]" 1M-context beta).
  // Anthropic publishes the upper-tier price on the same key via
  // `*_above_200k_tokens` rather than as a separate variant key, so
  // the base lookup is the right canonical form.
  const bracketStripped = raw.replace(/\[[^\]]+\]$/, "");
  if (bracketStripped !== raw) {
    const hit = resolveAgainstSnapshot(bracketStripped, snapshot);
    if (hit !== null) {
      return { kind: "known", key: hit.key, rates: hit.rates };
    }
  }

  // 3a: drop a single Bedrock-style `-v\d+:\d+` suffix and retry.
  const bedrockStripped = bracketStripped.replace(/-v\d+:\d+$/, "");
  if (bedrockStripped !== raw) {
    const hit = resolveAgainstSnapshot(bedrockStripped, snapshot);
    if (hit !== null) {
      return { kind: "known", key: hit.key, rates: hit.rates };
    }
  }

  // 3b: peel one trailing `-\d{8,}` (date-style) at a time, retrying
  // exact + provider-prefixed at each step. The loop has a fixed cap
  // (ids that already lost their date suffix have no more digits to
  // strip, terminating the loop) so it cannot run away.
  let candidate = bedrockStripped;
  while (true) {
    const peeled = candidate.replace(/-\d{8,}$/, "");
    if (peeled === candidate) break;
    candidate = peeled;
    const hit = resolveAgainstSnapshot(candidate, snapshot);
    if (hit !== null) {
      return { kind: "known", key: hit.key, rates: hit.rates };
    }
  }

  // 4: alias map. Looked up against the original raw, not the peeled
  // candidate — aliases target the names callers actually send.
  const aliased = MODEL_ALIASES[raw];
  if (aliased !== undefined) {
    const hit = resolveAgainstSnapshot(aliased, snapshot);
    if (hit !== null) {
      return { kind: "known", key: hit.key, rates: hit.rates };
    }
  }

  return { kind: "unknown", raw };
}

/**
 * Apply Anthropic's two-tier 1M-context pricing to a single token-cost
 * field. The aggregator splits a column into a base bucket
 * (= total - above) plus an above-200k bucket; this function multiplies
 * each bucket by its own rate and sums.
 *
 * Falls back gracefully when a model lacks the upper-tier rate: the
 * above bucket reuses the base rate, so non-1M-context models stay
 * priced at a single tier with no behaviour change. When the base rate
 * itself is absent the field returns `undefined` so the cell renders as
 * "—" — it never silently zeroes out.
 */
function maybeUsdTiered(
  totalTokens: number,
  aboveTokens: number,
  baseRate: number | undefined,
  aboveRate: number | undefined,
): number | undefined {
  if (baseRate === undefined) return undefined;
  const baseTokens = totalTokens - aboveTokens;
  const effectiveAboveRate = aboveRate ?? baseRate;
  return baseTokens * baseRate + aboveTokens * effectiveAboveRate;
}

/**
 * Project per-model token totals into `CostRow[]` against `snapshot`.
 * Shared between the list-page panel and the conversation-detail band;
 * neither caller drops zero-token rows here, so a downstream consumer
 * that wants that filter (only the conversation band does) applies it
 * after the projection.
 *
 * The "unavailable" sentinel forces every row into the unknown bucket
 * regardless of what `snapshot.models` happens to contain. This keeps
 * the silent-miscount invariant trivial: when the daemon has no prices
 * to apply, the row total is 0 even if a stale `models` payload were
 * attached to the sentinel.
 */
function projectCostRows(
  totals: ReadonlyArray<ModelTokenTotalsRow>,
  snapshot: PricingSnapshot,
): CostRow[] {
  const forceUnknown = snapshot.source === "unavailable";

  return totals.map((row) => {
    const rawLabel = row.model ?? "";
    const normalized = forceUnknown
      ? ({ kind: "unknown", raw: rawLabel } as NormalizedModel)
      : normalizeModel(row.model, snapshot);

    if (normalized.kind === "unknown") {
      return {
        model: rawLabel === "" ? "(unknown)" : rawLabel,
        isUnknown: true,
        rawModel: rawLabel,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        totalUsd: 0,
      };
    }

    const rates = normalized.rates;
    const inputUsd = maybeUsdTiered(
      row.inputTokens,
      row.inputTokensAbove200k,
      rates.input_cost_per_token,
      rates.input_cost_per_token_above_200k_tokens,
    );
    const outputUsd = maybeUsdTiered(
      row.outputTokens,
      row.outputTokensAbove200k,
      rates.output_cost_per_token,
      rates.output_cost_per_token_above_200k_tokens,
    );
    const cacheReadUsd = maybeUsdTiered(
      row.cacheRead,
      row.cacheReadAbove200k,
      rates.cache_read_input_token_cost,
      rates.cache_read_input_token_cost_above_200k_tokens,
    );
    const cacheWriteUsd = maybeUsdTiered(
      row.cacheWrite,
      row.cacheWriteAbove200k,
      rates.cache_creation_input_token_cost,
      rates.cache_creation_input_token_cost_above_200k_tokens,
    );

    let totalUsd = 0;
    if (inputUsd !== undefined) totalUsd += inputUsd;
    if (outputUsd !== undefined) totalUsd += outputUsd;
    if (cacheReadUsd !== undefined) totalUsd += cacheReadUsd;
    if (cacheWriteUsd !== undefined) totalUsd += cacheWriteUsd;

    return {
      model: normalized.key,
      isUnknown: false,
      rawModel: rawLabel,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      inputUsd,
      outputUsd,
      cacheReadUsd,
      cacheWriteUsd,
      totalUsd,
    };
  });
}

/**
 * Sort `rows` in place: known rows first by descending USD, then
 * unknown rows at the tail in ascending raw-model order. The two-section
 * layout keeps the unknown bucket visible without letting it interleave
 * with priced rows where a sort by USD would put it first (USD = 0).
 */
function sortCostRows(rows: CostRow[]): void {
  rows.sort((a, b) => {
    if (a.isUnknown !== b.isUnknown) return a.isUnknown ? 1 : -1;
    if (a.isUnknown && b.isUnknown) {
      return a.rawModel < b.rawModel ? -1 : a.rawModel > b.rawModel ? 1 : 0;
    }
    return b.totalUsd - a.totalUsd;
  });
}

/**
 * Compute the cost-panel projection. Pure: every input — totals, the
 * snapshot, the daemon's "since" boundary, and a clock — flows in
 * explicitly so the function can be tested deterministically.
 */
export function computeCostPanel(
  totals: ReadonlyArray<ModelTokenTotalsRow>,
  snapshot: PricingSnapshot,
  sinceIso: string,
  nowMs: number,
): CostPanelView {
  const rows = projectCostRows(totals, snapshot);
  sortCostRows(rows);

  const totalUsd = rows
    .filter((r) => !r.isUnknown)
    .reduce((acc, r) => acc + r.totalUsd, 0);
  const hasUnknown = rows.some((r) => r.isUnknown);

  return {
    rows,
    totalUsd,
    hasUnknown,
    source: snapshot.source,
    fetchedAtRelative: formatRelativeFetched(
      snapshot.fetched_at,
      nowMs,
      snapshot.source,
    ),
    stale: snapshot.stale,
    sinceIso,
  };
}

/** Display mode for the conversation-detail cost band. */
export type ConversationCostMode = "single" | "multi" | "empty";

/** Single-mode payload — populated only when `mode === "single"`. */
export interface ConversationCostSingle {
  /** Resolved snapshot key, or the raw model string for unknown rows. */
  model: string;
  /** Backend-supplied raw model string (kept for tooltips). */
  rawModel: string;
  isUnknown: boolean;
  row: CostRow;
}

/** Top-level projection consumed by the conversation cost band. */
export interface ConversationCostView {
  mode: ConversationCostMode;
  /** `CostRow[]` after token=0 drop, sorted (known desc, unknown tail). */
  rows: CostRow[];
  /** Sum of `totalUsd` across known rows only. */
  totalUsd: number;
  hasUnknown: boolean;
  source: "litellm" | "unavailable";
  fetchedAtRelative: string;
  stale: boolean;
  /** Populated iff `mode === "single"`. */
  single?: ConversationCostSingle;
}

/**
 * True iff every token field on `row` is exactly zero. Conversations
 * surface a single per-model band; rows with no tokens at all add no
 * information and are dropped before sorting.
 */
function isZeroTokenRow(row: CostRow): boolean {
  return (
    row.inputTokens === 0 &&
    row.outputTokens === 0 &&
    row.cacheRead === 0 &&
    row.cacheWrite === 0
  );
}

/**
 * Compute the conversation-detail cost band projection. Shares the
 * row-projection and sort helpers with `computeCostPanel` so the two
 * views stay consistent on rate lookup, unknown handling, and ordering.
 *
 * Differs from the list panel in two ways:
 *   - Token=0 rows are dropped (a conversation that never used a model
 *     gets no row, rather than a "0 tok / —" placeholder).
 *   - The `mode` flag tells the renderer whether to draw a single-row
 *     stat strip, a per-model table, or nothing at all.
 */
export function computeConversationCost(
  perModel: ReadonlyArray<ModelTokenTotalsRow>,
  snapshot: PricingSnapshot,
  nowMs: number,
): ConversationCostView {
  const projected = projectCostRows(perModel, snapshot);
  const rows = projected.filter((r) => !isZeroTokenRow(r));
  sortCostRows(rows);

  const totalUsd = rows
    .filter((r) => !r.isUnknown)
    .reduce((acc, r) => acc + r.totalUsd, 0);
  const hasUnknown = rows.some((r) => r.isUnknown);

  let mode: ConversationCostMode;
  let single: ConversationCostSingle | undefined;
  if (rows.length === 0) {
    mode = "empty";
  } else if (rows.length === 1 && rows[0]?.isUnknown === false) {
    const only = rows[0];
    if (only !== undefined) {
      mode = "single";
      single = {
        model: only.model,
        rawModel: only.rawModel,
        isUnknown: only.isUnknown,
        row: only,
      };
    } else {
      mode = "multi";
    }
  } else {
    mode = "multi";
  }

  return {
    mode,
    rows,
    totalUsd,
    hasUnknown,
    source: snapshot.source,
    fetchedAtRelative: formatRelativeFetched(
      snapshot.fetched_at,
      nowMs,
      snapshot.source,
    ),
    stale: snapshot.stale,
    single,
  };
}

/**
 * Compute the per-turn cost summary used by the conversation-detail Turns
 * table. Shares row projection (`projectCostRows`) and ordering
 * (`sortCostRows`) with the panel and the conversation-band views so all
 * three surfaces resolve models, USD fields, and unknown handling the same
 * way; the only difference is the input scope (one turn's per-model totals
 * rather than a whole conversation or list window).
 *
 * `isUnknownOnly` collapses three "no priced data" states the renderer
 * treats identically:
 *   - `snapshot.source === "unavailable"` — daemon explicitly has no prices.
 *   - all input rows had token=0 across every kind — turn did no measurable
 *     work, so `projectCostRows` produces no surviving rows.
 *   - every surviving row resolved to the unknown bucket — known prices
 *     applied to zero models, so the total is 0 with nothing to attribute.
 * The cell renderer turns `isUnknownOnly` into the em-dash placeholder so
 * the Cost column never shows `$0.00` for "we have no priced data".
 *
 * Token=0 rows are dropped after projection (mirrors `computeConversationCost`),
 * so an unused model on this turn does not add a 0-USD row to the breakdown.
 */
export function computeTurnCost(
  perModel: ReadonlyArray<ModelTokenTotalsRow>,
  snapshot: PricingSnapshot,
): {
  totalUsd: number;
  isUnknownOnly: boolean;
  rows: CostRow[];
} {
  const projected = projectCostRows(perModel, snapshot);
  const rows = projected.filter((r) => !isZeroTokenRow(r));
  sortCostRows(rows);

  const totalUsd = rows
    .filter((r) => !r.isUnknown)
    .reduce((acc, r) => acc + r.totalUsd, 0);

  const knownCount = rows.filter((r) => !r.isUnknown).length;
  const isUnknownOnly =
    snapshot.source === "unavailable" || rows.length === 0 || knownCount === 0;

  return { totalUsd, isUnknownOnly, rows };
}

/**
 * Render the snapshot's `fetched_at` as a coarse relative-time label.
 * The bucket boundaries match the conversation list's relative-time
 * helper (under a minute, then minutes / hours / days) so the two
 * displays read consistently. `unavailable` collapses to a single
 * em-dash because there is no meaningful timestamp to report.
 */
export function formatRelativeFetched(
  fetchedAtIso: string,
  nowMs: number,
  source: "litellm" | "unavailable",
): string {
  if (source === "unavailable") return "—";

  const ts = Date.parse(fetchedAtIso);
  if (Number.isNaN(ts)) return fetchedAtIso;

  const diffMs = Math.max(0, nowMs - ts);
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  // Round-trip the ISO timestamp through Date so a value with a non-Z
  // offset still produces the calendar date that the browser would
  // display.
  return `on ${new Date(ts).toISOString().slice(0, 10)}`;
}

/**
 * Render a non-negative integer as a short-form, k/M suffixed label.
 * Mirrors the conversation-list helper at a smaller scope — only the
 * three buckets the cost panel needs (`>=1e6`, `>=1e3`, raw) — so the
 * cost cells read consistently with the rest of the history surface.
 *
 * Values below 1000 are rendered as bare integers; non-finite values
 * fall through to the raw string so a malformed total never produces
 * a nonsensical label.
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) {
    const tenths = Math.floor((abs / 1_000_000) * 10);
    const whole = Math.floor(tenths / 10);
    const frac = tenths % 10;
    const body = frac === 0 ? `${whole}` : `${whole}.${frac}`;
    return `${sign}${body}M`;
  }
  if (abs >= 1_000) {
    const tenths = Math.floor((abs / 1_000) * 10);
    const whole = Math.floor(tenths / 10);
    const frac = tenths % 10;
    const body = frac === 0 ? `${whole}` : `${whole}.${frac}`;
    return `${sign}${body}k`;
  }
  return `${sign}${Math.trunc(abs)}`;
}

/**
 * Render a USD value for a cost cell. The "—" sentinel surfaces when
 * the unit price was missing, distinguishing "we have no price for this
 * field" from a genuine $0.00. The `<$0.01` band keeps very-small
 * non-zero values legible at two-decimal precision without rounding
 * them to zero.
 */
export function formatUsd(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value === 0) return "$0.00";
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}
