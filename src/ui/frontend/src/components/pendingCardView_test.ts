import { describe, expect, test } from "bun:test";
import { formatRelativeTime, sessionLabel } from "./pendingCardView";

describe("formatRelativeTime", () => {
  test("targetMs = null returns the em dash placeholder", () => {
    expect(formatRelativeTime(null, 1_000_000)).toBe("—");
  });

  test("zero delta renders as 0s ago", () => {
    expect(formatRelativeTime(1_000_000, 1_000_000)).toBe("0s ago");
  });

  test("5 seconds delta renders as 5s ago", () => {
    expect(formatRelativeTime(1_000_000, 1_005_000)).toBe("5s ago");
  });

  test("just below the minute boundary renders in seconds", () => {
    expect(formatRelativeTime(1_000_000, 1_000_000 + 59_000)).toBe("59s ago");
  });

  test("exactly one minute renders as 1m ago", () => {
    expect(formatRelativeTime(1_000_000, 1_000_000 + 60_000)).toBe("1m ago");
  });

  test("just below the hour boundary renders in minutes", () => {
    expect(formatRelativeTime(1_000_000, 1_000_000 + 59 * 60_000)).toBe(
      "59m ago",
    );
  });

  test("exactly one hour renders as 1h ago", () => {
    expect(formatRelativeTime(1_000_000, 1_000_000 + 3_600_000)).toBe("1h ago");
  });

  test("just below the day boundary renders in hours", () => {
    expect(formatRelativeTime(1_000_000, 1_000_000 + 23 * 3_600_000)).toBe(
      "23h ago",
    );
  });

  test("exactly one day renders as 1d ago", () => {
    expect(formatRelativeTime(1_000_000, 1_000_000 + 86_400_000)).toBe(
      "1d ago",
    );
  });

  test("multi-day delta renders in days", () => {
    expect(formatRelativeTime(1_000_000, 1_000_000 + 3 * 86_400_000)).toBe(
      "3d ago",
    );
  });

  test("a target in the future (clock skew) clamps to 0s ago", () => {
    expect(formatRelativeTime(1_000_000 + 5_000, 1_000_000)).toBe("0s ago");
  });
});

describe("sessionLabel", () => {
  test("returns sessionName when set", () => {
    expect(
      sessionLabel({ sessionShortId: "s_7a3f12", sessionName: "feature-auth" }),
    ).toBe("feature-auth");
  });

  test("falls back to sessionShortId when sessionName is null", () => {
    expect(
      sessionLabel({ sessionShortId: "s_7a3f12", sessionName: null }),
    ).toBe("s_7a3f12");
  });
});
