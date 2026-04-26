import { describe, expect, test } from "bun:test";
import type { SessionsStore } from "../stores/sessionsStore";
import type { TerminalsStore } from "../stores/terminalsStore";
import type { DtachSessionLike, SessionRow } from "../stores/types";
import { describeTerminalToolbarContext, TerminalPane } from "./TerminalPane";
import { TerminalToolbar } from "./TerminalToolbar";

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
    turn: "user-turn",
    lastEventAt: null,
    isAgent: true,
  };
}

function createTerminalsStoreForTest(
  activeId: string,
  dtachSessions: DtachSessionLike[],
): TerminalsStore {
  return {
    dtachSessions: () => dtachSessions,
    activeId: () => activeId,
    pendingActivateId: () => null,
    setDtachSessions() {},
    requestActivate() {},
    setActive() {},
    selectSession() {},
    setViewFor() {},
    getViewFor: (sessionId) => (sessionId === "agent-A" ? "shell" : undefined),
    tryBeginShellSpawn: () => true,
    clearShellSpawnInFlight() {},
    isShellSpawnInFlight: () => false,
  };
}

function createSessionsStoreForTest(rows: SessionRow[]): SessionsStore {
  return {
    rows: () => rows,
    setSessions() {},
  };
}

describe("describeTerminalToolbarContext", () => {
  test("shell-active context keeps the agent row for display and ack while preserving the shell terminal id", () => {
    const context = describeTerminalToolbarContext("shell-agent-A.2", [
      makeRow("agent-A"),
    ]);
    expect(context.contextAgentRow?.id).toBe("agent-A");
    expect(context.ackTargetSessionId).toBe("agent-A");
    expect(context.activeTerminalId).toBe("shell-agent-A.2");
  });
});

describe("TerminalPane", () => {
  test("passes shell-view toolbar context through to TerminalToolbar", () => {
    const tree = TerminalPane({
      terminals: createTerminalsStoreForTest("shell-agent-A.2", [
        {
          name: "agent-A",
          sessionId: "agent-A",
          socketPath: "/socket/agent-A",
          createdAt: 1,
        },
        {
          name: "shell-agent-A.2",
          sessionId: "shell-agent-A.2",
          socketPath: "/socket/shell-agent-A.2",
          createdAt: 2,
        },
      ]),
      sessions: createSessionsStoreForTest([makeRow("agent-A")]),
      wsToken: () => "token",
      onAck: async () => undefined,
      onKillClients: async () => undefined,
      onShellToggle: () => undefined,
    }) as unknown as {
      props: {
        children: [unknown, unknown];
      };
    };

    const toolbarNode = tree.props.children[1] as {
      type: unknown;
      props: {
        contextAgentRow: () => SessionRow | null;
        ackTargetSessionId: () => string | null;
        activeTerminalId: () => string | null;
      };
    };

    expect(toolbarNode.type).toBe(TerminalToolbar);
    expect(toolbarNode.props.contextAgentRow()?.id).toBe("agent-A");
    expect(toolbarNode.props.ackTargetSessionId()).toBe("agent-A");
    expect(toolbarNode.props.activeTerminalId()).toBe("shell-agent-A.2");
  });
});
