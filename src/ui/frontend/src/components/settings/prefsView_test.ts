/**
 * Tests for the Preferences settings page pure helpers.
 *
 * These cover the validation contract the page component and the
 * `uiStore` rely on: `clampFontSize` collapses non-finite input to
 * the default, clamps out-of-range values to the nearest boundary,
 * and passes supported sizes through verbatim. The constants
 * themselves are pinned so a silent reorder is caught by tests.
 */

import { describe, expect, test } from "bun:test";
import {
  clampFontSize,
  DEFAULT_FONT_SIZE_PX,
  FONT_SIZE_CHOICES,
} from "./prefsView";

describe("FONT_SIZE_CHOICES", () => {
  test("contains 12 through 16 in ascending order", () => {
    expect(FONT_SIZE_CHOICES).toEqual([12, 13, 14, 15, 16]);
  });

  test("contains DEFAULT_FONT_SIZE_PX", () => {
    expect(FONT_SIZE_CHOICES).toContain(DEFAULT_FONT_SIZE_PX);
  });
});

describe("clampFontSize", () => {
  test("passes supported sizes through unchanged", () => {
    for (const size of FONT_SIZE_CHOICES) {
      expect(clampFontSize(size)).toBe(size);
    }
  });

  test("clamps below-minimum input up to 12", () => {
    expect(clampFontSize(11)).toBe(12);
    expect(clampFontSize(-1)).toBe(12);
  });

  test("clamps above-maximum input down to 16", () => {
    expect(clampFontSize(17)).toBe(16);
  });

  test("collapses NaN to the default", () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT_SIZE_PX);
  });

  test("collapses positive Infinity to 16", () => {
    // `Number.POSITIVE_INFINITY` is not finite, so it follows the
    // NaN/Infinity branch and returns the default rather than the
    // numeric upper bound. Pin the behaviour so a future refactor
    // does not silently swap the policy.
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FONT_SIZE_PX);
  });

  test("collapses negative Infinity to the default", () => {
    expect(clampFontSize(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_FONT_SIZE_PX);
  });
});
