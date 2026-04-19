/**
 * Pure CLI helper tests.
 */

import { expect, test } from "bun:test";
import {
  findFirstNonFlagArg,
  getFlagValue,
  hasFormatJson,
  parseLogLevel,
  positionalArgsAfterSubcommand,
  removeFirstOccurrence,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// removeFirstOccurrence
// ---------------------------------------------------------------------------

test("removeFirstOccurrence: returns copy without the first match", () => {
  expect(removeFirstOccurrence(["a", "b", "c", "b"], "b")).toEqual([
    "a",
    "c",
    "b",
  ]);
});

test("removeFirstOccurrence: returns a copy when value is absent", () => {
  const input = ["a", "b"];
  const result = removeFirstOccurrence(input, "x");
  expect(result).toEqual(["a", "b"]);
  expect(result).not.toBe(input); // new array
});

// ---------------------------------------------------------------------------
// getFlagValue
// ---------------------------------------------------------------------------

test("getFlagValue: returns the token immediately after the flag", () => {
  expect(getFlagValue(["--scope", "host-port"], "--scope")).toEqual(
    "host-port",
  );
});

test("getFlagValue: null when flag is absent", () => {
  expect(getFlagValue(["a", "b"], "--scope")).toEqual(null);
});

test("getFlagValue: null when flag is the last token", () => {
  expect(getFlagValue(["a", "--scope"], "--scope")).toEqual(null);
});

// ---------------------------------------------------------------------------
// positionalArgsAfterSubcommand
// ---------------------------------------------------------------------------

test("positionalArgsAfterSubcommand: picks the first two positionals after subcommand", () => {
  expect(
    positionalArgsAfterSubcommand(
      ["approve", "sess-abc", "req-42", "--scope", "host-port"],
      "approve",
    ),
  ).toEqual(["sess-abc", "req-42"]);
});

test("positionalArgsAfterSubcommand: skips --scope argument", () => {
  expect(
    positionalArgsAfterSubcommand(
      ["approve", "--scope", "host-port", "sess", "req"],
      "approve",
    ),
  ).toEqual(["sess", "req"]);
});

test("positionalArgsAfterSubcommand: skips --runtime-dir argument", () => {
  expect(
    positionalArgsAfterSubcommand(
      ["approve", "--runtime-dir", "/tmp/nas", "sess", "req"],
      "approve",
    ),
  ).toEqual(["sess", "req"]);
});

test("positionalArgsAfterSubcommand: throws when only one positional given", () => {
  expect(() =>
    positionalArgsAfterSubcommand(["approve", "sess"], "approve"),
  ).toThrow(/requires/);
});

test("positionalArgsAfterSubcommand: error message includes subcommand name", () => {
  expect(() => positionalArgsAfterSubcommand(["deny"], "deny")).toThrow(/deny/);
});

// ---------------------------------------------------------------------------
// hasFormatJson
// ---------------------------------------------------------------------------

test("hasFormatJson: matches --format=json (equals form)", () => {
  expect(hasFormatJson(["--format=json"])).toEqual(true);
});

test("hasFormatJson: matches --format json (space form)", () => {
  expect(hasFormatJson(["--format", "json"])).toEqual(true);
});

test("hasFormatJson: false for unrelated args", () => {
  expect(hasFormatJson(["approve", "sess", "req"])).toEqual(false);
});

test("hasFormatJson: false for --format followed by non-json value", () => {
  expect(hasFormatJson(["--format", "yaml"])).toEqual(false);
});

// ---------------------------------------------------------------------------
// parseLogLevel
// ---------------------------------------------------------------------------

test("parseLogLevel: --quiet produces warn", () => {
  expect(parseLogLevel(["--quiet"])).toEqual("warn");
});

test("parseLogLevel: -q produces warn", () => {
  expect(parseLogLevel(["-q"])).toEqual("warn");
});

test("parseLogLevel: default is info", () => {
  expect(parseLogLevel([])).toEqual("info");
  expect(parseLogLevel(["--other-flag"])).toEqual("info");
});

// ---------------------------------------------------------------------------
// findFirstNonFlagArg
// ---------------------------------------------------------------------------

test("findFirstNonFlagArg: returns first positional arg", () => {
  expect(findFirstNonFlagArg(["profile", "extra"])).toEqual("profile");
});

test("findFirstNonFlagArg: skips --worktree and its value", () => {
  expect(findFirstNonFlagArg(["--worktree", "main", "profile"])).toEqual(
    "profile",
  );
});

test("findFirstNonFlagArg: skips -b and its value", () => {
  expect(findFirstNonFlagArg(["-b", "main", "profile"])).toEqual("profile");
});

test("findFirstNonFlagArg: skips -b=value style flags", () => {
  expect(findFirstNonFlagArg(["-b=main", "profile"])).toEqual("profile");
});

test("findFirstNonFlagArg: skips --scope/--runtime-dir/--port/--since/--session/--domain/--audit-dir/--format", () => {
  expect(
    findFirstNonFlagArg([
      "--scope",
      "host-port",
      "--runtime-dir",
      "/tmp",
      "--port",
      "3939",
      "--since",
      "2026-01-01",
      "--session",
      "sess",
      "--domain",
      "network",
      "--audit-dir",
      "/tmp",
      "--format",
      "json",
      "profile",
    ]),
  ).toEqual("profile");
});

test("findFirstNonFlagArg: skips standalone --quiet/--no-worktree/--no-open", () => {
  expect(
    findFirstNonFlagArg(["--quiet", "--no-worktree", "--no-open", "profile"]),
  ).toEqual("profile");
});

test("findFirstNonFlagArg: undefined when only flags present", () => {
  expect(findFirstNonFlagArg(["--quiet", "--foo"])).toEqual(undefined);
});

test("findFirstNonFlagArg: undefined for empty input", () => {
  expect(findFirstNonFlagArg([])).toEqual(undefined);
});
