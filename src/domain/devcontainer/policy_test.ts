import { expect, test } from "bun:test";
import { devcontainerProfile } from "./fixtures.ts";
import { validateDevcontainerProfile } from "./policy.ts";

test("the default profile is accepted", () => {
  expect(validateDevcontainerProfile(devcontainerProfile())).toEqual([]);
});

test("docker.enable is accepted: the DinD sidecar runs outside the agent", () => {
  const profile = devcontainerProfile();
  expect(
    validateDevcontainerProfile({
      ...profile,
      docker: { ...profile.docker, enable: true },
    }),
  ).toEqual([]);
});

test("codex is accepted", () => {
  expect(
    validateDevcontainerProfile({
      ...devcontainerProfile(),
      agent: "codex",
    }),
  ).toEqual([]);
});

test("copilot is rejected: no devcontainer launch contract exists for it", () => {
  const errors = validateDevcontainerProfile({
    ...devcontainerProfile(),
    agent: "copilot",
  });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("claude or codex");
});

test("worktrees are rejected: init must run inside the worktree itself", () => {
  const errors = validateDevcontainerProfile({
    ...devcontainerProfile(),
    worktree: { base: "main", onCreate: "" },
  });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("worktree");
});

test("a primary Claude accepts an extra Codex, and rejects it only when explicitly injected", () => {
  const profile = {
    ...devcontainerProfile(),
    agent: "claude" as const,
    extraAgents: ["codex" as const],
  };
  expect(validateDevcontainerProfile(profile)).toEqual([]);
  for (const auth of ["injected", { codex: "injected" }] as const) {
    expect(
      validateDevcontainerProfile({
        ...profile,
        agentState: { protectSettings: false, auth },
      }).join("\n"),
    ).toContain("passthrough");
  }
});

test("a primary Codex accepts extra Claude and Copilot", () => {
  expect(
    validateDevcontainerProfile({
      ...devcontainerProfile(),
      agent: "codex",
      extraAgents: ["claude", "copilot"],
    }),
  ).toEqual([]);
});

test("validateDevcontainerProfile: rejects an explicit proxy for Codex", () => {
  const profile = {
    ...devcontainerProfile(),
    agent: "codex" as const,
    agentState: { protectSettings: false, auth: "injected" as const },
  };
  expect(validateDevcontainerProfile(profile)).toContain(
    'agentState.auth = "injected" is unsupported for Codex devcontainer sessions; use "passthrough"',
  );
});

test("validateDevcontainerProfile: rejects a per-agent proxy for Codex", () => {
  const profile = {
    ...devcontainerProfile(),
    agent: "codex" as const,
    agentState: {
      protectSettings: false,
      auth: { codex: "injected" as const },
    },
  };
  expect(validateDevcontainerProfile(profile)).toContain(
    'agentState.auth = "injected" is unsupported for Codex devcontainer sessions; use "passthrough"',
  );
  expect(
    validateDevcontainerProfile({
      ...profile,
      agentState: { protectSettings: false, auth: { claude: "injected" } },
    }),
  ).toEqual([]);
});

test("validateDevcontainerProfile: accepts Codex with auth unset", () => {
  const profile = { ...devcontainerProfile(), agent: "codex" as const };
  expect(validateDevcontainerProfile(profile)).toEqual([]);
});
