import { expect, test } from "bun:test";
import type { ContainerInfo, DtachSession } from "./api.ts";
import { buildTerminalSessionTabs } from "./terminalSessions.ts";

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
