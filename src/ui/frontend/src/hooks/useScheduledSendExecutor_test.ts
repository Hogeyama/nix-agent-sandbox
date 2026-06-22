import { describe, expect, mock, test } from "bun:test";
import type { ScheduledSendStore } from "../stores/scheduledSendStore";
import type { TerminalHandle } from "../terminal/attachTerminalSession";
import type { ScheduledSend } from "../terminal/scheduledSendLogic";
import { useScheduledSendExecutor } from "./useScheduledSendExecutor";

/** Build a minimal fake `TerminalHandle` with a spyable `sendInput`. */
function makeFakeHandle(): TerminalHandle & {
  sendInputSpy: ReturnType<typeof mock>;
} {
  const sendInputSpy = mock((_text: string) => {});
  return {
    focus() {},
    refit() {},
    setFontSize() {},
    getMouseTrackingMode() {
      return "unknown" as const;
    },
    isMouseModeForced() {
      return false;
    },
    forceMouseModeOn() {},
    resetMouseMode() {},
    nudge() {},
    sendInput: sendInputSpy as (text: string) => void,
    dispose() {},
    search: { findNext() {}, findPrevious() {}, clear() {} },
    sendInputSpy,
  };
}

/**
 * Build a fake `ScheduledSendStore` backed by a plain array.
 * No Solid signals needed — the executor only calls `entries()` and
 * `remove()`.
 */
function makeFakeStore(initial: ScheduledSend[] = []): ScheduledSendStore & {
  _entries: ScheduledSend[];
} {
  const state = { _entries: [...initial] };
  return {
    get _entries() {
      return state._entries;
    },
    entries() {
      return [...state._entries];
    },
    add(sessionId: string, message: string, scheduledAt: Date): string {
      const id = crypto.randomUUID();
      state._entries.push({
        id,
        sessionId,
        message,
        scheduledAt,
        createdAt: new Date(),
      });
      return id;
    },
    remove(id: string) {
      state._entries = state._entries.filter((e) => e.id !== id);
    },
    count() {
      return state._entries.length;
    },
  };
}

function makeEntry(
  overrides: Partial<ScheduledSend> & { id: string },
): ScheduledSend {
  return {
    sessionId: "sess-1",
    message: "hello",
    scheduledAt: new Date("2026-01-01T10:00:00Z"),
    createdAt: new Date("2026-01-01T09:00:00Z"),
    ...overrides,
  };
}

