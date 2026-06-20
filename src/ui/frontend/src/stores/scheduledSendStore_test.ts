/**
 * Tests for `scheduledSendStore`.
 *
 * Verifies the reactive wiring: add inserts entries, remove deletes
 * them, and count reflects the current length.
 */

import { describe, expect, test } from "bun:test";
import { createScheduledSendStore } from "./scheduledSendStore";

function makeStore() {
  let idSeq = 0;
  const fixedNow = new Date("2026-06-20T10:00:00.000Z");
  return createScheduledSendStore({
    generateId: () => `id-${++idSeq}`,
    now: () => fixedNow,
  });
}

describe("scheduledSendStore", () => {
  test("starts empty", () => {
    const store = makeStore();
    expect(store.entries()).toEqual([]);
    expect(store.count()).toBe(0);
  });

  test("add inserts an entry and returns its id", () => {
    const store = makeStore();
    const scheduledAt = new Date("2026-06-20T12:00:00.000Z");

    const id = store.add("hello", scheduledAt);

    expect(id).toBe("id-1");
    expect(store.entries()).toEqual([
      {
        id: "id-1",
        message: "hello",
        scheduledAt,
        createdAt: new Date("2026-06-20T10:00:00.000Z"),
      },
    ]);
    expect(store.count()).toBe(1);
  });

  test("add appends multiple entries in order", () => {
    const store = makeStore();
    const t1 = new Date("2026-06-20T11:00:00.000Z");
    const t2 = new Date("2026-06-20T12:00:00.000Z");

    store.add("first", t1);
    store.add("second", t2);

    const entries = store.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.message).toBe("first");
    expect(entries[1]!.message).toBe("second");
    expect(store.count()).toBe(2);
  });

  test("remove deletes the entry with the given id", () => {
    const store = makeStore();
    const t = new Date("2026-06-20T11:00:00.000Z");

    const id1 = store.add("keep", t);
    const id2 = store.add("drop", t);

    store.remove(id2);

    expect(store.entries()).toHaveLength(1);
    expect(store.entries()[0]!.id).toBe(id1);
    expect(store.count()).toBe(1);
  });

  test("remove with a non-existent id is a no-op", () => {
    const store = makeStore();
    store.add("msg", new Date("2026-06-20T11:00:00.000Z"));

    store.remove("no-such-id");

    expect(store.entries()).toHaveLength(1);
    expect(store.count()).toBe(1);
  });

  test("count reflects additions and removals", () => {
    const store = makeStore();
    const t = new Date("2026-06-20T11:00:00.000Z");

    expect(store.count()).toBe(0);

    const id1 = store.add("a", t);
    expect(store.count()).toBe(1);

    store.add("b", t);
    expect(store.count()).toBe(2);

    store.remove(id1);
    expect(store.count()).toBe(1);
  });
});
