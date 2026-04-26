import { describe, expect, mock, test } from "bun:test";
import type { JSX } from "solid-js";
import { EditableSessionName } from "./EditableSessionName";

type EditableSessionNameTree = {
  props: {
    fallback: JSX.Element;
    children: {
      props: {
        children: [
          {
            props: {
              onClick: (e: { stopPropagation(): void }) => void;
              onMouseDown: (e: { stopPropagation(): void }) => void;
            };
          },
          unknown,
        ];
      };
    };
  };
};

describe("EditableSessionName", () => {
  test("uses renderIdle as the idle fallback when the slot is provided", () => {
    const calls: Array<{ start: () => void; currentName: string }> = [];
    const sentinel = {
      type: "span",
      props: { class: "toolbar-name-idle" },
    } as unknown as JSX.Element;

    const tree = EditableSessionName({
      currentName: "alpha",
      onSubmit: async () => undefined,
      renderIdle: (api) => {
        calls.push(api);
        return sentinel;
      },
    }) as unknown as EditableSessionNameTree;

    expect(tree.props.fallback).toBe(sentinel);
    expect(calls).toHaveLength(1);
    const captured = calls[0];
    if (captured === undefined) throw new Error("renderIdle api is missing");
    expect(captured.currentName).toBe("alpha");
    expect(typeof captured.start).toBe("function");
  });

  test("stops click and mousedown propagation from the rename input", () => {
    const tree = EditableSessionName({
      currentName: "alpha",
      onSubmit: async () => undefined,
    }) as unknown as EditableSessionNameTree;
    const input = tree.props.children.props.children[0];

    const clickStop = mock(() => undefined);
    input.props.onClick({ stopPropagation: clickStop });
    expect(clickStop).toHaveBeenCalledTimes(1);

    const mouseDownStop = mock(() => undefined);
    input.props.onMouseDown({ stopPropagation: mouseDownStop });
    expect(mouseDownStop).toHaveBeenCalledTimes(1);
  });
});
