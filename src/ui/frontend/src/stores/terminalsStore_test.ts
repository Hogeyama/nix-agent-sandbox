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

  test("selectSession delegates to setActive when no shell view is recorded", () => {
    const store = createTerminalsStore();
    store.selectSession("s1");
    expect(store.activeId()).toBe("s1");
  });

  test("pending wins over an existing activeId that disappears in the same snapshot", () => {
    const store = createTerminalsStore();
    store.setActive("a");
    store.requestActivate("b");
    store.setDtachSessions([makeDtach({ sessionId: "b" })]);
    expect(store.activeId()).toBe("b");
    expect(store.pendingActivateId()).toBeNull();
  });

  test("setViewFor / getViewFor round-trip the per-agent view position", () => {
    const store = createTerminalsStore();
    expect(store.getViewFor("agent-A")).toBeUndefined();
    store.setViewFor("agent-A", "shell");
    expect(store.getViewFor("agent-A")).toBe("shell");
    store.setViewFor("agent-A", "agent");
    expect(store.getViewFor("agent-A")).toBe("agent");
  });

  test("selectSession routes to the live shell id when the recorded view is shell", () => {
    const store = createTerminalsStore();
    store.setDtachSessions([
      makeDtach({ sessionId: "agent-A" }),
      makeDtach({ sessionId: "shell-agent-A.1" }),
    ]);
    store.setViewFor("agent-A", "shell");
    store.selectSession("agent-A");
    expect(store.activeId()).toBe("shell-agent-A.1");
  });

  test("selectSession falls back to agent and resets the view when no live shell exists", () => {
    const store = createTerminalsStore();
    store.setDtachSessions([makeDtach({ sessionId: "agent-A" })]);
    store.setViewFor("agent-A", "shell");
    store.selectSession("agent-A");
    expect(store.activeId()).toBe("agent-A");
    expect(store.getViewFor("agent-A")).toBe("agent");
  });

  test("setDtachSessions drops view entries for agents that are no longer in the snapshot", () => {
    const store = createTerminalsStore();
    store.setDtachSessions([makeDtach({ sessionId: "agent-A" })]);
    store.setViewFor("agent-A", "shell");
    store.setDtachSessions([]);
    expect(store.getViewFor("agent-A")).toBeUndefined();
  });

  test("setDtachSessions reverts view to agent and re-attaches when the active shell exits", () => {
    const store = createTerminalsStore();
    store.setDtachSessions([
      makeDtach({ sessionId: "agent-A" }),
      makeDtach({ sessionId: "shell-agent-A.1" }),
    ]);
    store.setViewFor("agent-A", "shell");
    store.setActive("shell-agent-A.1");
    // Shell exits; agent is still live.
    store.setDtachSessions([makeDtach({ sessionId: "agent-A" })]);
    expect(store.getViewFor("agent-A")).toBe("agent");
    expect(store.activeId()).toBe("agent-A");
  });

  test("inFlightShellSpawn guards a second startShell while the first is in flight", () => {
    const store = createTerminalsStore();
    expect(store.isShellSpawnInFlight("agent-A")).toBe(false);
    expect(store.tryBeginShellSpawn("agent-A")).toBe(true);
    expect(store.isShellSpawnInFlight("agent-A")).toBe(true);
    expect(store.tryBeginShellSpawn("agent-A")).toBe(false);
    // Another agent is independently allowed to spawn.
    expect(store.tryBeginShellSpawn("agent-B")).toBe(true);
    store.clearShellSpawnInFlight("agent-A");
    expect(store.isShellSpawnInFlight("agent-A")).toBe(false);
    expect(store.tryBeginShellSpawn("agent-A")).toBe(true);
  });
});
