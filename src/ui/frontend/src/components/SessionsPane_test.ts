import { describe, expect, mock, test } from "bun:test";
import type { SessionRow } from "../stores/types";
import { EditableSessionName } from "./EditableSessionName";
import { SessionsPane } from "./SessionsPane";

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

type SessionsPaneTree = {
  props: {
    children: [
      unknown,
      {
        props: {
          children: {
            props: {
              children: (row: SessionRow) => {
                props: {
                  onClick: (e: {
                    target: { closest(selector: string): Element | null };
                  }) => void;
                  onKeyDown: (e: {
                    key: string;
                    preventDefault(): void;
                    target: { closest(selector: string): Element | null };
                  }) => void;
                  children: [
                    unknown,
                    {
                      props: {
                        children: [
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
                                  type: string;
                                  class: string;
                                  "aria-label": string;
                                  title: string;
                                  onClick: (e: {
                                    detail: number;
                                    stopPropagation(): void;
                                  }) => void;
                                  onDblClick: (e: {
                                    stopPropagation(): void;
                                  }) => void;
                                  onKeyDown: (e: {
                                    key: string;
                                    preventDefault(): void;
                                    stopPropagation(): void;
                                  }) => void;
                                  children: string;
                                };
                              };
                            };
                          },
                          ...unknown[],
                        ];
                      };
                    },
                    ...unknown[],
                  ];
                };
              };
            };
          };
        };
      },
    ];
  };
};

describe("SessionsPane", () => {
  test("wires the title idle slot to double-click and keyboard rename", () => {
    const row = makeRow("agent-A");
    const tree = SessionsPane({
      sessions: () => [row],
      activeId: () => null,
      onSelect: () => undefined,
      onRename: async () => undefined,
      pendingFor: () => ({ network: 0, hostexec: 0 }),
      homeDir: () => null,
    }) as unknown as SessionsPaneTree;

    const sessionRow =
      tree.props.children[1].props.children.props.children(row);
    const editable = sessionRow.props.children[1].props.children[0];
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
    expect(idle.props.type).toBe("button");
    expect(idle.props.class).toBe("session-title");
    expect(idle.props["aria-label"]).toBe(
      `Rename session ${row.name}. Press Enter or Space, or double-click, to rename`,
    );

    const dblclickStop = mock(() => undefined);
    idle.props.onDblClick({ stopPropagation: dblclickStop });
    expect(dblclickStop).toHaveBeenCalledTimes(1);
    expect(starts).toBe(1);

    const clickStop = mock(() => undefined);
    idle.props.onClick({ detail: 0, stopPropagation: clickStop });
    expect(clickStop).toHaveBeenCalledTimes(1);

    const mouseClickStop = mock(() => undefined);
    idle.props.onClick({ detail: 1, stopPropagation: mouseClickStop });
    expect(mouseClickStop).toHaveBeenCalledTimes(0);

    const keyPrevent = mock(() => undefined);
    const keyStop = mock(() => undefined);
    idle.props.onKeyDown({
      key: "Enter",
      preventDefault: keyPrevent,
      stopPropagation: keyStop,
    });
    expect(keyPrevent).toHaveBeenCalledTimes(1);
    expect(keyStop).toHaveBeenCalledTimes(1);
    expect(starts).toBe(2);

    const spacePrevent = mock(() => undefined);
    const spaceStop = mock(() => undefined);
    idle.props.onKeyDown({
      key: " ",
      preventDefault: spacePrevent,
      stopPropagation: spaceStop,
    });
    expect(spacePrevent).toHaveBeenCalledTimes(1);
    expect(spaceStop).toHaveBeenCalledTimes(1);
    expect(starts).toBe(3);
  });

  test("guards row selection when events originate from rename-edit", () => {
    const row = makeRow("agent-A");
    const onSelect = mock(() => undefined);
    const tree = SessionsPane({
      sessions: () => [row],
      activeId: () => null,
      onSelect,
      onRename: async () => undefined,
      pendingFor: () => ({ network: 0, hostexec: 0 }),
      homeDir: () => null,
    }) as unknown as SessionsPaneTree;

    const sessionRow =
      tree.props.children[1].props.children.props.children(row);

    sessionRow.props.onClick({
      target: {
        closest: (selector: string) =>
          selector === ".rename-edit" ? ({} as Element) : null,
      },
    });
    expect(onSelect).toHaveBeenCalledTimes(0);

    const preventDefault = mock(() => undefined);
    sessionRow.props.onKeyDown({
      key: "Enter",
      preventDefault,
      target: {
        closest: (selector: string) =>
          selector === ".rename-edit" ? ({} as Element) : null,
      },
    });
    expect(preventDefault).toHaveBeenCalledTimes(0);
    expect(onSelect).toHaveBeenCalledTimes(0);

    sessionRow.props.onKeyDown({
      key: "Enter",
      preventDefault,
      target: {
        closest: () => null,
      },
    });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith("agent-A");

    sessionRow.props.onKeyDown({
      key: " ",
      preventDefault,
      target: {
        closest: () => null,
      },
    });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith("agent-A");
  });
});
