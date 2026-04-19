/**
 * Log level gating: info logs are silenced when level is warn or error.
 * Process-global state is restored in afterEach so tests don't leak.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { getLogLevel, logInfo, logWarn, setLogLevel } from "./log.ts";

let originalLevel: ReturnType<typeof getLogLevel>;
let logs: string[];
const realLog = console.log;

beforeEach(() => {
  originalLevel = getLogLevel();
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
  setLogLevel(originalLevel);
});

test("default level is 'info'", () => {
  // Runs in isolation because beforeEach captures the current level.
  setLogLevel("info");
  expect(getLogLevel()).toEqual("info");
});

test("setLogLevel then getLogLevel round-trips", () => {
  setLogLevel("warn");
  expect(getLogLevel()).toEqual("warn");
  setLogLevel("error");
  expect(getLogLevel()).toEqual("error");
  setLogLevel("info");
  expect(getLogLevel()).toEqual("info");
});

test("logInfo: printed at 'info', suppressed at 'warn' and 'error'", () => {
  setLogLevel("info");
  logInfo("hello");
  expect(logs).toEqual(["hello"]);

  logs.length = 0;
  setLogLevel("warn");
  logInfo("hidden");
  expect(logs).toEqual([]);

  setLogLevel("error");
  logInfo("hidden");
  expect(logs).toEqual([]);
});

test("logWarn: printed at 'info' and 'warn', suppressed at 'error'", () => {
  setLogLevel("info");
  logWarn("a");
  expect(logs).toEqual(["a"]);

  logs.length = 0;
  setLogLevel("warn");
  logWarn("b");
  expect(logs).toEqual(["b"]);

  logs.length = 0;
  setLogLevel("error");
  logWarn("hidden");
  expect(logs).toEqual([]);
});
