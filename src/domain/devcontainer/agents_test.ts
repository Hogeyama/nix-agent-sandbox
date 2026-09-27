import { expect, test } from "bun:test";
import { resolveDevcontainerIdeAgents } from "./agents.ts";

test("resolveDevcontainerIdeAgents returns claude and codex in fixed order regardless of extraAgents order", () => {
  expect(
    resolveDevcontainerIdeAgents({
      agent: "codex",
      extraAgents: ["copilot", "claude"],
    }),
  ).toEqual(["claude", "codex"]);
});

test("resolveDevcontainerIdeAgents drops Copilot, which has no IDE extension", () => {
  expect(
    resolveDevcontainerIdeAgents({
      agent: "claude",
      extraAgents: ["copilot"],
    }),
  ).toEqual(["claude"]);
});

test("resolveDevcontainerIdeAgents returns only the primary when there are no extraAgents", () => {
  expect(
    resolveDevcontainerIdeAgents({ agent: "codex", extraAgents: [] }),
  ).toEqual(["codex"]);
});

test("resolveDevcontainerIdeAgents dedupes a primary that also appears in extraAgents", () => {
  expect(
    resolveDevcontainerIdeAgents({
      agent: "claude",
      extraAgents: ["claude", "codex"],
    }),
  ).toEqual(["claude", "codex"]);
});
