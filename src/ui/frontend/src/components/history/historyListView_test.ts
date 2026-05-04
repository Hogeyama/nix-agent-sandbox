import { describe, expect, test } from "bun:test";
import type { ConversationListRow } from "../../../../../history/types";
import {
  formatCompactNumber,
  formatRelativeTime,
  projectDirectoryFromWorktree,
  shortenId,
  toConversationListRowView,
} from "./historyListView";

function makeRow(
  overrides: Partial<ConversationListRow> = {},
): ConversationListRow {
  return {
    id: "sess_aabbccdd11223344",
    agent: "claude-code",
    firstSeenAt: "2026-04-30T12:00:00.000Z",
    lastSeenAt: "2026-05-01T08:00:00.000Z",
    turnCount: 12,
    spanCount: 34,
    invocationCount: 2,
    inputTokensTotal: 1500,
    outputTokensTotal: 500,
    cacheReadTotal: 0,
    cacheWriteTotal: 0,
    summary: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("shortenId", () => {
  test("trims long ids to 8 characters", () => {
    expect(shortenId("sess_aabbccdd11223344")).toBe("sess_aab");
  });

  test("passes short ids through unchanged", () => {
    expect(shortenId("abc")).toBe("abc");
    expect(shortenId("12345678")).toBe("12345678");
  });
});

describe("formatRelativeTime", () => {
  const nowMs = Date.parse("2026-05-01T12:00:00.000Z");

  test("renders sub-minute differences in seconds", () => {
    expect(formatRelativeTime("2026-05-01T11:59:55.000Z", nowMs)).toBe(
      "5s ago",
    );
  });

  test("renders sub-hour differences in minutes", () => {
    expect(formatRelativeTime("2026-05-01T11:55:00.000Z", nowMs)).toBe(
      "5m ago",
    );
  });

  test("renders sub-day differences in hours", () => {
    expect(formatRelativeTime("2026-05-01T10:00:00.000Z", nowMs)).toBe(
      "2h ago",
    );
  });

  test("renders 1 day as 'yesterday'", () => {
    expect(formatRelativeTime("2026-04-30T12:00:00.000Z", nowMs)).toBe(
      "yesterday",
    );
  });

  test("renders sub-month differences in days", () => {
    expect(formatRelativeTime("2026-04-25T12:00:00.000Z", nowMs)).toBe(
      "6d ago",
    );
  });

  test("renders sub-year differences in months", () => {
    expect(formatRelativeTime("2026-02-01T12:00:00.000Z", nowMs)).toBe(
      "3mo ago",
    );
  });

  test("renders longer differences in years", () => {
    expect(formatRelativeTime("2024-05-01T12:00:00.000Z", nowMs)).toBe(
      "2y ago",
    );
  });

  test("never produces a negative diff for clock skew", () => {
    expect(formatRelativeTime("2026-05-01T13:00:00.000Z", nowMs)).toBe(
      "0s ago",
    );
  });

  test("renders the zero-second boundary as '0s ago' when iso === nowMs", () => {
    const iso = "2026-05-01T10:00:00.000Z";
    expect(formatRelativeTime(iso, Date.parse(iso))).toBe("0s ago");
  });

  test("falls back to the raw input when the timestamp does not parse", () => {
    expect(formatRelativeTime("not-a-date", nowMs)).toBe("not-a-date");
  });
});

describe("formatCompactNumber", () => {
  test("zero renders as bare 0", () => {
    expect(formatCompactNumber(0)).toBe("0");
  });
  test("single-digit values stay unchanged", () => {
    expect(formatCompactNumber(1)).toBe("1");
    expect(formatCompactNumber(42)).toBe("42");
  });
  test("999 stays in the bare-integer bucket", () => {
    expect(formatCompactNumber(999)).toBe("999");
  });
  test("1000 enters the kilo bucket and trims the trailing 0 decimal", () => {
    expect(formatCompactNumber(1000)).toBe("1k");
  });
  test("kilo bucket truncates the fractional digit (not round)", () => {
    expect(formatCompactNumber(1499)).toBe("1.4k");
  });
  test("kilo bucket reaches near the upper boundary", () => {
    expect(formatCompactNumber(9999)).toBe("9.9k");
  });
  test("five-digit values drop the decimal once whole part is >= 10", () => {
    expect(formatCompactNumber(10000)).toBe("10k");
    expect(formatCompactNumber(42_000)).toBe("42k");
  });
  test("mega bucket truncates similarly", () => {
    expect(formatCompactNumber(1_000_000)).toBe("1M");
    expect(formatCompactNumber(1_499_000)).toBe("1.4M");
    expect(formatCompactNumber(2_000_000)).toBe("2M");
  });
  test("giga bucket kicks in at the billion boundary", () => {
    expect(formatCompactNumber(1_000_000_000)).toBe("1G");
    expect(formatCompactNumber(2_500_000_000)).toBe("2.5G");
  });
  test("negative values keep the sign", () => {
    expect(formatCompactNumber(-1500)).toBe("-1.5k");
  });
});

describe("projectDirectoryFromWorktree", () => {
  test("strips a single worktree segment", () => {
    expect(
      projectDirectoryFromWorktree("/home/me/proj/.nas/worktree/foo"),
    ).toBe("/home/me/proj");
  });

  test("strips a trailing slash on the worktree segment", () => {
    expect(
      projectDirectoryFromWorktree("/home/me/proj/.nas/worktree/foo/"),
    ).toBe("/home/me/proj");
  });

  test("returns the path unchanged when no worktree marker is present", () => {
    expect(projectDirectoryFromWorktree("/home/me/proj")).toBe("/home/me/proj");
  });

  test("null produces empty string", () => {
    expect(projectDirectoryFromWorktree(null)).toBe("");
  });
});

describe("toConversationListRowView", () => {
  const nowMs = Date.parse("2026-05-01T12:00:00.000Z");

  test("projects every required field from the backend row", () => {
    const display = toConversationListRowView(makeRow(), nowMs);
    expect(display.id).toBe("sess_aabbccdd11223344");
    expect(display.idShort).toBe("sess_aab");
    expect(display.agent).toBe("claude-code");
    expect(display.agentLabel).toBe("claude");
    expect(display.agentClass).toBe("is-claude");
    expect(display.lastSeen).toBe("4h ago");
    expect(display.fullTimestamp).toBe("2026-05-01T08:00:00.000Z");
    expect(display.tokenTotal).toBe("2k");
    expect(display.href).toBe("#/history/conversation/sess_aabbccdd11223344");
  });

  test("null agent is exposed verbatim with empty label and class", () => {
    const display = toConversationListRowView(makeRow({ agent: null }), nowMs);
    expect(display.agent).toBeNull();
    expect(display.agentLabel).toBe("");
    expect(display.agentClass).toBe("");
  });

  test("copilot agent maps to is-copilot variant", () => {
    const display = toConversationListRowView(
      makeRow({ agent: "github-copilot" }),
      nowMs,
    );
    expect(display.agentClass).toBe("is-copilot");
    expect(display.agentLabel).toBe("copilot");
  });

  test("codex agent maps to is-codex variant", () => {
    const display = toConversationListRowView(
      makeRow({ agent: "openai-codex" }),
      nowMs,
    );
    expect(display.agentClass).toBe("is-codex");
    expect(display.agentLabel).toBe("codex");
  });

  test("href encodes the full id, not the shortened one", () => {
    const display = toConversationListRowView(
      makeRow({ id: "longid_xxx" }),
      nowMs,
    );
    expect(display.href).toBe("#/history/conversation/longid_xxx");
    expect(display.idShort).toBe("longid_x");
  });

  test("missing summary falls back to the short id and marks summaryIsEmpty", () => {
    const display = toConversationListRowView(
      makeRow({ summary: null }),
      nowMs,
    );
    expect(display.summary).toBe("sess_aab");
    expect(display.summaryIsEmpty).toBe(true);
    // metaLine omits the short id when summary already shows it.
    expect(display.metaLine).toBe("12 turns · 34 spans · 2k tok");
  });

  test("non-null summary becomes primary text and metaLine carries the id", () => {
    const display = toConversationListRowView(
      makeRow({ summary: "Refactor the auth flow" }),
      nowMs,
    );
    expect(display.summary).toBe("Refactor the auth flow");
    expect(display.summaryIsEmpty).toBe(false);
    expect(display.metaLine).toBe("sess_aab · 12 turns · 34 spans · 2k tok");
  });

  test("metaLine drops segments that are zero", () => {
    const display = toConversationListRowView(
      makeRow({
        summary: "Hi",
        turnCount: 0,
        spanCount: 5,
        inputTokensTotal: 0,
        outputTokensTotal: 0,
      }),
      nowMs,
    );
    expect(display.metaLine).toBe("sess_aab · 5 spans");
  });

  test("tokenBreakdownTitle joins every non-zero kind with the mid-dot", () => {
    const display = toConversationListRowView(
      makeRow({
        inputTokensTotal: 1500,
        outputTokensTotal: 500,
        cacheReadTotal: 100,
        cacheWriteTotal: 50,
      }),
      nowMs,
    );
    expect(display.tokenBreakdownTitle).toBe(
      "Input 1.5k · Output 500 · Cache R 100 · Cache W 50",
    );
  });

  test("tokenBreakdownTitle drops zero-valued kinds", () => {
    const display = toConversationListRowView(
      makeRow({
        inputTokensTotal: 1000,
        outputTokensTotal: 0,
        cacheReadTotal: 0,
        cacheWriteTotal: 200,
      }),
      nowMs,
    );
    expect(display.tokenBreakdownTitle).toBe("Input 1k · Cache W 200");
  });

  test("tokenBreakdownTitle is empty when every kind is zero", () => {
    const display = toConversationListRowView(
      makeRow({
        inputTokensTotal: 0,
        outputTokensTotal: 0,
        cacheReadTotal: 0,
        cacheWriteTotal: 0,
      }),
      nowMs,
    );
    expect(display.tokenBreakdownTitle).toBe("");
  });

  test("directory strips the /.nas/worktree/<name> suffix", () => {
    const display = toConversationListRowView(
      makeRow({ worktreePath: "/home/me/proj/.nas/worktree/foo" }),
      nowMs,
    );
    expect(display.directory).toBe("/home/me/proj");
    expect(display.directoryParent).toBe("/home/me/");
    expect(display.directoryBase).toBe("proj");
  });

  test("directory is empty when worktreePath is null", () => {
    const display = toConversationListRowView(
      makeRow({ worktreePath: null }),
      nowMs,
    );
    expect(display.directory).toBe("");
    expect(display.directoryParent).toBe("");
    expect(display.directoryBase).toBe("");
  });

  test("metaLine singularises 1 turn / 1 span", () => {
    const display = toConversationListRowView(
      makeRow({
        summary: "Single",
        turnCount: 1,
        spanCount: 1,
        inputTokensTotal: 0,
        outputTokensTotal: 0,
      }),
      nowMs,
    );
    expect(display.metaLine).toBe("sess_aab · 1 turn · 1 span");
  });
});
