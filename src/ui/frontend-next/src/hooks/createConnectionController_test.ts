/**
 * Pin tests for `createConnectionController` covering the four
 * behaviours that protect the offline-indicator UX:
 *
 *   1. clean open keeps `connected = true` and never schedules a flip
 *   2. reopen within the grace window suppresses the offline flip
 *   3. no reopen by the grace boundary flips offline exactly once
 *   4. dispose silences every in-flight callback
 *
 * Bun's `bun:test` does not ship a jest-like fake timer, so the test
 * builds a minimal one inline (`createFakeClock`) along with an
 * `EventSource` stub. Both are wired through `ConnectionDeps`, which is
 * the whole point of injecting timers and the EventSource factory.
 */

import { describe, expect, test } from "bun:test";
import {
  type ConnectionDeps,
  createConnectionController,
  OFFLINE_GRACE_MS,
  RECONNECT_BACKOFF_MS,
} from "./createConnectionController";

interface FakeClock {
  setTimeout: (cb: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  advance: (ms: number) => void;
}

function createFakeClock(): FakeClock {
  // Tasks are kept in insertion order with their absolute due time.
  // `advance` walks `now` forward, firing every task whose due time
  // falls within the new window. Tasks scheduled from inside a callback
  // observe the post-fire value of `now`, matching real timer semantics
  // for "schedule a follow-up at +N ms from now".
  interface Task {
    handle: number;
    dueAt: number;
    cb: () => void;
    cancelled: boolean;
  }
  let now = 0;
  let nextHandle = 1;
  const tasks: Task[] = [];

  return {
    setTimeout(cb, ms) {
      const task: Task = {
        handle: nextHandle++,
        dueAt: now + ms,
        cb,
        cancelled: false,
      };
      tasks.push(task);
      return task.handle;
    },
    clearTimeout(handle) {
      for (const task of tasks) {
        if (task.handle === handle) task.cancelled = true;
      }
    },
    advance(ms) {
      const target = now + ms;
      // Loop because callbacks may schedule new tasks that also fall
      // within the advance window.
      while (true) {
        let next: Task | undefined;
        for (const task of tasks) {
          if (task.cancelled) continue;
          if (task.dueAt > target) continue;
          if (next === undefined || task.dueAt < next.dueAt) next = task;
        }
        if (next === undefined) break;
        next.cancelled = true; // one-shot
        now = next.dueAt;
        next.cb();
      }
      now = target;
    },
  };
}

interface FakeEventSource {
  url: string;
  closed: boolean;
  triggerOpen: () => void;
  triggerError: () => void;
  // Mutable fields set by the controller.
  onopen: ((this: FakeEventSource) => void) | null;
  onerror: ((this: FakeEventSource) => void) | null;
  close: () => void;
}

interface Harness {
  setConnectedCalls: boolean[];
  sources: FakeEventSource[];
  deps: ConnectionDeps;
}

function makeHarness(clock: FakeClock): Harness {
  const setConnectedCalls: boolean[] = [];
  const sources: FakeEventSource[] = [];

  const deps: ConnectionDeps = {
    setConnected: (v) => {
      setConnectedCalls.push(v);
    },
    createEventSource: (url) => {
      const es: FakeEventSource = {
        url,
        closed: false,
        onopen: null,
        onerror: null,
        close() {
          this.closed = true;
        },
        triggerOpen() {
          this.onopen?.call(this);
        },
        triggerError() {
          this.onerror?.call(this);
        },
      };
      sources.push(es);
      // The controller treats the returned object structurally
      // (assigning onopen/onerror, calling close()), so casting through
      // unknown is safe here.
      return es as unknown as EventSource;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };

  return { setConnectedCalls, sources, deps };
}

describe("createConnectionController", () => {
  test("onopen at t=0 sets connected(true) and schedules no offline flip", () => {
    const clock = createFakeClock();
    const h = makeHarness(clock);
    const controller = createConnectionController(h.deps);

    controller.start("test");
    expect(h.sources.length).toBe(1);
    h.sources[0].triggerOpen();
    expect(h.setConnectedCalls).toEqual([true]);

    // Walk well past the grace window to prove no flip is pending.
    clock.advance(10_000);
    expect(h.setConnectedCalls).toEqual([true]);
  });

  test("reopen at 4999ms within grace suppresses setConnected(false)", () => {
    const clock = createFakeClock();
    const h = makeHarness(clock);
    const controller = createConnectionController(h.deps);

    controller.start("test");
    h.sources[0].triggerOpen();
    expect(h.setConnectedCalls).toEqual([true]);

    h.sources[0].triggerError();
    // Sit just inside the grace boundary: the offline flip must not
    // have fired yet.
    clock.advance(OFFLINE_GRACE_MS - 1);
    expect(h.setConnectedCalls).toEqual([true]);

    // Simulate a successful reopen on the live socket before the flip
    // boundary lands. cancelOfflineFlip should clear the pending flip.
    h.sources[0].triggerOpen();
    expect(h.setConnectedCalls).toEqual([true, true]);

    clock.advance(10_000);
    // No false flip ever surfaces.
    expect(h.setConnectedCalls).toEqual([true, true]);
  });

  test("no reopen by 5000ms flips setConnected(false) exactly once", () => {
    const clock = createFakeClock();
    const h = makeHarness(clock);
    const controller = createConnectionController(h.deps);

    controller.start("test");
    h.sources[0].triggerOpen();
    expect(h.setConnectedCalls).toEqual([true]);

    h.sources[0].triggerError();
    clock.advance(OFFLINE_GRACE_MS);
    expect(h.setConnectedCalls).toEqual([true, false]);
  });

  test("after dispose, no callbacks fire", () => {
    const clock = createFakeClock();
    const h = makeHarness(clock);
    const controller = createConnectionController(h.deps);

    controller.start("test");
    h.sources[0].triggerOpen();
    expect(h.setConnectedCalls).toEqual([true]);

    controller.dispose();

    // Anything that arrives after dispose must be silenced.
    h.sources[0].triggerOpen();
    h.sources[0].triggerError();
    clock.advance(10_000);
    expect(h.setConnectedCalls).toEqual([true]);
  });

  test("createEventSource throw logs to console.error, flips offline at grace boundary, then retries on reconnect backoff", () => {
    // Pin the silent-failure-forbidden contract for the synchronous
    // `createEventSource` failure path: the controller must surface the
    // error via console.error (not swallow it), enter the same recovery
    // path as a runtime onerror (offline-flip + reconnect), and, when
    // the reconnect attempt also throws, schedule another reconnect
    // rather than freezing the controller.
    const clock = createFakeClock();
    const setConnectedCalls: boolean[] = [];
    let throwCount = 0;
    const throwingFactory = (_url: string): EventSource => {
      throwCount++;
      throw new Error("simulated EventSource creation failure");
    };

    const deps: ConnectionDeps = {
      setConnected: (v) => {
        setConnectedCalls.push(v);
      },
      createEventSource: throwingFactory,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    // Local console.error spy: swap before start(), restore in finally
    // so a failed assertion does not leak the spy across tests.
    const originalConsoleError = console.error;
    const consoleErrorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      consoleErrorCalls.push(args);
    };

    try {
      const controller = createConnectionController(deps);

      // Act: start triggers a synchronous throw inside the try/catch.
      // The catch arm logs to console.error, schedules the offline flip
      // (dueAt = OFFLINE_GRACE_MS), and schedules a reconnect (dueAt =
      // RECONNECT_BACKOFF_MS).
      controller.start("/test");

      // The throw must be reported, not swallowed, and createEventSource
      // must have been called exactly once (no double-invoke inside the
      // catch).
      expect(throwCount).toBe(1);
      expect(consoleErrorCalls.length).toBeGreaterThanOrEqual(1);
      expect(setConnectedCalls).toEqual([]);

      // Walk to RECONNECT_BACKOFF_MS - 1: neither the reconnect nor the
      // offline flip has fired yet.
      clock.advance(RECONNECT_BACKOFF_MS - 1);
      expect(throwCount).toBe(1);
      expect(setConnectedCalls).toEqual([]);

      // Cross the reconnect boundary at t=RECONNECT_BACKOFF_MS. The
      // reconnect callback calls start() again, which throws a second
      // time. The recovery path inside catch reschedules a reconnect
      // (the existing offline timer is left intact by scheduleOfflineFlip
      // because one is already pending).
      clock.advance(1);
      expect(throwCount).toBe(2);
      expect(setConnectedCalls).toEqual([]);

      // Walk to t=OFFLINE_GRACE_MS to fire the original offline flip.
      // OFFLINE_GRACE_MS - RECONNECT_BACKOFF_MS = 2000ms remaining.
      clock.advance(OFFLINE_GRACE_MS - RECONNECT_BACKOFF_MS);
      expect(setConnectedCalls).toEqual([false]);

      controller.dispose();
    } finally {
      console.error = originalConsoleError;
    }
  });
});
