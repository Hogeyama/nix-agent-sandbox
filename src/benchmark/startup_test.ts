import { describe, expect, test } from "bun:test";

import { createMarkerScanner, summarizeSamples } from "./startup.ts";

describe("summarizeSamples", () => {
  test("returns min, median, and max from unsorted samples", () => {
    expect(summarizeSamples([4100, 3900, 4050, 4200, 4000])).toEqual({
      min: 3900,
      median: 4050,
      max: 4200,
    });
  });
});

describe("createMarkerScanner", () => {
  test("detects a marker only when the final chunk completes it", () => {
    const scanner = createMarkerScanner("READY", () => {});

    expect(scanner.push("boot REA")).toBe(false);
    expect(scanner.push("DY now")).toBe(true);
  });

  test("preserves surrounding non-marker output order after finish", () => {
    const output: string[] = [];
    const scanner = createMarkerScanner("READY", (text) => output.push(text));

    expect(scanner.push("alpha REA")).toBe(false);
    expect(scanner.push("DY omega")).toBe(true);

    scanner.finish();

    expect(output).toEqual(["alpha ", " omega"]);
  });
});
