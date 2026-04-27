import { describe, expect, test } from "bun:test";
import {
  describeShellToggle,
  findShellForAgent,
  reconcileViewState,
  resolveContextAgentRow,
} from "./shellMapping";
import type { DtachSessionLike, SessionRow } from "./types";

function makeDtach(sessionId: string): DtachSessionLike {
  return {
    name: "term",
    sessionId,
    socketPath: `/tmp/nas/${sessionId}.sock`,
    createdAt: 0,
  };
}

function makeRow(id: string): SessionRow {
  return {
    id,
    shortId: `short-${id}`,
    name: `name-${id}`,
    containerName: `container-${id}`,
    dir: null,
    profile: null,
    worktreeName: null,
    baseBranch: null,
    turn: null,
    lastEventAt: null,
    isAgent: true,
  };
}

describe("resolveContextAgentRow", () => {
  test("returns the active agent row when activeId is an agent session id", () => {
    const row = makeRow("agent-A");
    expect(resolveContextAgentRow("agent-A", [row])).toBe(row);
  });

  test("returns the parent agent row when activeId is a shell session id", () => {
    const row = makeRow("agent-A");
    expect(resolveContextAgentRow("shell-agent-A.2", [row])).toBe(row);
  });

  test("returns null when a shell session's parent row is absent", () => {
    expect(resolveContextAgentRow("shell-agent-A.2", [])).toBeNull();
  });
});

describe("findShellForAgent", () => {
  test("returns null when the dtach list is empty", () => {
    expect(findShellForAgent("agent-A", [])).toBeNull();
  });

  test("returns null when no entry parses as a shell for the requested agent", () => {
    expect(findShellForAgent("agent-A", [makeDtach("agent-B")])).toBeNull();
  });

  test("returns the matching shell when seq=1", () => {
    const shells = [makeDtach("shell-agent-A.1")];
    expect(findShellForAgent("agent-A", shells)).toEqual({
      sessionId: "shell-agent-A.1",
      parentSessionId: "agent-A",
      seq: 1,
    });
  });

  test("returns the highest-seq shell when multiple exist for the same agent", () => {
    const shells = [
      makeDtach("shell-agent-A.1"),
      makeDtach("shell-agent-A.3"),
      makeDtach("shell-agent-A.2"),
    ];
    expect(findShellForAgent("agent-A", shells)?.seq).toBe(3);
  });

  test("ignores entries that do not match the shell-id grammar", () => {
    const shells = [makeDtach("agent-A"), makeDtach("agent-B")];
    expect(findShellForAgent("agent-A", shells)).toBeNull();
  });

  test("ignores shells parented to a different agent", () => {
    const shells = [makeDtach("shell-agent-B.1")];
    expect(findShellForAgent("agent-A", shells)).toBeNull();
  });
});

describe("describeShellToggle", () => {
  test("agent view, idle: opens shell and shows AGENT badge", () => {
    expect(describeShellToggle("agent", false)).toEqual({
      label: "Open shell",
      disabled: false,
      currentBadge: "AGENT",
    });
  });

  test("shell view, idle: returns to agent and shows SHELL badge", () => {
    expect(describeShellToggle("shell", false)).toEqual({
      label: "Return to agent",
      disabled: false,
      currentBadge: "SHELL",
    });
  });

  test("in-flight spawn: label Spawning…, disabled, badge fixed to AGENT", () => {
    expect(describeShellToggle("agent", true)).toEqual({
      label: "Spawning…",
      disabled: true,
      currentBadge: "AGENT",
    });
    expect(describeShellToggle("shell", true)).toEqual({
      label: "Spawning…",
      disabled: true,
      currentBadge: "AGENT",
    });
  });
});

describe("reconcileViewState", () => {
  test("drops entries for agents that are no longer alive", () => {
    const result = reconcileViewState({
      prevView: { "agent-A": "shell", "agent-B": "agent" },
      agentSessionIds: new Set(["agent-B"]),
      dtachSessions: [],
    });
    expect(result.nextView).toEqual({ "agent-B": "agent" });
    expect(result.shellsExited).toEqual([]);
  });

  test("forces view to agent when the backing shell exits and reports the agent id", () => {
    const result = reconcileViewState({
      prevView: { "agent-A": "shell" },
      agentSessionIds: new Set(["agent-A"]),
      dtachSessions: [makeDtach("agent-A")],
    });
    expect(result.nextView).toEqual({ "agent-A": "agent" });
    expect(result.shellsExited).toEqual(["agent-A"]);
  });

  test("preserves shell view when the backing shell is still in the snapshot", () => {
    const result = reconcileViewState({
      prevView: { "agent-A": "shell" },
      agentSessionIds: new Set(["agent-A"]),
      dtachSessions: [makeDtach("agent-A"), makeDtach("shell-agent-A.1")],
    });
    expect(result.nextView).toEqual({ "agent-A": "shell" });
    expect(result.shellsExited).toEqual([]);
  });

  test("leaves an unrelated snapshot identity-equal in content", () => {
    const prev = { "agent-A": "agent" } as const;
    const result = reconcileViewState({
      prevView: prev,
      agentSessionIds: new Set(["agent-A"]),
      dtachSessions: [makeDtach("agent-A")],
    });
    expect(result.nextView).toEqual({ "agent-A": "agent" });
    expect(result.shellsExited).toEqual([]);
  });
});
