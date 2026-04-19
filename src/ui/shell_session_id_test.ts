/**
 * Pure helpers shared between backend and frontend. Covers every malformed
 * input path since this function runs at API boundaries and bad parses
 * would surface as silent no-ops downstream.
 */

import { expect, test } from "bun:test";
import {
  buildShellSessionId,
  parseShellSessionId,
} from "./shell_session_id.ts";

// ---------------------------------------------------------------------------
// buildShellSessionId
// ---------------------------------------------------------------------------

test("buildShellSessionId: concatenates shell-<parent>.<seq>", () => {
  expect(buildShellSessionId("2026-04-19T10-00-00Z", 1)).toEqual(
    "shell-2026-04-19T10-00-00Z.1",
  );
});

test("buildShellSessionId: seq > 1 appends correctly", () => {
  expect(buildShellSessionId("abc", 42)).toEqual("shell-abc.42");
});

// ---------------------------------------------------------------------------
// parseShellSessionId — happy path
// ---------------------------------------------------------------------------

test("parseShellSessionId: round-trips with buildShellSessionId", () => {
  const id = buildShellSessionId("parent-xyz", 7);
  expect(parseShellSessionId(id)).toEqual({
    parentSessionId: "parent-xyz",
    seq: 7,
  });
});

test("parseShellSessionId: uses the last dot so parent may contain dots", () => {
  // Real nas session IDs are ISO timestamps — no dots — but be defensive.
  expect(parseShellSessionId("shell-a.b.c.3")).toEqual({
    parentSessionId: "a.b.c",
    seq: 3,
  });
});

// ---------------------------------------------------------------------------
// parseShellSessionId — rejection cases
// ---------------------------------------------------------------------------

test("parseShellSessionId: null when missing shell- prefix", () => {
  expect(parseShellSessionId("nas-2026.1")).toEqual(null);
  expect(parseShellSessionId("")).toEqual(null);
});

test("parseShellSessionId: null when there's no dot after the prefix", () => {
  expect(parseShellSessionId("shell-parent")).toEqual(null);
});

test("parseShellSessionId: null when dot is the first character (empty parent)", () => {
  expect(parseShellSessionId("shell-.5")).toEqual(null);
});

test("parseShellSessionId: null when seq segment is empty", () => {
  expect(parseShellSessionId("shell-parent.")).toEqual(null);
});

test("parseShellSessionId: null when seq is not purely digits", () => {
  expect(parseShellSessionId("shell-parent.1a")).toEqual(null);
  expect(parseShellSessionId("shell-parent.-1")).toEqual(null);
  expect(parseShellSessionId("shell-parent. 1")).toEqual(null);
});

test("parseShellSessionId: null when seq is 0 or negative", () => {
  expect(parseShellSessionId("shell-parent.0")).toEqual(null);
});

test("parseShellSessionId: accepts large seq values", () => {
  expect(parseShellSessionId("shell-p.999999")).toEqual({
    parentSessionId: "p",
    seq: 999999,
  });
});
