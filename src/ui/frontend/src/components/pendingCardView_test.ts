import { describe, expect, test } from "bun:test";
import {
  askReasonView,
  formatBodyDiagnostic,
  formatRelativeTime,
  formatRequestBodyAuditStatus,
  hostExecApprovalEffect,
  hostExecMatchDetails,
  hostExecScopeLabel,
  networkApprovalEffect,
  sessionLabel,
} from "./pendingCardView";

describe("formatRequestBodyAuditStatus", () => {
  test("describes disabled capture", () => {
    expect(formatRequestBodyAuditStatus({ state: "disabled" })).toBe(
      "raw audit: disabled",
    );
  });

  test("describes a request without a body", () => {
    expect(formatRequestBodyAuditStatus({ state: "not-applicable" })).toBe(
      "raw audit: not applicable",
    );
  });

  test("describes saved bytes with their digest", () => {
    expect(
      formatRequestBodyAuditStatus({
        state: "attached",
        byteLength: 12,
        sha256: "sha256:0123456789abcdef",
      }),
    ).toBe("raw audit: saved (12 bytes, sha256:0123456789abcdef)");
  });

  test.each([
    "body-unreadable",
    "body-too-large",
    "capacity",
    "invalid-capture",
    "store-failed",
  ] as const)("describes unavailable capture: %s", (code) => {
    expect(formatRequestBodyAuditStatus({ state: "unavailable", code })).toBe(
      `raw audit: unavailable (${code})`,
    );
  });
});

describe("formatBodyDiagnostic", () => {
  test("describes an unreadable body without exposing an exception", () => {
    expect(formatBodyDiagnostic({ code: "body-unreadable" })).toBe(
      "Request body could not be read.",
    );
  });

  test("describes the exact body-size limit", () => {
    expect(
      formatBodyDiagnostic({
        code: "body-too-large",
        byteLength: 9_000_000,
        maxBodyBytes: 8_388_608,
      }),
    ).toBe(
      "Body was 9000000 bytes; the body evaluation limit was 8388608 bytes.",
    );
  });

  test("describes invalid JSON without parser output or body text", () => {
    expect(formatBodyDiagnostic({ code: "invalid-json" })).toBe(
      "Request body was not valid JSON.",
    );
  });

  test("distinguishes an empty JSON body", () => {
    expect(formatBodyDiagnostic({ code: "empty-json-body" })).toBe(
      "Request body was empty, but this rule requires JSON.",
    );
  });

  test("names only the safe pointer for a non-scalar value", () => {
    expect(
      formatBodyDiagnostic({
        code: "non-scalar-at-pointer",
        pointer: "/messages/0/content",
      }),
    ).toBe(
      "JSON pointer /messages/0/content resolved to an object/array, not a scalar.",
    );
  });
});

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
  test("shows a session name together with the short id", () => {
    expect(sessionLabel({ sessionShortId: "s_7a3f12" }, "feature-auth")).toBe(
      "feature-auth · s_7a3f12",
    );
  });

  test("falls back to the short id when the session has no name", () => {
    expect(sessionLabel({ sessionShortId: "s_7a3f12" }, undefined)).toBe(
      "s_7a3f12",
    );
  });
});

describe("networkApprovalEffect", () => {
  const row = { violations: [{}, {}] };

  test("once covers only this request and creates no future memory", () => {
    expect(networkApprovalEffect(row, "once")).toBe(
      "Answers this request only. It is not remembered for future requests.",
    );
  });

  test("rule covers the current group and future same-rule fixed-target requests", () => {
    expect(networkApprovalEffect(row, "rule")).toBe(
      "Answers the current group and future matching requests in this session for the same rule and fixed target.",
    );
  });

  test("host-port covers the current group and future same-rule host-port requests", () => {
    expect(networkApprovalEffect(row, "host-port")).toBe(
      "Answers the current group and future matching requests in this session for the same rule, host, and port.",
    );
  });

  test("host covers the current group and future same-rule host requests on every port", () => {
    expect(networkApprovalEffect(row, "host")).toBe(
      "Answers the current group and future matching requests in this session for the same rule and host, on any port.",
    );
  });

  test("violation covers the current group and the shown violation identities", () => {
    expect(networkApprovalEffect(row, "violation")).toBe(
      "Answers the current group and future matching requests in this session for the same rule and violation identities shown here.",
    );
  });
});

