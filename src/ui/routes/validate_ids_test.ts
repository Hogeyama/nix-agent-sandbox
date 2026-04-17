import { expect, test } from "bun:test";
import { isSafeId } from "./validate_ids.ts";

test("isSafeId: accepts sess_<hex> launcher id", () => {
  expect(isSafeId("sess_abc123")).toBe(true);
});

test("isSafeId: accepts ISO-timestamp-style session id", () => {
  expect(isSafeId("2026-04-18T10-00-00-000Z")).toBe(true);
});

test("isSafeId: accepts shell-<parent>.<seq>", () => {
  expect(isSafeId("shell-sess_x.1")).toBe(true);
});

test("isSafeId: accepts docker container names", () => {
  expect(isSafeId("nas-agent-foo")).toBe(true);
  expect(isSafeId("container_1")).toBe(true);
});

test("isSafeId: rejects ../evil traversal", () => {
  expect(isSafeId("../evil")).toBe(false);
});

test("isSafeId: rejects forward slash", () => {
  expect(isSafeId("foo/bar")).toBe(false);
});

test("isSafeId: rejects backslash", () => {
  expect(isSafeId("foo\\bar")).toBe(false);
});

test("isSafeId: rejects empty string", () => {
  expect(isSafeId("")).toBe(false);
});

test("isSafeId: rejects 129-character id (too long)", () => {
  expect(isSafeId("a".repeat(129))).toBe(false);
});

test("isSafeId: accepts 128-character id (boundary)", () => {
  expect(isSafeId("a".repeat(128))).toBe(true);
});

test("isSafeId: rejects leading hyphen", () => {
  expect(isSafeId("-leading")).toBe(false);
});

test("isSafeId: rejects leading dot", () => {
  expect(isSafeId(".hidden")).toBe(false);
});

test("isSafeId: rejects leading underscore", () => {
  // A leading _ is not in [A-Za-z0-9] so it's rejected by the anchor.
  expect(isSafeId("_leading")).toBe(false);
});

test("isSafeId: rejects ..\\.. substring even when other chars are valid", () => {
  expect(isSafeId("foo..bar")).toBe(false);
});

test("isSafeId: rejects NUL byte", () => {
  expect(isSafeId("foo\0bar")).toBe(false);
});

test("isSafeId: rejects non-string inputs", () => {
  expect(isSafeId(undefined)).toBe(false);
  expect(isSafeId(null)).toBe(false);
  expect(isSafeId(123)).toBe(false);
  expect(isSafeId({})).toBe(false);
});
