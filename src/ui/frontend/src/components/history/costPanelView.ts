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
  source: "litellm" | "bundled" | "unavailable";
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
 * fallbacks — exact, provider-prefixed, version-suffix-stripped,
 * alias — and reports the matched key on success. A null/empty raw
 * is treated as unknown without inspecting the snapshot at all.
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

  // 3a: drop a single Bedrock-style `-v\d+:\d+` suffix and retry.
  const bedrockStripped = raw.replace(/-v\d+:\d+$/, "");
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
 * Multiply token count by unit price, returning `undefined` when the
 * unit price is absent. Keeping the per-field optionality through to
 * the row preserves the "—" rendering for fields LiteLLM does not
 * publish for a given model.
 */
function maybeUsd(
  tokens: number,
  rate: number | undefined,
): number | undefined {
  if (rate === undefined) return undefined;
  return tokens * rate;
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
  // The "unavailable" sentinel forces every row into the unknown
  // bucket regardless of what `models` happens to contain. This keeps
  // the silent-miscount invariant trivial: when the daemon has no
  // prices to apply, the panel total is 0 even if a stale `models`
  // payload were attached to the sentinel.
  const forceUnknown = snapshot.source === "unavailable";

  const rows: CostRow[] = totals.map((row) => {
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
    const inputUsd = maybeUsd(row.inputTokens, rates.input_cost_per_token);
    const outputUsd = maybeUsd(row.outputTokens, rates.output_cost_per_token);
    const cacheReadUsd = maybeUsd(
      row.cacheRead,
      rates.cache_read_input_token_cost,
    );
    const cacheWriteUsd = maybeUsd(
      row.cacheWrite,
      rates.cache_creation_input_token_cost,
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

  // Sort: known rows first by descending USD, then unknown rows at the
  // tail in ascending raw-model order. The two-section layout makes
  // the unknown bucket visible without letting it interleave with
  // priced rows where a sort by USD would put it first (USD = 0).
  rows.sort((a, b) => {
    if (a.isUnknown !== b.isUnknown) return a.isUnknown ? 1 : -1;
    if (a.isUnknown && b.isUnknown) {
      return a.rawModel < b.rawModel ? -1 : a.rawModel > b.rawModel ? 1 : 0;
    }
    return b.totalUsd - a.totalUsd;
  });

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

/**
 * Render the snapshot's `fetched_at` as a coarse relative-time label.
 * The bucket boundaries match the conversation list's relative-time
 * helper (under a minute, then minutes / hours / days) so the two
 * displays read consistently. A `bundled` source carries the
 * "bundled — " prefix to flag that the price catalogue ships with the
 * binary rather than coming from a fresh fetch; `unavailable` collapses
 * to a single em-dash because there is no meaningful timestamp to
 * report.
 */
export function formatRelativeFetched(
  fetchedAtIso: string,
  nowMs: number,
  source: "litellm" | "bundled" | "unavailable",
): string {
  if (source === "unavailable") return "—";

  const ts = Date.parse(fetchedAtIso);
  let body: string;
  if (Number.isNaN(ts)) {
    body = fetchedAtIso;
  } else {
    const diffMs = Math.max(0, nowMs - ts);
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) {
      body = "just now";
    } else if (diffMin < 60) {
      body = `${diffMin}m ago`;
    } else {
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) {
        body = `${diffHr}h ago`;
      } else {
        const diffDay = Math.floor(diffHr / 24);
        if (diffDay < 30) {
          body = `${diffDay}d ago`;
        } else {
          // Round-trip the ISO timestamp through Date so a value with
          // a non-Z offset still produces the calendar date that the
          // browser would display.
          body = `on ${new Date(ts).toISOString().slice(0, 10)}`;
        }
      }
    }
  }

  return source === "bundled" ? `bundled — ${body}` : body;
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
