import { expect, test } from "bun:test";
import { formatElapsed } from "./log.ts";

test("formatElapsed: sub-second uses ms unit", () => {
  const start = performance.now();
  const result = formatElapsed(start);
  expect(result).toMatch(/^\d+ms$/);
});

test("formatElapsed: large elapsed uses seconds with 2 decimal places", () => {
  const start = performance.now() - 2500;
  const result = formatElapsed(start);
  expect(result).toMatch(/^\d+\.\d{2}s$/);
});
