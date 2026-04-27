import { describe, expect, test } from "bun:test";
import type { LaunchBranches, LaunchInfo } from "../api/client";
import {
  pickEffectiveCwd,
  pickWorktreeBase,
  reconcileProfileChoice,
  reconcileWorktreeChoice,
} from "./newSessionForm";

function branches(overrides: Partial<LaunchBranches> = {}): LaunchBranches {
  return { currentBranch: null, hasMain: false, ...overrides };
}

function info(overrides: Partial<LaunchInfo> = {}): LaunchInfo {
  return {
    dtachAvailable: true,
    profiles: [],
    recentDirectories: [],
    ...overrides,
  };
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

describe("reconcileProfileChoice", () => {
  test("preserves current when info is null (in-flight fetch)", () => {
    expect(reconcileProfileChoice("dev", null)).toBe("dev");
  });

  test("preserves current when it is included in profiles", () => {
    expect(
      reconcileProfileChoice(
        "dev",
        info({ profiles: ["dev", "prod"], defaultProfile: "prod" }),
      ),
    ).toBe("dev");
  });

  test("falls back to defaultProfile when current is missing from profiles", () => {
    expect(
      reconcileProfileChoice(
        "stage",
        info({ profiles: ["dev", "prod"], defaultProfile: "prod" }),
      ),
    ).toBe("prod");
  });

  test("falls back to profiles[0] when defaultProfile is undefined", () => {
    expect(
      reconcileProfileChoice("stage", info({ profiles: ["dev", "prod"] })),
    ).toBe("dev");
  });

  test("returns '' when profiles is empty", () => {
    expect(reconcileProfileChoice("dev", info({ profiles: [] }))).toBe("");
  });

  test("falls back to defaultProfile when current is '' (initial open)", () => {
    expect(
      reconcileProfileChoice(
        "",
        info({ profiles: ["dev", "prod"], defaultProfile: "prod" }),
      ),
    ).toBe("prod");
  });

  test("falls back to profiles[0] when defaultProfile is not included in profiles", () => {
    expect(
      reconcileProfileChoice(
        "stage",
        info({ profiles: ["dev", "prod"], defaultProfile: "ghost" }),
      ),
    ).toBe("dev");
  });
});
