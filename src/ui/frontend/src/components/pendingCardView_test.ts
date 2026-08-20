import { describe, expect, test } from "bun:test";
import {
  askReasonView,
  formatRelativeTime,
  sessionLabel,
} from "./pendingCardView";

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

describe("askReasonView", () => {
  test("a rule that asks to be reviewed reads as the rule's own doing", () => {
    const view = askReasonView("rule");
    expect(view?.label).toBe("the matched rule asks for review");
    expect(view?.hint).toContain("review");
  });

  test("a scope fallback says no rule took the request", () => {
    // これがルール自身の review と同じ文になってはならない。前者は設定の
    // とおりで、後者は設定の穴である。
    const view = askReasonView("scope-fallback");
    expect(view?.label).toBe("no rule in this scope matched");
    expect(view?.label).not.toBe(askReasonView("rule")?.label);
  });

  test("every known reason has its own label", () => {
    const labels = [
      "rule",
      "indeterminate",
      "scope-fallback",
      "network-fallback",
    ].map((reason) => askReasonView(reason)?.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => typeof label === "string")).toBe(true);
  });

  test("a reason the frontend does not know shows as itself", () => {
    expect(askReasonView("reason-from-a-newer-backend")).toEqual({
      label: "reason-from-a-newer-backend",
      hint: "",
    });
  });

  test("no reason (a violation card) shows nothing", () => {
    expect(askReasonView(null)).toBeNull();
    expect(askReasonView("")).toBeNull();
  });
});