describe("useScheduledSendExecutor", () => {
  test("sends input and removes entry when scheduled time is due", async () => {
    const entry = makeEntry({
      id: "e1",
      message: "run tests",
      scheduledAt: new Date("2026-01-01T10:00:00Z"),
    });
    const store = makeFakeStore([entry]);
    const handle = makeFakeHandle();

    const { dispose } = useScheduledSendExecutor({
      store,
      getHandle: () => handle,
      intervalMs: 10,
      now: () => new Date("2026-01-01T10:00:01Z"),
    });

    // Wait for at least one interval tick
    await new Promise((resolve) => setTimeout(resolve, 50));
    dispose();

    expect(handle.sendInputSpy).toHaveBeenCalled();
    expect(handle.sendInputSpy.mock.calls[0][0]).toBe("run tests\r");
    expect(store._entries).toEqual([]);
  });

  test("appends trailing newline to sent message", async () => {
    const entry = makeEntry({
      id: "e1",
      message: "deploy",
      scheduledAt: new Date("2026-01-01T10:00:00Z"),
    });
    const store = makeFakeStore([entry]);
    const handle = makeFakeHandle();

    const { dispose } = useScheduledSendExecutor({
      store,
      getHandle: () => handle,
      intervalMs: 10,
      now: () => new Date("2026-01-01T10:00:01Z"),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    dispose();

    expect(handle.sendInputSpy.mock.calls[0][0]).toBe("deploy\r");
  });

  test("removes entry from store after sending", async () => {
    const entry1 = makeEntry({
      id: "e1",
      message: "first",
      scheduledAt: new Date("2026-01-01T10:00:00Z"),
    });
    const entry2 = makeEntry({
      id: "e2",
      message: "second",
      scheduledAt: new Date("2026-01-01T11:00:00Z"),
    });
    const store = makeFakeStore([entry1, entry2]);
    const handle = makeFakeHandle();

    // Clock is past e1 but before e2
    const { dispose } = useScheduledSendExecutor({
      store,
      getHandle: () => handle,
      intervalMs: 10,
      now: () => new Date("2026-01-01T10:30:00Z"),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    dispose();

    // e1 should be removed, e2 should remain
    expect(store._entries.length).toBe(1);
    expect(store._entries[0].id).toBe("e2");
  });

  test("skips when handle is null and does not remove entries", async () => {
    const entry = makeEntry({
      id: "e1",
      message: "should stay",
      scheduledAt: new Date("2026-01-01T10:00:00Z"),
    });
    const store = makeFakeStore([entry]);

    const { dispose } = useScheduledSendExecutor({
      store,
      getHandle: () => null,
      intervalMs: 10,
      now: () => new Date("2026-01-01T10:00:01Z"),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    dispose();

    // Entry should still be present
    expect(store._entries.length).toBe(1);
    expect(store._entries[0].id).toBe("e1");
  });

  test("dispose clears the interval so no further ticks fire", async () => {
    const entry = makeEntry({
      id: "e1",
      message: "late",
      scheduledAt: new Date("2026-01-01T10:00:00Z"),
    });
    const store = makeFakeStore([entry]);
    const handle = makeFakeHandle();

    let clockTime = new Date("2026-01-01T09:59:00Z");
    const { dispose } = useScheduledSendExecutor({
      store,
      getHandle: () => handle,
      intervalMs: 10,
      now: () => clockTime,
    });

    // Wait one tick — entry is not yet due
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handle.sendInputSpy).not.toHaveBeenCalled();

    // Dispose before advancing the clock
    dispose();

    // Advance clock past due time
    clockTime = new Date("2026-01-01T10:00:01Z");

    // Wait to confirm no further ticks fire
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handle.sendInputSpy).not.toHaveBeenCalled();

    // Entry should still be in the store (never sent)
    expect(store._entries.length).toBe(1);
  });

  test("sends each entry to its own session handle", async () => {
    const handleA = makeFakeHandle();
    const handleB = makeFakeHandle();
    const handles = new Map([
      ["sess-a", handleA],
      ["sess-b", handleB],
    ]);

    const entryA = makeEntry({
      id: "ea",
      sessionId: "sess-a",
      message: "for A",
      scheduledAt: new Date("2026-01-01T10:00:00Z"),
    });
    const entryB = makeEntry({
      id: "eb",
      sessionId: "sess-b",
      message: "for B",
      scheduledAt: new Date("2026-01-01T10:00:00Z"),
    });
    const store = makeFakeStore([entryA, entryB]);

    const { dispose } = useScheduledSendExecutor({
      store,
      getHandle: (sid) => handles.get(sid) ?? null,
      intervalMs: 10,
      now: () => new Date("2026-01-01T10:00:01Z"),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    dispose();

    expect(handleA.sendInputSpy).toHaveBeenCalled();
    expect(handleA.sendInputSpy.mock.calls[0][0]).toBe("for A\r");
    expect(handleB.sendInputSpy).toHaveBeenCalled();
    expect(handleB.sendInputSpy.mock.calls[0][0]).toBe("for B\r");
    expect(store._entries).toEqual([]);
  });

  test("skips entry whose session handle is missing but sends others", async () => {
    const handleA = makeFakeHandle();

    const entryA = makeEntry({
      id: "ea",
      sessionId: "sess-a",
      message: "for A",
      scheduledAt: new Date("2026-01-01T10:00:00Z"),
    });
    const entryGone = makeEntry({
      id: "eg",
      sessionId: "sess-gone",
      message: "orphan",
      scheduledAt: new Date("2026-01-01T10:00:00Z"),
    });
    const store = makeFakeStore([entryA, entryGone]);

    const { dispose } = useScheduledSendExecutor({
      store,
      getHandle: (sid) => (sid === "sess-a" ? handleA : null),
      intervalMs: 10,
      now: () => new Date("2026-01-01T10:00:01Z"),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    dispose();

    expect(handleA.sendInputSpy).toHaveBeenCalled();
    expect(handleA.sendInputSpy.mock.calls[0][0]).toBe("for A\r");
    expect(store._entries.length).toBe(1);
    expect(store._entries[0].id).toBe("eg");
  });

  test("does not send entries that are not yet due", async () => {
    const entry = makeEntry({
      id: "e1",
      message: "future",
      scheduledAt: new Date("2026-01-01T12:00:00Z"),
    });
    const store = makeFakeStore([entry]);
    const handle = makeFakeHandle();

    const { dispose } = useScheduledSendExecutor({
      store,
      getHandle: () => handle,
      intervalMs: 10,
      now: () => new Date("2026-01-01T10:00:00Z"),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    dispose();

    expect(handle.sendInputSpy).not.toHaveBeenCalled();
    expect(store._entries.length).toBe(1);
  });
});
