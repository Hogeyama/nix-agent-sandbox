import { describe, expect, test } from "bun:test";
import type { SessionRow } from "../stores/types";
import type { PendingCount } from "./sessionPendingSummary";
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

const NO_PENDING: PendingCount = { network: 0, hostexec: 0 };

describe("describeSessionRow", () => {
  test("user-turn with no pending yields the amber turn dot and Turn badge", () => {
    const display = describeSessionRow(
      makeRow({ turn: "user-turn" }),
      NO_PENDING,
    );
    expect(display.dotClass).toBe("session-dot turn");
    expect(display.badge).toEqual({
      text: "Turn",
      class: "badge badge-turn",
    });
  });

  test("agent-turn with no pending yields the teal busy dot and Busy badge", () => {
    const display = describeSessionRow(
      makeRow({ turn: "agent-turn" }),
      NO_PENDING,
    );
    expect(display.dotClass).toBe("session-dot busy");
    expect(display.badge).toEqual({
      text: "Busy",
      class: "badge badge-busy",
    });
  });

  test("turn=null with no pending yields the idle dot and no badge", () => {
    const display = describeSessionRow(makeRow({ turn: null }), NO_PENDING);
    expect(display.dotClass).toBe("session-dot");
    expect(display.badge).toBeNull();
  });

  test("unknown turn 'ack-turn' falls through to the default state", () => {
    const display = describeSessionRow(
      makeRow({ turn: "ack-turn" }),
      NO_PENDING,
    );
    expect(display.dotClass).toBe("session-dot");
    expect(display.badge).toBeNull();
  });

  test("unknown turn 'done' falls through to the default state", () => {
    const display = describeSessionRow(makeRow({ turn: "done" }), NO_PENDING);
    expect(display.dotClass).toBe("session-dot");
    expect(display.badge).toBeNull();
  });

  test("network=1 + user-turn yields the rose pending dot and keeps Turn badge", () => {
    const display = describeSessionRow(makeRow({ turn: "user-turn" }), {
      network: 1,
      hostexec: 0,
    });
    expect(display.dotClass).toBe("session-dot pending");
    expect(display.badge).toEqual({
      text: "Turn",
      class: "badge badge-turn",
    });
  });

  test("hostexec=1 + agent-turn yields the rose pending dot and keeps Busy badge", () => {
    const display = describeSessionRow(makeRow({ turn: "agent-turn" }), {
      network: 0,
      hostexec: 1,
    });
    expect(display.dotClass).toBe("session-dot pending");
    expect(display.badge).toEqual({
      text: "Busy",
      class: "badge badge-busy",
    });
  });

  test("both network and hostexec pending + idle turn yields the rose pending dot and no badge", () => {
    const display = describeSessionRow(makeRow({ turn: null }), {
      network: 1,
      hostexec: 1,
    });
    expect(display.dotClass).toBe("session-dot pending");
    expect(display.badge).toBeNull();
  });

  test("multiple pending of each kind + user-turn still resolves to the rose pending dot and Turn badge", () => {
    const display = describeSessionRow(makeRow({ turn: "user-turn" }), {
      network: 2,
      hostexec: 3,
    });
    expect(display.dotClass).toBe("session-dot pending");
    expect(display.badge).toEqual({
      text: "Turn",
      class: "badge badge-turn",
    });
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
