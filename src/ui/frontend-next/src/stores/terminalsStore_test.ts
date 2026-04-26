import { describe, expect, test } from "bun:test";
import { createTerminalsStore } from "./terminalsStore";
import type { DtachSessionLike } from "./types";

function makeDtach(
  overrides: Partial<DtachSessionLike> = {},
): DtachSessionLike {
  return {
    name: "term",
    sessionId: "s_default",
    socketPath: "/tmp/nas/term.sock",
    createdAt: 0,
    ...overrides,
  };
}

describe("createTerminalsStore", () => {
  test("starts empty with no active or pending selection", () => {
    const store = createTerminalsStore();
    expect(store.dtachSessions()).toEqual([]);
    expect(store.activeId()).toBeNull();
    expect(store.pendingActivateId()).toBeNull();
  });

  test("setDtachSessions replaces the dtach list", () => {
    const store = createTerminalsStore();
    const s1 = makeDtach({ sessionId: "s1" });
    const s2 = makeDtach({ sessionId: "s2" });
    store.setDtachSessions([s1, s2]);
    expect(store.dtachSessions()).toHaveLength(2);
    expect(store.dtachSessions()[0]?.sessionId).toBe("s1");
    expect(store.dtachSessions()[1]?.sessionId).toBe("s2");
  });

  test("requestActivate stashes id as pending when not yet in dtach list", () => {
    const store = createTerminalsStore();
    store.requestActivate("s1");
    expect(store.activeId()).toBeNull();
    expect(store.pendingActivateId()).toBe("s1");
  });

  test("setDtachSessions promotes pending to active when sessionId arrives", () => {
    const store = createTerminalsStore();
    store.requestActivate("s1");
    store.setDtachSessions([makeDtach({ sessionId: "s1" })]);
    expect(store.activeId()).toBe("s1");
    expect(store.pendingActivateId()).toBeNull();
  });

  test("pending is preserved when snapshot arrives without the requested id", () => {
    const store = createTerminalsStore();
    store.requestActivate("s1");
    store.setDtachSessions([makeDtach({ sessionId: "s2" })]);
    expect(store.activeId()).toBeNull();
    expect(store.pendingActivateId()).toBe("s1");
  });

  test("setActive sets activeId directly regardless of dtach list contents", () => {
    const store = createTerminalsStore();
    store.setActive("s1");
    expect(store.activeId()).toBe("s1");
    expect(store.dtachSessions()).toEqual([]);
  });

  test("setDtachSessions clears activeId when its session is no longer present", () => {
    const store = createTerminalsStore();
    store.setActive("s1");
    store.setDtachSessions([]);
    expect(store.activeId()).toBeNull();
  });

  test("consecutive requestActivate calls overwrite pending with the latest intent", () => {
    const store = createTerminalsStore();
    store.requestActivate("a");
    store.requestActivate("b");
    expect(store.pendingActivateId()).toBe("b");
    expect(store.activeId()).toBeNull();
  });

  test("requestActivate clears stale pending when the new id is already present", () => {
    const store = createTerminalsStore();
    store.requestActivate("a");
    store.setDtachSessions([makeDtach({ sessionId: "b" })]);
    store.requestActivate("b");
    expect(store.activeId()).toBe("b");
    expect(store.pendingActivateId()).toBeNull();
  });

  test("pending wins over an existing activeId that disappears in the same snapshot", () => {
    const store = createTerminalsStore();
    store.setActive("a");
    store.requestActivate("b");
    store.setDtachSessions([makeDtach({ sessionId: "b" })]);
    expect(store.activeId()).toBe("b");
    expect(store.pendingActivateId()).toBeNull();
  });
});
