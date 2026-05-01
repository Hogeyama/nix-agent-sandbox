import { describe, expect, test } from "bun:test";
import type { ConversationListRow } from "../../../../../history/types";
import {
  formatRelativeTime,
  shortenId,
  toHistoryListRowDisplay,
} from "./historyListView";

function makeRow(
  overrides: Partial<ConversationListRow> = {},
): ConversationListRow {
  return {
    id: "sess_aabbccdd11223344",
    agent: "claude-code",
    firstSeenAt: "2026-04-30T12:00:00.000Z",
    lastSeenAt: "2026-05-01T08:00:00.000Z",
    turnEventCount: 12,
    spanCount: 34,
    invocationCount: 2,
    inputTokensTotal: 1500,
    outputTokensTotal: 500,
    cacheReadTotal: 0,
    cacheWriteTotal: 0,
    summary: null,
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

describe("toHistoryListRowDisplay", () => {
  const nowMs = Date.parse("2026-05-01T12:00:00.000Z");

  test("projects every required field from the backend row", () => {
    const display = toHistoryListRowDisplay(makeRow(), nowMs);
    expect(display.id).toBe("sess_aabbccdd11223344");
    expect(display.shortId).toBe("sess_aab");
    expect(display.agent).toBe("claude-code");
    expect(display.relativeTime).toBe("4h ago");
    expect(display.fullTimestamp).toBe("2026-05-01T08:00:00.000Z");
    expect(display.turnCount).toBe(12);
    expect(display.spanCount).toBe(34);
    expect(display.tokenTotal).toBe(2000);
    expect(display.href).toBe("#/history/conversation/sess_aabbccdd11223344");
  });

  test("renders a null agent as the dash placeholder", () => {
    const display = toHistoryListRowDisplay(makeRow({ agent: null }), nowMs);
    expect(display.agent).toBe("—");
  });

  test("sums input and output tokens for the token total column", () => {
    const display = toHistoryListRowDisplay(
      makeRow({ inputTokensTotal: 7, outputTokensTotal: 3 }),
      nowMs,
    );
    expect(display.tokenTotal).toBe(10);
  });

  test("href encodes the full id, not the shortened one", () => {
    const display = toHistoryListRowDisplay(
      makeRow({ id: "longid_xxx" }),
      nowMs,
    );
    expect(display.href).toBe("#/history/conversation/longid_xxx");
    expect(display.shortId).toBe("longid_x");
  });

  test("falls back to a placeholder when summary is null", () => {
    const display = toHistoryListRowDisplay(makeRow({ summary: null }), nowMs);
    expect(display.summary).toBe("(no summary)");
    expect(display.hasSummary).toBe(false);
  });

  test("propagates a non-null summary verbatim", () => {
    const display = toHistoryListRowDisplay(
      makeRow({ summary: "Refactor the auth flow" }),
      nowMs,
    );
    expect(display.summary).toBe("Refactor the auth flow");
    expect(display.hasSummary).toBe(true);
  });
});
