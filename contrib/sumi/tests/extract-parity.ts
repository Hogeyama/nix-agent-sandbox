import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

type Span = { start: number; end: number };
type Match = { whole: Span; value: Span };
type Fixture = {
  name: string;
  content: string;
  patterns: string[];
  expected: string;
  outcome: string;
  expression: string | null;
  matches: Match[];
};

const executable = fileURLToPath(
  new URL("../zig-out/bin/sumi-extract-fixtures", import.meta.url),
);
const process = Bun.spawnSync([executable]);
assert.equal(process.exitCode, 0, process.stderr.toString());
const fixtures: Fixture[] = JSON.parse(process.stdout.toString());
assert(fixtures.length > 0, "fixture exporter returned no fixtures");

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function javascriptMatches(
  content: string,
  expression: string,
  flags: string,
): Match[] {
  const bytePosition = (position: number): number =>
    Buffer.byteLength(content.slice(0, position));
  const byteSpan = ([start, end]: [number, number]): Span => ({
    start: bytePosition(start),
    end: bytePosition(end),
  });
  return [...content.matchAll(new RegExp(expression, flags))].map((match) => {
    assert.equal(
      match.length,
      2,
      "expression must have exactly one capture group",
    );
    assert(match.indices?.[0] && match.indices[1], "missing match indices");
    return {
      whole: byteSpan(match.indices[0]),
      value: byteSpan(match.indices[1]),
    };
  });
}

// This independently checks coverage from JS captures, never recognizes keys
// or values. Copy searches use complete captured byte strings, not patterns.
function conservativeReplacement(content: string, matches: Match[]): Buffer {
  const bytes = Buffer.from(content);
  const values = new Map<string, Buffer>();
  for (const match of matches) {
    const value = bytes.subarray(match.value.start, match.value.end);
    assert(value.length > 0, "empty capture");
    values.set(value.toString("hex"), value);
  }
  const uniqueCopies = new Map<string, Span>();
  for (const value of values.values()) {
    let from = 0;
    for (;;) {
      const start = bytes.indexOf(value, from);
      if (start < 0) break;
      const copy = { start, end: start + value.length };
      uniqueCopies.set(`${copy.start}:${copy.end}`, copy);
      from = start + 1;
    }
  }
  const copies = [...uniqueCopies.values()].filter(
    (copy) => !matches.some((match) => overlaps(copy, match.whole)),
  );
  const safeCopies = copies.filter(
    (copy, i) => !copies.some((other, j) => i !== j && overlaps(copy, other)),
  );
  const ranges = [...matches.map((match) => match.value), ...safeCopies].sort(
    (a, b) => a.start - b.start,
  );
  const result: Buffer[] = [];
  let previous = 0;
  for (const range of ranges) {
    assert(range.start >= previous, "replacement ranges overlap");
    result.push(bytes.subarray(previous, range.start), Buffer.from("<masked>"));
    previous = range.end;
  }
  result.push(bytes.subarray(previous));
  return Buffer.concat(result);
}

let rules = 0;
let wholeFiles = 0;
let skips = 0;
for (const fixture of fixtures) {
  try {
    assert.equal(
      fixture.outcome,
      fixture.expected,
      "unexpected extraction outcome",
    );
    if (fixture.outcome === "whole_file") {
      wholeFiles++;
      assert.equal(fixture.expression, null);
      assert.deepEqual(fixture.matches, []);
      const trimmed = fixture.content.replace(/\r?\n$/, "");
      assert(fixture.patterns.includes(trimmed), "whole file is not a pattern");
      continue;
    }
    if (fixture.outcome !== "rule") {
      skips++;
      assert(
        ["no-form", "prefix-contains-value", "coverage"].includes(
          fixture.outcome,
        ),
      );
      assert.equal(fixture.expression, null);
      assert.deepEqual(fixture.matches, []);
      continue;
    }
    rules++;
    assert(fixture.expression !== null, "rule has no expression");
    const expression = fixture.expression;
    const matches = javascriptMatches(fixture.content, expression, "gd");
    assert(matches.length > 0, "successful rule has no matches");
    assert.deepEqual(
      matches,
      fixture.matches,
      "Zig and JavaScript gd spans differ",
    );
    if (fixture.content.includes("\n")) {
      assert.deepEqual(
        javascriptMatches(fixture.content, expression, "gmd").map(
          (match) => match.value,
        ),
        matches.map((match) => match.value),
        "gd and gmd captured value spans differ",
      );
    }
    const replaced = conservativeReplacement(fixture.content, matches);
    for (const pattern of fixture.patterns) {
      assert(!expression.includes(pattern), "expression leaks a pattern");
      assert(
        !replaced.includes(Buffer.from(pattern)),
        "pattern remains after replacement",
      );
    }
  } catch (error) {
    throw new Error(
      `Fixture ${fixture.name}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}
console.log(
  `extract parity: ${fixtures.length} fixtures passed (${rules} rules, ${wholeFiles} whole-file, ${skips} skips)`,
);
