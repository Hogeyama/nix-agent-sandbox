import { describe, expect, test } from "bun:test";
import type { ModelTokenTotalsRow } from "../../../../../history/types";
import type { PricingSnapshot } from "../../api/client";
import {
  computeCostPanel,
  formatRelativeFetched,
  formatTokenCount,
  formatUsd,
  normalizeModel,
} from "./costPanelView";

function snapshot(
  models: PricingSnapshot["models"],
  overrides: Partial<PricingSnapshot> = {},
): PricingSnapshot {
  return {
    fetched_at: "2026-05-02T12:00:00.000Z",
    source: "litellm",
    stale: false,
    models,
    ...overrides,
  };
}

describe("normalizeModel", () => {
  test("exact key match returns the literal key", () => {
    const snap = snapshot({ "claude-3-5-sonnet": { input_cost_per_token: 1 } });
    const r = normalizeModel("claude-3-5-sonnet", snap);
    expect(r.kind).toBe("known");
    if (r.kind === "known") {
      expect(r.key).toBe("claude-3-5-sonnet");
      expect(r.rates.input_cost_per_token).toBe(1);
    }
  });

  test("provider prefix match returns the prefixed key", () => {
    const snap = snapshot({
      "anthropic/claude-3-5-sonnet": { input_cost_per_token: 2 },
    });
    const r = normalizeModel("claude-3-5-sonnet", snap);
    expect(r.kind).toBe("known");
    if (r.kind === "known") {
      expect(r.key).toBe("anthropic/claude-3-5-sonnet");
    }
  });

  test("strips a trailing -v\\d+:\\d+ Bedrock-style suffix", () => {
    const snap = snapshot({
      "anthropic.claude-3-haiku": { input_cost_per_token: 3 },
    });
    const r = normalizeModel("anthropic.claude-3-haiku-v1:0", snap);
    expect(r.kind).toBe("known");
    if (r.kind === "known") {
      expect(r.key).toBe("anthropic.claude-3-haiku");
    }
  });

  test("peels a trailing -YYYYMMDD date suffix and matches", () => {
    const snap = snapshot({
      "claude-3-5-sonnet": { input_cost_per_token: 4 },
    });
    const r = normalizeModel("claude-3-5-sonnet-20241022", snap);
    expect(r.kind).toBe("known");
    if (r.kind === "known") {
      expect(r.key).toBe("claude-3-5-sonnet");
    }
  });

  test("alias map maps -latest tags to dated catalogue entries", () => {
    const snap = snapshot({
      "claude-3-5-sonnet-20241022": { input_cost_per_token: 5 },
    });
    const r = normalizeModel("claude-3-5-sonnet-latest", snap);
    expect(r.kind).toBe("known");
    if (r.kind === "known") {
      expect(r.key).toBe("claude-3-5-sonnet-20241022");
    }
  });

  test("unrecognised model falls through to the unknown bucket", () => {
    const snap = snapshot({});
    const r = normalizeModel("totally-made-up-model", snap);
    expect(r.kind).toBe("unknown");
    if (r.kind === "unknown") {
      expect(r.raw).toBe("totally-made-up-model");
    }
  });

  test("null / undefined / empty raw are treated as unknown without snapshot lookup", () => {
    const snap = snapshot({ "": { input_cost_per_token: 9 } });
    expect(normalizeModel(null, snap).kind).toBe("unknown");
    expect(normalizeModel(undefined, snap).kind).toBe("unknown");
    expect(normalizeModel("", snap).kind).toBe("unknown");
  });
});

const SINCE = "2026-04-02T00:00:00.000Z";
const NOW = Date.parse("2026-05-02T12:30:00.000Z");

function totals(
  rows: Array<Partial<ModelTokenTotalsRow>>,
): ModelTokenTotalsRow[] {
  return rows.map((r) => ({
    model: r.model ?? null,
    inputTokens: r.inputTokens ?? 0,
    outputTokens: r.outputTokens ?? 0,
    cacheRead: r.cacheRead ?? 0,
    cacheWrite: r.cacheWrite ?? 0,
  }));
}

