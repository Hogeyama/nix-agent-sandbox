import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { claimSessionId, SessionIdInUseError } from "./ownership.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nas-session-owners-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("claimSessionId refuses an id a live process already owns", () => {
  const first = claimSessionId("sess_aaa", dir);
  try {
    expect(() => claimSessionId("sess_aaa", dir)).toThrow(SessionIdInUseError);
  } finally {
    first.release();
  }
});

test("claimSessionId lets the id be claimed again after release", () => {
  claimSessionId("sess_aaa", dir).release();
  claimSessionId("sess_aaa", dir).release();
  expect(existsSync(path.join(dir, "sess_aaa.owner"))).toBe(false);
});

test("claimSessionId takes over an id whose owner is gone", () => {
  // pid 自体が生きていても、起動時刻が違えば pid が再利用された別プロセス。
  writeFileSync(path.join(dir, "sess_aaa.owner"), `${process.pid} 0\n`);
  claimSessionId("sess_aaa", dir).release();
});

test("release leaves an owner file written by another process alone", () => {
  const ownership = claimSessionId("sess_aaa", dir);
  const ownerPath = path.join(dir, "sess_aaa.owner");
  writeFileSync(ownerPath, "1 12345\n");
  ownership.release();
  expect(existsSync(ownerPath)).toBe(true);
});

test("claimSessionId rejects an id that would escape the directory", () => {
  expect(() => claimSessionId("../sess_aaa", dir)).toThrow(/Invalid session/);
  expect(() => claimSessionId("", dir)).toThrow(/Invalid session/);
});
