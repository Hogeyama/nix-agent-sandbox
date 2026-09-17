import { expect, test } from "bun:test";
import { isValidId } from "./ids.js";
import { parseDevcontainerStatus, readySessionId } from "./session.js";

test("isValidId accepts nas id shape and rejects flag-like values", () => {
  expect(isValidId("sess_a1B2-c3")).toBe(true);
  expect(isValidId("--scope")).toBe(false);
  expect(isValidId("")).toBe(false);
  expect(isValidId(42)).toBe(false);
});

test("parseDevcontainerStatus returns null for uninitialized workspace", () => {
  expect(parseDevcontainerStatus("null\n")).toBeNull();
});

test("readySessionId yields id only for ready sessions", () => {
  const ready = parseDevcontainerStatus(
    JSON.stringify({ phase: "ready", sessionId: "sess_x9" }),
  );
  expect(readySessionId(ready)).toBe("sess_x9");
  const starting = parseDevcontainerStatus(
    JSON.stringify({ phase: "starting", sessionId: "sess_x9" }),
  );
  expect(readySessionId(starting)).toBeNull();
  const bad = { phase: "ready", sessionId: "--bogus" };
  expect(readySessionId(bad)).toBeNull();
});
