import { expect, test } from "bun:test";
import {
  resolveAgentCredentials,
  supportsProxiedCredentials,
  usesProxiedClaudeCredentials,
  usesProxiedCodexCredentials,
} from "./credentials.ts";

test("resolveAgentCredentials: Claude and Codex default to proxy", () => {
  expect(resolveAgentCredentials("claude", undefined)).toBe("proxy");
  expect(resolveAgentCredentials("codex", undefined)).toBe("proxy");
});

test("resolveAgentCredentials: Copilot defaults to shared", () => {
  expect(resolveAgentCredentials("copilot", undefined)).toBe("shared");
});

test("resolveAgentCredentials: an explicit value wins for supported agents", () => {
  expect(resolveAgentCredentials("claude", "shared")).toBe("shared");
  expect(resolveAgentCredentials("codex", "shared")).toBe("shared");
  expect(resolveAgentCredentials("codex", "proxy")).toBe("proxy");
});

// Copilot の token は ~/.copilot に無いので、proxy を明示しても共有に
// 落として保護が弱まることはない。
test("resolveAgentCredentials: Copilot stays shared even when proxy is explicit", () => {
  expect(resolveAgentCredentials("copilot", "proxy")).toBe("shared");
});

test("resolveAgentCredentials: Dev Container Codex defaults to shared", () => {
  expect(
    resolveAgentCredentials("codex", undefined, { devcontainer: true }),
  ).toBe("shared");
  expect(
    resolveAgentCredentials("claude", undefined, { devcontainer: true }),
  ).toBe("proxy");
});

test("resolveAgentCredentials: a per-agent entry applies only to its agent", () => {
  const auth = { codex: "shared" } as const;
  expect(resolveAgentCredentials("codex", auth)).toBe("shared");
  // 書かれていないエージェントは既定値になる。
  expect(resolveAgentCredentials("claude", auth)).toBe("proxy");
  expect(resolveAgentCredentials("copilot", auth)).toBe("shared");
  expect(resolveAgentCredentials("claude", { claude: "shared" })).toBe(
    "shared",
  );
  expect(resolveAgentCredentials("copilot", { copilot: "proxy" })).toBe(
    "shared",
  );
  expect(
    resolveAgentCredentials(
      "codex",
      { claude: "shared" },
      { devcontainer: true },
    ),
  ).toBe("shared");
  expect(
    resolveAgentCredentials(
      "codex",
      { codex: "proxy" },
      { devcontainer: true },
    ),
  ).toBe("proxy");
});

test("supportsProxiedCredentials: Claude and Codex are implemented", () => {
  expect(supportsProxiedCredentials("claude")).toBe(true);
  expect(supportsProxiedCredentials("codex")).toBe(true);
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
        agentState: { protectSettings: false, auth: "proxy" },
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
      agentState: { protectSettings: false, auth: "shared" },
    }),
  ).toBe(false);
});

test("usesProxied*Credentials: a per-agent entry opts out only that agent", () => {
  const profile = {
    agent: "claude" as const,
    extraAgents: ["codex" as const],
    agentState: { protectSettings: false, auth: { codex: "shared" as const } },
  };
  expect(usesProxiedClaudeCredentials(profile)).toBe(true);
  expect(usesProxiedCodexCredentials(profile)).toBe(false);
});
