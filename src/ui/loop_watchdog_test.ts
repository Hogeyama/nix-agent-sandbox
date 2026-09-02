/**
 * Tests for the event-loop block watchdog.
 *
 * The pinned behaviours are:
 *
 *   - a wake-up that lands late by at least the threshold is reported,
 *     and one that lands on time is silent;
 *   - the next expectation is rebased on the actual wake-up, so a single
 *     long block does not report every later sample as late too;
 *   - `stop()` releases the timer.
 */

import { describe, expect, test } from "bun:test";
import { startLoopWatchdog } from "./loop_watchdog.ts";

function harness() {
  let t = 0;
  const warnings: string[] = [];
  let fn: (() => void) | null = null;
  let cleared = 0;
  const watchdog = startLoopWatchdog({
    intervalMs: 100,
    thresholdMs: 250,
    now: () => t,
    setIntervalFn: (cb) => {
      fn = cb;
      return 1;
    },
    clearIntervalFn: () => {
      cleared++;
    },
    warn: (m) => warnings.push(m),
  });
  return {
    watchdog,
    warnings,
    get cleared() {
      return cleared;
    },
    /** Advance the clock, then fire the sampler as the loop would. */
    tickAfter(ms: number) {
      t += ms;
      fn?.();
    },
  };
}

describe("startLoopWatchdog", () => {
  test("stays silent while wake-ups land on time", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.tickAfter(100);
    expect(h.warnings).toEqual([]);
  });

  test("stays silent for lag below the threshold", () => {
    const h = harness();
    // 100ms interval, fires 240ms late in total → 140ms of lag.
    h.tickAfter(240);
    expect(h.warnings).toEqual([]);
  });

  test("reports a block at or above the threshold", () => {
    const h = harness();
    // Fires 900ms after start against a 100ms interval → 800ms blocked.
    h.tickAfter(900);
    expect(h.warnings).toEqual(["[ui] event loop blocked for 800ms"]);
  });

  test("rebases on the actual wake-up so one block reports once", () => {
    const h = harness();
    h.tickAfter(900);
    expect(h.warnings).toHaveLength(1);

    // Measuring the next sample from the missed schedule instead of the
    // actual wake-up would make every later on-time sample look late.
    for (let i = 0; i < 5; i++) h.tickAfter(100);
    expect(h.warnings).toHaveLength(1);
  });

  test("stop clears the sampling timer", () => {
    const h = harness();
    h.watchdog.stop();
    expect(h.cleared).toBe(1);
  });
});
