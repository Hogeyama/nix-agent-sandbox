import { expect, test } from "bun:test";
import {
  resolveAgentCredentials,
  supportsProxiedCredentials,
  usesProxiedClaudeCredentials,
} from "./credentials.ts";

test("resolveAgentCredentials: Claude defaults to proxy", () => {
  expect(resolveAgentCredentials("claude", undefined)).toBe("proxy");
});

test("resolveAgentCredentials: other agents default to shared", () => {
  expect(resolveAgentCredentials("codex", undefined)).toBe("shared");
  expect(resolveAgentCredentials("copilot", undefined)).toBe("shared");
});

test("resolveAgentCredentials: an explicit value wins over the default", () => {
  expect(resolveAgentCredentials("claude", "shared")).toBe("shared");
  expect(resolveAgentCredentials("codex", "proxy")).toBe("proxy");
});

test("supportsProxiedCredentials: only Claude is implemented", () => {
  expect(supportsProxiedCredentials("claude")).toBe(true);
  expect(supportsProxiedCredentials("codex")).toBe(false);
  expect(supportsProxiedCredentials("copilot")).toBe(false);
});

test("usesProxiedClaudeCredentials: Claude with auth unset or proxy", () => {
  for (const auth of [undefined, "proxy"] as const) {
    expect(
      usesProxiedClaudeCredentials({
        agent: "claude",
        agentState: { protectSettings: false, auth },
      }),
    ).toBe(true);
  }
});

test("usesProxiedClaudeCredentials: Claude with auth shared", () => {
  expect(
    usesProxiedClaudeCredentials({
      agent: "claude",
      agentState: { protectSettings: true, auth: "shared" },
    }),
  ).toBe(false);
});

test("usesProxiedClaudeCredentials: other agents, even with auth proxy", () => {
  for (const agent of ["codex", "copilot"] as const) {
    for (const auth of [undefined, "proxy", "shared"] as const) {
      expect(
        usesProxiedClaudeCredentials({
          agent,
          agentState: { protectSettings: false, auth },
        }),
      ).toBe(false);
    }
  }
});
