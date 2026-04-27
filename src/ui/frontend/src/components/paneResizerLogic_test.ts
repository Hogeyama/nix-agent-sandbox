import { describe, expect, test } from "bun:test";
import { clampWidth } from "./paneResizerLogic";

describe("clampWidth", () => {
  test("clamps negative values up to min", () => {
    expect(clampWidth(-1, 200, 600)).toBe(200);
  });

  test("clamps values above max down to max", () => {
    expect(clampWidth(1_000_000, 200, 600)).toBe(600);
  });

  test("returns min for NaN", () => {
    expect(clampWidth(Number.NaN, 200, 600)).toBe(200);
  });

  test("returns min for Infinity (Infinity is not finite)", () => {
    expect(clampWidth(Number.POSITIVE_INFINITY, 200, 600)).toBe(200);
  });

  test("returns the input unchanged when within range", () => {
    expect(clampWidth(300, 200, 600)).toBe(300);
  });

  test("returns min for null (null is not finite)", () => {
    // `null as unknown as number` mirrors a corrupted localStorage value
    // surfacing into the helper after a defensive `JSON.parse`.
    expect(clampWidth(null as unknown as number, 200, 600)).toBe(200);
  });
});
