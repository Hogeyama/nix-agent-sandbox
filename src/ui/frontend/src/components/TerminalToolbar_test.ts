import { describe, expect, test } from "bun:test";
import type { SessionRow } from "../stores/types";
import { EditableSessionName } from "./EditableSessionName";
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

type TerminalToolbarTree = {
  props: {
    children: [
      {
        props: {
          children: (row: () => SessionRow) => {
            props: {
              children: [
                unknown,
                {
                  type: typeof EditableSessionName;
                  props: {
                    currentName: string;
                    onSubmit: (next: string) => Promise<void>;
                    renderIdle: (api: {
                      start: () => void;
                      currentName: string;
                    }) => {
                      type: string;
                      props: {
                        class: string;
                        title: string;
                        onDblClick: () => void;
                        children: string;
                      };
                    };
                  };
                },
                unknown,
                unknown,
              ];
            };
          };
        };
      },
      ...unknown[],
    ];
  };
};

describe("TerminalToolbar", () => {
  test("wires the toolbar name slot to double-click rename and agent-scoped submit", async () => {
    const row = makeRow("agent-A");
    const renameCalls: [string, string][] = [];
    const tree = TerminalToolbar({
      contextAgentRow: () => row,
      ackTargetSessionId: () => row.id,
      activeTerminalHandle: () => null,
      activeTerminalId: () => row.id,
      viewFor: () => "agent",
      shellSpawnInFlight: () => false,
      onAck: async () => undefined,
      onKillClients: async () => undefined,
      onRename: async (sessionId, name) => {
        renameCalls.push([sessionId, name]);
      },
      onShellToggle: () => undefined,
    }) as unknown as TerminalToolbarTree;

    const context = tree.props.children[0].props.children(() => row);
    const editable = context.props.children[1];
    let starts = 0;
    const idle = editable.props.renderIdle({
      start: () => {
        starts += 1;
      },
      currentName: row.name,
    });

    expect(editable.type).toBe(EditableSessionName);
    expect(editable.props.currentName).toBe(row.name);
    expect(idle.type).toBe("button");
    expect(idle.props.class).toBe("name");
    expect(idle.props.title).toBe("Double-click to rename");

    idle.props.onDblClick();
    expect(starts).toBe(1);

    await editable.props.onSubmit("renamed");
    expect(renameCalls).toEqual([["agent-A", "renamed"]]);
  });
});
