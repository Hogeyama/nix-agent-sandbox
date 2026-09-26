import { expect, test } from "bun:test";
import {
  resolveAgentCredentials,
  supportsProxiedCredentials,
  usesProxiedClaudeCredentials,
  usesProxiedCodexCredentials,
} from "./credentials.ts";

test("resolveAgentCredentials: Claude and Codex default to proxy", () => {
  expect(resolveAgentCredentials("claude", undefined)).toBe("injected");
  expect(resolveAgentCredentials("codex", undefined)).toBe("injected");
});

test("resolveAgentCredentials: Copilot defaults to shared", () => {
  expect(resolveAgentCredentials("copilot", undefined)).toBe("passthrough");
});

test("resolveAgentCredentials: an explicit value wins for supported agents", () => {
  expect(resolveAgentCredentials("claude", "passthrough")).toBe("passthrough");
  expect(resolveAgentCredentials("codex", "passthrough")).toBe("passthrough");
  expect(resolveAgentCredentials("codex", "injected")).toBe("injected");
});

// Copilot の token は ~/.copilot に無いので、proxy を明示しても共有に
// 落として保護が弱まることはない。
test("resolveAgentCredentials: Copilot stays shared even when proxy is explicit", () => {
  expect(resolveAgentCredentials("copilot", "injected")).toBe("passthrough");
});

test("resolveAgentCredentials: Dev Container Codex defaults to shared", () => {
  expect(
    resolveAgentCredentials("codex", undefined, { devcontainer: true }),
  ).toBe("passthrough");
  expect(
    resolveAgentCredentials("claude", undefined, { devcontainer: true }),
  ).toBe("injected");
});

test("resolveAgentCredentials: a per-agent entry applies only to its agent", () => {
  const auth = { codex: "passthrough" } as const;
  expect(resolveAgentCredentials("codex", auth)).toBe("passthrough");
  // 書かれていないエージェントは既定値になる。
  expect(resolveAgentCredentials("claude", auth)).toBe("injected");
  expect(resolveAgentCredentials("copilot", auth)).toBe("passthrough");
  expect(resolveAgentCredentials("claude", { claude: "passthrough" })).toBe(
    "passthrough",
  );
  expect(resolveAgentCredentials("copilot", { copilot: "injected" })).toBe(
    "passthrough",
  );
  expect(
    resolveAgentCredentials(
      "codex",
      { claude: "passthrough" },
      { devcontainer: true },
    ),
  ).toBe("passthrough");
  expect(
    resolveAgentCredentials(
      "codex",
      { codex: "injected" },
      { devcontainer: true },
    ),
  ).toBe("injected");
});

test("supportsProxiedCredentials: Claude and Codex are implemented", () => {
  expect(supportsProxiedCredentials("claude")).toBe(true);
  expect(supportsProxiedCredentials("codex")).toBe(true);
  expect(supportsProxiedCredentials("copilot")).toBe(false);
});

test("usesProxiedClaudeCredentials: Claude with auth unset or proxy", () => {
  for (const auth of [undefined, "injected"] as const) {
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
      agentState: { protectSettings: true, auth: "passthrough" },
    }),
  ).toBe(false);
});

test("usesProxiedClaudeCredentials: Claude listed in extraAgents", () => {
  expect(
    usesProxiedClaudeCredentials({
      agent: "codex",
      extraAgents: ["claude"],
      agentState: { protectSettings: false, auth: undefined },
    }),
  ).toBe(true);
});

test("usesProxiedClaudeCredentials: profiles without Claude", () => {
  for (const agent of ["codex", "copilot"] as const) {
    expect(
      usesProxiedClaudeCredentials({
        agent,
        agentState: { protectSettings: false, auth: "injected" },
      }),
    ).toBe(false);
  }
});

test("usesProxiedCodexCredentials: launched or extra Codex outside Dev Container", () => {
  expect(
    usesProxiedCodexCredentials({
      agent: "codex",
      agentState: { protectSettings: false, auth: undefined },
    }),
  ).toBe(true);
  expect(
    usesProxiedCodexCredentials({
      agent: "claude",
      extraAgents: ["codex"],
      agentState: { protectSettings: false, auth: undefined },
    }),
  ).toBe(true);
  expect(
    usesProxiedCodexCredentials(
      {
        agent: "codex",
        agentState: { protectSettings: false, auth: undefined },
      },
      { devcontainer: true },
    ),
  ).toBe(false);
  expect(
    usesProxiedCodexCredentials({
      agent: "codex",
      agentState: { protectSettings: false, auth: "passthrough" },
    }),
  ).toBe(false);
});

test("usesProxied*Credentials: a per-agent entry opts out only that agent", () => {
  const profile = {
    agent: "claude" as const,
    extraAgents: ["codex" as const],
    agentState: {
      protectSettings: false,
      auth: { codex: "passthrough" as const },
    },
  };
  expect(usesProxiedClaudeCredentials(profile)).toBe(true);
  expect(usesProxiedCodexCredentials(profile)).toBe(false);
});
