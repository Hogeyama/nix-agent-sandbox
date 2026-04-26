import { describe, expect, test } from "bun:test";
import type { LaunchBranches } from "../api/client";
import {
  pickEffectiveCwd,
  pickWorktreeBase,
  reconcileWorktreeChoice,
} from "./newSessionForm";

function branches(overrides: Partial<LaunchBranches> = {}): LaunchBranches {
  return { currentBranch: null, hasMain: false, ...overrides };
}

describe("pickWorktreeBase", () => {
  test("'none' returns undefined regardless of other inputs", () => {
    expect(
      pickWorktreeBase("none", "feature/x", branches({ hasMain: true })),
    ).toBeUndefined();
  });

  test("'main' returns the literal 'main'", () => {
    expect(pickWorktreeBase("main", "", branches({ hasMain: true }))).toBe(
      "main",
    );
  });

  test("'current' returns the currentBranch when present", () => {
    expect(
      pickWorktreeBase(
        "current",
        "",
        branches({ currentBranch: "feature/api" }),
      ),
    ).toBe("feature/api");
  });

  test("'current' returns undefined when currentBranch is null", () => {
    expect(
      pickWorktreeBase("current", "", branches({ currentBranch: null })),
    ).toBeUndefined();
  });

  test("'current' returns undefined when branches is null", () => {
    expect(pickWorktreeBase("current", "", null)).toBeUndefined();
  });

  test("'custom' returns the trimmed custom value when non-empty", () => {
    expect(pickWorktreeBase("custom", "  topic/foo  ", null)).toBe("topic/foo");
  });

  test("'custom' returns undefined when the custom field is empty after trimming", () => {
    expect(pickWorktreeBase("custom", "   ", null)).toBeUndefined();
  });
});

describe("pickEffectiveCwd", () => {
  test("'default' returns the empty string", () => {
    expect(pickEffectiveCwd("default", "/some/path", "/recent")).toBe("");
  });

  test("'recent' returns the selectedRecentDir trimmed", () => {
    expect(pickEffectiveCwd("recent", "/ignored", "  /repos/a  ")).toBe(
      "/repos/a",
    );
  });

  test("'custom' returns the customDir trimmed", () => {
    expect(pickEffectiveCwd("custom", "  /repos/b  ", "/ignored")).toBe(
      "/repos/b",
    );
  });
});

describe("reconcileWorktreeChoice", () => {
  test("'main' is downgraded to 'none' when branches is null", () => {
    expect(reconcileWorktreeChoice("main", null)).toBe("none");
  });

  test("'main' is downgraded to 'none' when hasMain is false", () => {
    expect(reconcileWorktreeChoice("main", branches({ hasMain: false }))).toBe(
      "none",
    );
  });

  test("'main' is preserved when hasMain is true", () => {
    expect(reconcileWorktreeChoice("main", branches({ hasMain: true }))).toBe(
      "main",
    );
  });

  test("'current' is downgraded to 'none' when currentBranch is null", () => {
    expect(
      reconcileWorktreeChoice("current", branches({ currentBranch: null })),
    ).toBe("none");
  });

  test("'current' is downgraded to 'none' when currentBranch === 'main' (would duplicate)", () => {
    expect(
      reconcileWorktreeChoice(
        "current",
        branches({ currentBranch: "main", hasMain: true }),
      ),
    ).toBe("none");
  });

  test("'current' is preserved when currentBranch is a non-main branch", () => {
    expect(
      reconcileWorktreeChoice(
        "current",
        branches({ currentBranch: "feature/x" }),
      ),
    ).toBe("current");
  });

  test("'none' is always preserved", () => {
    expect(reconcileWorktreeChoice("none", null)).toBe("none");
    expect(reconcileWorktreeChoice("none", branches({ hasMain: true }))).toBe(
      "none",
    );
  });

  test("'custom' is always preserved (validated server-side)", () => {
    expect(reconcileWorktreeChoice("custom", null)).toBe("custom");
    expect(
      reconcileWorktreeChoice(
        "custom",
        branches({ currentBranch: null, hasMain: false }),
      ),
    ).toBe("custom");
  });
});
