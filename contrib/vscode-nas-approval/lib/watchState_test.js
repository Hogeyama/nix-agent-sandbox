import { expect, test } from "bun:test";
import { applyWatchEvent, makeWatchState, pendingCount } from "./watchState.js";

const added = (domain, sessionId, requestId) => ({
  event: "added",
  domain,
  entry: { sessionId, requestId, host: "example.com" },
});
const removed = (domain, sessionId, requestId) => ({
  event: "removed",
  domain,
  sessionId,
  requestId,
});

test("added/removed change the count", () => {
  const s = makeWatchState();
  expect(applyWatchEvent(s, added("hostexec", "s1", "r1"))).toBe(true);
  expect(applyWatchEvent(s, added("network", "s1", "r2"))).toBe(true);
  expect(pendingCount(s)).toBe(2);
  expect(applyWatchEvent(s, removed("hostexec", "s1", "r1"))).toBe(true);
  expect(pendingCount(s)).toBe(1);
});

test("duplicate added is a no-op", () => {
  const s = makeWatchState();
  applyWatchEvent(s, added("hostexec", "s1", "r1"));
  expect(applyWatchEvent(s, added("hostexec", "s1", "r1"))).toBe(false);
  expect(pendingCount(s)).toBe(1);
});

test("removed for unknown key is a no-op; unknown domain ignored", () => {
  const s = makeWatchState();
  expect(applyWatchEvent(s, removed("hostexec", "s1", "rx"))).toBe(false);
  expect(applyWatchEvent(s, added("other", "s1", "r1"))).toBe(false);
});
