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

test("non-claude agents are rejected", () => {
  const errors = validateDevcontainerProfile({
    ...devcontainerProfile(),
    agent: "codex",
  });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("claude");
});

test("worktrees are rejected: init must run inside the worktree itself", () => {
  const errors = validateDevcontainerProfile({
    ...devcontainerProfile(),
    worktree: { base: "main", onCreate: "" },
  });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("worktree");
});
