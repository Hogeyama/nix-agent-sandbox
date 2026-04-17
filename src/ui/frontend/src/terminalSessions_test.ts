import { expect, test } from "bun:test";
import type { ContainerInfo, DtachSession } from "./api.ts";
import {
  buildTerminalSessionTabs,
  parseShellSessionId,
} from "./terminalSessions.ts";

function makeDtachSession(sessionId: string): DtachSession {
  return {
    name: sessionId,
    sessionId,
    socketPath: `/tmp/${sessionId}.sock`,
    createdAt: 1,
  };
}

function makeContainer(
  sessionId: string,
  overrides: Partial<ContainerInfo> = {},
): ContainerInfo & { sessionId: string } {
  return {
    name: `nas-agent-${sessionId}`,
    running: true,
    labels: {},
    startedAt: "2026-04-10T00:00:00.000Z",
    sessionId,
    ...overrides,
  };
}

test("buildTerminalSessionTabs keeps live dtach sessions even without container metadata", () => {
  const result = buildTerminalSessionTabs(
    ["sess-live"],
    [makeDtachSession("sess-live")],
    [],
  );

  expect(result).toEqual([
    {
      sessionId: "sess-live",
      sessionName: undefined,
      canAckTurn: false,
      turnAcked: false,
      isOpen: true,
      kind: "agent",
    },
  ]);
});

test("buildTerminalSessionTabs overlays container metadata when available", () => {
  const result = buildTerminalSessionTabs(
    ["sess-1"],
    [makeDtachSession("sess-1")],
    [
      makeContainer("sess-1", {
        sessionName: "review",
        turn: "user-turn",
      }),
    ],
  );

  expect(result).toEqual([
    {
      sessionId: "sess-1",
      sessionName: "review",
      canAckTurn: true,
      turnAcked: false,
      isOpen: true,
      kind: "agent",
    },
  ]);
});

test("buildTerminalSessionTabs labels shell session with parent name + seq", () => {
  const result = buildTerminalSessionTabs(
    ["shell-sess-1.1"],
    [makeDtachSession("shell-sess-1.1")],
    [makeContainer("sess-1", { sessionName: "review" })],
  );

  expect(result).toEqual([
    {
      sessionId: "shell-sess-1.1",
      sessionName: "review (shell#1)",
      canAckTurn: false,
      turnAcked: false,
      isOpen: true,
      kind: "shell",
      parentSessionId: "sess-1",
      shellSeq: 1,
    },
  ]);
});

test("buildTerminalSessionTabs falls back to parent sessionId when parent has no sessionName", () => {
  const result = buildTerminalSessionTabs(
    ["shell-sess-1.2"],
    [makeDtachSession("shell-sess-1.2")],
    [],
  );

  expect(result).toEqual([
    {
      sessionId: "shell-sess-1.2",
      sessionName: "sess-1 (shell#2)",
      canAckTurn: false,
      turnAcked: false,
      isOpen: true,
      kind: "shell",
      parentSessionId: "sess-1",
      shellSeq: 2,
    },
  ]);
});

test("buildTerminalSessionTabs shows new shell session as not open", () => {
  const result = buildTerminalSessionTabs(
    [],
    [makeDtachSession("shell-sess-1.1")],
    [],
  );

  expect(result[0]?.isOpen).toBe(false);
  expect(result[0]?.kind).toBe("shell");
});

test("buildTerminalSessionTabs mixes shell and agent sessions with parent linkage", () => {
  const result = buildTerminalSessionTabs(
    ["sess-agent", "shell-sess-agent.1"],
    [
      makeDtachSession("sess-agent"),
      makeDtachSession("shell-sess-agent.1"),
      makeDtachSession("shell-sess-agent.2"),
    ],
    [
      makeContainer("sess-agent", {
        sessionName: "my-agent",
        turn: "agent-turn",
      }),
    ],
  );

  expect(result).toEqual([
    {
      sessionId: "sess-agent",
      sessionName: "my-agent",
      canAckTurn: false,
      turnAcked: false,
      isOpen: true,
      kind: "agent",
    },
    {
      sessionId: "shell-sess-agent.1",
      sessionName: "my-agent (shell#1)",
      canAckTurn: false,
      turnAcked: false,
      isOpen: true,
      kind: "shell",
      parentSessionId: "sess-agent",
      shellSeq: 1,
    },
    {
      sessionId: "shell-sess-agent.2",
      sessionName: "my-agent (shell#2)",
      canAckTurn: false,
      turnAcked: false,
      isOpen: false,
      kind: "shell",
      parentSessionId: "sess-agent",
      shellSeq: 2,
    },
  ]);
});

test("buildTerminalSessionTabs drops tabs whose dtach session is gone", () => {
  const result = buildTerminalSessionTabs(
    ["sess-gone", "sess-live"],
    [makeDtachSession("sess-live"), makeDtachSession("sess-next")],
    [],
  );

  expect(result.map((session) => session.sessionId)).toEqual([
    "sess-live",
    "sess-next",
  ]);
  expect(result[0].isOpen).toBe(true);
  expect(result[1].isOpen).toBe(false);
});

test("parseShellSessionId parses well-formed ids", () => {
  expect(parseShellSessionId("shell-abc.1")).toEqual({
    parentSessionId: "abc",
    seq: 1,
  });
  expect(parseShellSessionId("shell-2026-04-17T12-18-49-960Z.3")).toEqual({
    parentSessionId: "2026-04-17T12-18-49-960Z",
    seq: 3,
  });
});

test("parseShellSessionId rejects non-shell ids", () => {
  expect(parseShellSessionId("sess-1")).toBeNull();
  expect(parseShellSessionId("shell-abc")).toBeNull();
  expect(parseShellSessionId("shell-abc.")).toBeNull();
  expect(parseShellSessionId("shell-.1")).toBeNull();
  expect(parseShellSessionId("shell-abc.0")).toBeNull();
  expect(parseShellSessionId("shell-abc.xyz")).toBeNull();
});
