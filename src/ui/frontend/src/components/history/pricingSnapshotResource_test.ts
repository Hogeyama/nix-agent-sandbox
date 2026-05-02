import { describe, expect, test } from "bun:test";
import type { PricingSnapshot } from "../../api/client";
import {
  fetchPricingSnapshotOrUnavailable,
  PRICING_SNAPSHOT_REFRESH_MS,
  startPricingSnapshotPolling,
} from "./pricingSnapshotResource";

interface FakeClock {
  setInterval: (cb: () => void, ms: number) => number;
  clearInterval: (handle: unknown) => void;
  advance: (ms: number) => void;
}

function createFakeClock(): FakeClock {
  interface Task {
    handle: number;
    dueAt: number;
    everyMs: number;
    cb: () => void;
    cancelled: boolean;
  }

  let now = 0;
  let nextHandle = 1;
  const tasks: Task[] = [];

  return {
    setInterval(cb, ms) {
      const task: Task = {
        handle: nextHandle++,
        dueAt: now + ms,
        everyMs: ms,
        cb,
        cancelled: false,
      };
      tasks.push(task);
      return task.handle;
    },
    clearInterval(handle) {
      for (const task of tasks) {
        if (task.handle === handle) task.cancelled = true;
      }
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        let next: Task | undefined;
        for (const task of tasks) {
          if (task.cancelled) continue;
          if (task.dueAt > target) continue;
          if (next === undefined || task.dueAt < next.dueAt) next = task;
        }
        if (next === undefined) break;
        now = next.dueAt;
        next.dueAt += next.everyMs;
        next.cb();
      }
      now = target;
    },
  };
}

function snapshot(
  fetchedAt: string,
  overrides: Partial<PricingSnapshot> = {},
): PricingSnapshot {
  return {
    fetched_at: fetchedAt,
    source: "litellm",
    stale: false,
    models: {},
    ...overrides,
  };
}

describe("startPricingSnapshotPolling", () => {
  test("refetches on the pricing interval and stops after cleanup", () => {
    const clock = createFakeClock();
    const calls: number[] = [];
    const stop = startPricingSnapshotPolling(
      () => {
        calls.push(calls.length + 1);
      },
      {
        setInterval: clock.setInterval,
        clearInterval: clock.clearInterval,
      },
    );

    expect(calls).toHaveLength(0);

    clock.advance(PRICING_SNAPSHOT_REFRESH_MS - 1);
    expect(calls).toHaveLength(0);

    clock.advance(1);
    expect(calls).toEqual([1]);

    clock.advance(PRICING_SNAPSHOT_REFRESH_MS);
    expect(calls).toEqual([1, 2]);

    stop();
    clock.advance(PRICING_SNAPSHOT_REFRESH_MS);
    expect(calls).toEqual([1, 2]);
  });
});

describe("fetchPricingSnapshotOrUnavailable", () => {
  test("returns the fetched pricing snapshot on success", async () => {
    const fetched = snapshot("2026-05-02T00:00:00.000Z", { stale: true });

    const result = await fetchPricingSnapshotOrUnavailable({
      fetchSnapshot: async () => fetched,
      warn: () => undefined,
    });

    expect(result).toBe(fetched);
  });

  test("returns the unavailable sentinel when the pricing fetch rejects", async () => {
    const warnings: unknown[][] = [];

    const result = await fetchPricingSnapshotOrUnavailable({
      fetchSnapshot: async () => {
        throw new Error("daemon unavailable");
      },
      warn: (...args: unknown[]) => warnings.push(args),
    });

    expect(result.source).toBe("unavailable");
    expect(result.stale).toBe(true);
    expect(result.models).toEqual({});
    expect(warnings).toHaveLength(1);
  });
});
