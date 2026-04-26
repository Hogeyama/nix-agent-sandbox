import { describe, expect, test } from "bun:test";
import type { SessionRow } from "../stores/types";
import { describeSessionRow, formatSessionTree } from "./sessionRowView";

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "s_aaaaaaaa11111111",
    shortId: "s_aaaaaa",
    name: "default-session",
    containerName: "default-container",
    dir: null,
    profile: null,
    worktreeName: null,
    baseBranch: null,
    turn: null,
    lastEventAt: null,
    isAgent: true,
    ...overrides,
  };
}

describe("describeSessionRow", () => {
  test("user-turn yields the amber turn dot and Turn badge", () => {
    const display = describeSessionRow(makeRow({ turn: "user-turn" }));
    expect(display.dotClass).toBe("session-dot turn");
    expect(display.badge).toEqual({
      text: "Turn",
      class: "badge badge-turn",
    });
  });

  test("agent-turn yields the teal busy dot and Busy badge", () => {
    const display = describeSessionRow(makeRow({ turn: "agent-turn" }));
    expect(display.dotClass).toBe("session-dot busy");
    expect(display.badge).toEqual({
      text: "Busy",
      class: "badge badge-busy",
    });
  });

  test("turn=null yields the idle dot and no badge", () => {
    const display = describeSessionRow(makeRow({ turn: null }));
    expect(display.dotClass).toBe("session-dot");
    expect(display.badge).toBeNull();
  });

  test("unknown turn 'ack-turn' falls through to the default state", () => {
    const display = describeSessionRow(makeRow({ turn: "ack-turn" }));
    expect(display.dotClass).toBe("session-dot");
    expect(display.badge).toBeNull();
  });

  test("unknown turn 'done' falls through to the default state", () => {
    const display = describeSessionRow(makeRow({ turn: "done" }));
    expect(display.dotClass).toBe("session-dot");
    expect(display.badge).toBeNull();
  });
});

describe("formatSessionTree", () => {
  test("worktree name + baseBranch renders as '<wt> ← <base>' and is not dimmed", () => {
    const tree = formatSessionTree(
      makeRow({ worktreeName: "wt-auth", baseBranch: "main" }),
    );
    expect(tree.text).toBe("wt-auth ← main");
    expect(tree.dim).toBe(false);
  });

  test("no worktree but baseBranch present renders as '— direct on <base>' and is dimmed", () => {
    const tree = formatSessionTree(
      makeRow({ worktreeName: null, baseBranch: "main" }),
    );
    expect(tree.text).toBe("— direct on main");
    expect(tree.dim).toBe(true);
  });

  test("no worktree and no baseBranch falls back to 'main' and is dimmed", () => {
    const tree = formatSessionTree(
      makeRow({ worktreeName: null, baseBranch: null }),
    );
    expect(tree.text).toBe("— direct on main");
    expect(tree.dim).toBe(true);
  });
});