describe("computeCostPanel", () => {
  test("known row with all four unit prices computes per-field USD and totals them", () => {
    const snap = snapshot({
      "claude-3-5-sonnet": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_creation_input_token_cost: 0.00000375,
        cache_read_input_token_cost: 0.0000003,
      },
    });
    const view = computeCostPanel(
      totals([
        {
          model: "claude-3-5-sonnet",
          inputTokens: 1_000_000,
          outputTokens: 200_000,
          cacheRead: 500_000,
          cacheWrite: 100_000,
        },
      ]),
      snap,
      SINCE,
      NOW,
    );
    expect(view.rows.length).toBe(1);
    const row = view.rows[0];
    expect(row?.isUnknown).toBe(false);
    expect(row?.inputUsd).toBeCloseTo(3, 6);
    expect(row?.outputUsd).toBeCloseTo(3, 6);
    expect(row?.cacheReadUsd).toBeCloseTo(0.15, 6);
    expect(row?.cacheWriteUsd).toBeCloseTo(0.375, 6);
    expect(row?.totalUsd).toBeCloseTo(3 + 3 + 0.15 + 0.375, 6);
    expect(view.totalUsd).toBeCloseTo(row!.totalUsd, 6);
    expect(view.hasUnknown).toBe(false);
    expect(view.sinceIso).toBe(SINCE);
  });

  test("missing cache unit price leaves cacheReadUsd undefined and excludes it from the row total", () => {
    const snap = snapshot({
      "claude-3-5-sonnet": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        // cache_read_input_token_cost intentionally absent
      },
    });
    const view = computeCostPanel(
      totals([
        {
          model: "claude-3-5-sonnet",
          inputTokens: 1_000_000,
          outputTokens: 200_000,
          cacheRead: 500_000,
        },
      ]),
      snap,
      SINCE,
      NOW,
    );
    const row = view.rows[0];
    expect(row?.cacheReadUsd).toBeUndefined();
    expect(row?.cacheWriteUsd).toBeUndefined();
    expect(row?.inputUsd).toBeCloseTo(3, 6);
    expect(row?.outputUsd).toBeCloseTo(3, 6);
    // Row total includes only the two fields that resolved.
    expect(row?.totalUsd).toBeCloseTo(6, 6);
  });

  test("unknown rows never contribute to the panel total even when token counts are huge", () => {
    const snap = snapshot({
      known: { input_cost_per_token: 0.000001 },
    });
    const view = computeCostPanel(
      totals([
        { model: "known", inputTokens: 1_000_000 },
        { model: "mystery-model", inputTokens: 999_999_999_999 },
      ]),
      snap,
      SINCE,
      NOW,
    );
    expect(view.hasUnknown).toBe(true);
    expect(view.totalUsd).toBeCloseTo(1, 6);
    const unknownRow = view.rows.find((r) => r.isUnknown);
    expect(unknownRow?.totalUsd).toBe(0);
    expect(unknownRow?.inputUsd).toBeUndefined();
  });

  test("multiple distinct unknown raws produce separate rows", () => {
    const snap = snapshot({});
    const view = computeCostPanel(
      totals([
        { model: "alpha-model", inputTokens: 100 },
        { model: "beta-model", inputTokens: 200 },
        { model: null, inputTokens: 300 },
      ]),
      snap,
      SINCE,
      NOW,
    );
    expect(view.rows.length).toBe(3);
    expect(view.rows.every((r) => r.isUnknown)).toBe(true);
    // Sorted ascending by raw model string; null becomes "" and sorts first.
    expect(view.rows.map((r) => r.rawModel)).toEqual([
      "",
      "alpha-model",
      "beta-model",
    ]);
  });

  test("known rows sort by descending USD; unknown rows trail at the end", () => {
    const snap = snapshot({
      cheap: { input_cost_per_token: 0.000001 },
      pricey: { input_cost_per_token: 0.0001 },
    });
    const view = computeCostPanel(
      totals([
        // cheap: 1_000_000 * 0.000001 = $1.00
        { model: "cheap", inputTokens: 1_000_000 },
        // mystery: unknown → 0, must trail
        { model: "mystery", inputTokens: 1 },
        // pricey: 1_000 * 0.0001 = $0.10
        { model: "pricey", inputTokens: 1_000 },
      ]),
      snap,
      SINCE,
      NOW,
    );
    expect(view.rows.map((r) => r.model)).toEqual([
      "cheap",
      "pricey",
      "mystery",
    ]);
  });

  test("source 'unavailable' forces every row into the unknown bucket and zeroes the total", () => {
    const snap = snapshot(
      { "claude-3-5-sonnet": { input_cost_per_token: 0.000003 } },
      { source: "unavailable", stale: true },
    );
    const view = computeCostPanel(
      totals([
        {
          model: "claude-3-5-sonnet",
          inputTokens: 1_000_000,
        },
      ]),
      snap,
      SINCE,
      NOW,
    );
    expect(view.source).toBe("unavailable");
    expect(view.totalUsd).toBe(0);
    expect(view.rows.length).toBe(1);
    expect(view.rows[0]?.isUnknown).toBe(true);
    expect(view.rows[0]?.inputUsd).toBeUndefined();
  });
});

