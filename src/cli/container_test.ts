/**
 * Pure function tests for `pickFulfilledContainerDetails`.
 *
 * Covers the `Promise.allSettled` semantics used by `nas container list` so a
 * single failing `dockerInspectContainer` call does not abort the whole list.
 * Rejected entries are silently dropped — no stderr/stdout side effects — to
 * keep `--format json` output a clean pipe-friendly array and to match the
 * UI's `for` + skip semantics in `ContainerQueryService.listManaged`.
 *
 * These tests do not need Docker; only the pure helper is exercised.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { DockerContainerDetails } from "../docker/client.ts";
import { pickFulfilledContainerDetails } from "./container.ts";

function detail(name: string): DockerContainerDetails {
  return {
    name,
    running: true,
    labels: {},
    networks: [],
    startedAt: "2026-01-01T00:00:00Z",
  };
}

function fulfilled(
  value: DockerContainerDetails,
): PromiseFulfilledResult<DockerContainerDetails> {
  return { status: "fulfilled", value };
}

function rejected(reason: unknown): PromiseRejectedResult {
  return { status: "rejected", reason };
}

// ---------------------------------------------------------------------------
// Console spy: silent-skip contract
// ---------------------------------------------------------------------------
//
// `pickFulfilledContainerDetails` must not emit any log/warn/error output for
// rejected results. We assert this as a contract so a future maintainer cannot
// silently introduce a `console.warn` that would corrupt `--format json` pipe
// output.

const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
let logCalls = 0;
let warnCalls = 0;
let errorCalls = 0;

beforeEach(() => {
  logCalls = 0;
  warnCalls = 0;
  errorCalls = 0;
  console.log = () => {
    logCalls += 1;
  };
  console.warn = () => {
    warnCalls += 1;
  };
  console.error = () => {
    errorCalls += 1;
  };
});

afterEach(() => {
  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test("pickFulfilledContainerDetails: all fulfilled -> returns every value in order", () => {
  const a = detail("a");
  const b = detail("b");
  const c = detail("c");
  const result = pickFulfilledContainerDetails([
    fulfilled(a),
    fulfilled(b),
    fulfilled(c),
  ]);
  expect(result).toEqual([a, b, c]);
  expect(logCalls + warnCalls + errorCalls).toEqual(0);
});

test("pickFulfilledContainerDetails: middle rejected -> skips and preserves order, no log output (silent skip)", () => {
  const a = detail("a");
  const c = detail("c");
  const result = pickFulfilledContainerDetails([
    fulfilled(a),
    rejected(new Error("inspect failed for b")),
    fulfilled(c),
  ]);
  expect(result).toEqual([a, c]);
  // Silent-skip contract: rejected reason MUST NOT be surfaced via console.
  // If this fails, `--format json` pipe output would be corrupted by stderr
  // (or stdout) noise. See container.ts for the observability TODO.
  expect(logCalls).toEqual(0);
  expect(warnCalls).toEqual(0);
  expect(errorCalls).toEqual(0);
});

test("pickFulfilledContainerDetails: empty input -> empty array (boundary)", () => {
  const result = pickFulfilledContainerDetails([]);
  expect(result).toEqual([]);
  expect(logCalls + warnCalls + errorCalls).toEqual(0);
});

test("pickFulfilledContainerDetails: all rejected -> empty array (extreme)", () => {
  const result = pickFulfilledContainerDetails([
    rejected(new Error("x")),
    rejected(new Error("y")),
  ]);
  expect(result).toEqual([]);
  expect(logCalls + warnCalls + errorCalls).toEqual(0);
});
