import { expect, test } from "bun:test";
import { decisionArgv } from "./decision.js";

const base = {
  domain: "hostexec",
  action: "approve",
  sessionId: "s1",
  requestId: "r1",
};

test("approve with scope", () => {
  expect(decisionArgv({ ...base, scope: "capability" })).toEqual([
    "hostexec",
    "approve",
    "s1",
    "r1",
    "--scope",
    "capability",
  ]);
});

test("deny never carries a scope", () => {
  expect(
    decisionArgv({ ...base, action: "deny", scope: "capability" }),
  ).toEqual(["hostexec", "deny", "s1", "r1"]);
});

test("flag-shaped ids and unknown domain are rejected", () => {
  expect(() => decisionArgv({ ...base, sessionId: "--scope" })).toThrow();
  expect(() => decisionArgv({ ...base, domain: "other" })).toThrow();
  expect(() => decisionArgv({ ...base, action: "hold" })).toThrow();
});