describe("formatRelativeFetched", () => {
  const now = Date.parse("2026-05-02T12:00:00.000Z");

  test("source 'unavailable' collapses to an em-dash regardless of timestamp", () => {
    expect(
      formatRelativeFetched("2026-05-02T11:59:59.000Z", now, "unavailable"),
    ).toBe("—");
  });

  test("under a minute renders 'just now' for litellm", () => {
    expect(
      formatRelativeFetched("2026-05-02T11:59:30.000Z", now, "litellm"),
    ).toBe("just now");
  });

  test("under an hour renders Nm ago", () => {
    expect(
      formatRelativeFetched("2026-05-02T11:35:00.000Z", now, "litellm"),
    ).toBe("25m ago");
  });

  test("under a day renders Nh ago", () => {
    expect(
      formatRelativeFetched("2026-05-02T05:00:00.000Z", now, "litellm"),
    ).toBe("7h ago");
  });

  test("under 30 days renders Nd ago", () => {
    expect(
      formatRelativeFetched("2026-04-20T12:00:00.000Z", now, "litellm"),
    ).toBe("12d ago");
  });

  test("30+ days renders the calendar date", () => {
    expect(
      formatRelativeFetched("2026-01-01T00:00:00.000Z", now, "litellm"),
    ).toBe("on 2026-01-01");
  });

  test("source 'bundled' prefixes every body with 'bundled — '", () => {
    expect(
      formatRelativeFetched("2026-05-02T11:59:30.000Z", now, "bundled"),
    ).toBe("bundled — just now");
    expect(
      formatRelativeFetched("2026-04-20T12:00:00.000Z", now, "bundled"),
    ).toBe("bundled — 12d ago");
  });
});

describe("formatTokenCount", () => {
  test("renders bare integers below 1000", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("renders k-suffixed strings for thousands with one decimal", () => {
    expect(formatTokenCount(1_000)).toBe("1k");
    expect(formatTokenCount(1_500)).toBe("1.5k");
    expect(formatTokenCount(320_000)).toBe("320k");
  });

  test("renders M-suffixed strings for millions with one decimal", () => {
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
  });
});

describe("formatUsd", () => {
  test("undefined renders as the em-dash sentinel", () => {
    expect(formatUsd(undefined)).toBe("—");
  });

  test("zero renders as $0.00 (distinct from undefined)", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  test("non-zero values below one cent collapse to <$0.01", () => {
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(0.0099)).toBe("<$0.01");
  });

  test("regular values render with two-decimal precision", () => {
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(123.456)).toBe("$123.46");
  });
});