describe("hostexec approval views", () => {
  const capability = {
    ruleId: "git.push",
    argv0: "git",
    normalizedArgv: ["git", "push", "origin", "main"],
    normalizedCwd: "/workspace",
    envBindings: [{ key: "GITHUB_TOKEN", source: "secret:github" }],
    inheritEnv: { mode: "minimal" as const, keys: ["SSH_AUTH_SOCK"] },
  };

  test("uses plain language for each approval scope", () => {
    expect(hostExecScopeLabel("once")).toBe("This request only");
    expect(hostExecScopeLabel("capability")).toBe(
      "Matching command for this session",
    );
    expect(hostExecScopeLabel("capability")).not.toContain("capability");
  });

  test("states what each approval scope remembers", () => {
    expect(hostExecApprovalEffect("once")).toBe(
      "Approves this request only. Nothing is remembered.",
    );
    expect(hostExecApprovalEffect("capability")).toContain(
      "future requests in this session",
    );
  });

  test("shows every broker-reported condition that defines a match", () => {
    expect(
      hostExecMatchDetails({
        ruleId: capability.ruleId,
        cwd: capability.normalizedCwd,
        capability,
      }),
    ).toEqual([
      { label: "Rule", value: "git.push" },
      { label: "Command", value: '"git" "push" "origin" "main"' },
      { label: "Working directory", value: "/workspace" },
      {
        label: "Environment bindings",
        value: "GITHUB_TOKEN ← secret:github",
      },
      { label: "Inherited environment", value: "minimal; SSH_AUTH_SOCK" },
    ]);
  });

  test("calls out broker-reported empty match lists as none", () => {
    const details = hostExecMatchDetails({
      ruleId: "git.push",
      cwd: "/workspace",
      capability: {
        ...capability,
        normalizedArgv: [],
        envBindings: [],
        inheritEnv: { mode: "minimal", keys: [] },
      },
    });

    expect(details).toContainEqual({ label: "Command", value: "none" });
    expect(details).toContainEqual({
      label: "Environment bindings",
      value: "none",
    });
    expect(details).toContainEqual({
      label: "Inherited environment",
      value: "minimal; none",
    });
  });

  test("JSON-quotes empty and special-character command arguments", () => {
    const details = hostExecMatchDetails({
      ruleId: capability.ruleId,
      cwd: capability.normalizedCwd,
      capability: {
        ...capability,
        normalizedArgv: ["", 'a"b', "line\nbreak", "\\"],
      },
    });

    expect(details).toContainEqual({
      label: "Command",
      value: '"" "a\\"b" "line\\nbreak" "\\\\"',
    });
  });

  test.each([
    [[], "unsafe-inherit-all; none"],
    [["HOME", "SSH_AUTH_SOCK"], "unsafe-inherit-all; HOME, SSH_AUTH_SOCK"],
  ])("renders unsafe inherited environment keys %p as %s", (keys, value) => {
    const details = hostExecMatchDetails({
      ruleId: capability.ruleId,
      cwd: capability.normalizedCwd,
      capability: {
        ...capability,
        inheritEnv: { mode: "unsafe-inherit-all", keys },
      },
    });

    expect(details).toContainEqual({
      label: "Inherited environment",
      value,
    });
  });

  test("shows unavailable evidence explicitly for an older payload", () => {
    expect(
      hostExecMatchDetails({ ruleId: null, cwd: null, capability: null }),
    ).toEqual([
      { label: "Rule", value: "not reported" },
      { label: "Command", value: "not reported" },
      { label: "Working directory", value: "not reported" },
      { label: "Environment bindings", value: "not reported" },
      { label: "Inherited environment", value: "not reported" },
    ]);
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
