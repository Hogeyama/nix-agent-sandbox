import { expect, test } from "bun:test";
import { devcontainerProfile } from "./fixtures.ts";
import {
  validateDevcontainerMount,
  validateDevcontainerProfile,
} from "./policy.ts";
import type { DevcontainerMountPolicy } from "./types.ts";

test("profile rejects host integrations without rejecting review fallback or allow scopes", () => {
  const profile = devcontainerProfile();
  expect(validateDevcontainerProfile(profile)).toEqual([]);
  expect(
    validateDevcontainerProfile({
      ...profile,
      network: {
        ...profile.network,
        scopes: { public: { targets: ["example.com"], fallback: "allow" } },
      },
    }),
  ).toEqual([]);
  expect(
    validateDevcontainerProfile({
      ...profile,
      network: { ...profile.network, fallback: "review" },
    }),
  ).toEqual([]);
  expect(
    validateDevcontainerProfile({
      ...profile,
      nix: { ...profile.nix, enable: "auto" },
    }),
  ).toContain("nix.enable must be false for devcontainer sessions");
  const errors = validateDevcontainerProfile({
    ...profile,
    agent: "codex",
    docker: { ...profile.docker, enable: true },
    gpg: { forwardAgent: true },
    aws: { mountConfig: true },
    gcloud: { mountConfig: true },
    worktree: { base: "x", onCreate: "" },
  });
  for (const key of [
    "agent",
    "docker.enable",
    "gpg.forwardAgent",
    "aws.mountConfig",
    "gcloud.mountConfig",
    "worktree",
  ])
    expect(errors.some((e) => e.includes(key))).toBe(true);
});

const policy: DevcontainerMountPolicy = {
  home: "/home/a",
  hostOnlyPaths: ["/state/control"],
  credentialPaths: ["/home/a/.ssh", "/home/a/.config/git", "/run/docker.sock"],
  protectedTargets: [
    "/work/.devcontainer",
    "/home/nas/.claude",
    "/home/nas/.claude.json",
  ],
  dedicatedMounts: [
    { source: "/state/dedicated/claude", target: "/home/nas/.claude" },
  ],
};

test("canonical paths reject ancestors, descendants, credential aliases and protected target overlays", () => {
  for (const source of [
    "/home/a",
    "/home",
    "/state",
    "/state/control/token",
    "/home/a/.ssh/key",
    "/home/a/.config/git",
  ])
    expect(
      validateDevcontainerMount(source, "/data", policy).length,
    ).toBeGreaterThan(0);
  for (const target of [
    "/work",
    "/work/.devcontainer",
    "/work/.devcontainer/devcontainer.json",
    "/home/nas/.claude/session",
  ])
    expect(
      validateDevcontainerMount("/safe", target, policy).length,
    ).toBeGreaterThan(0);
  expect(validateDevcontainerMount("/home/ab", "/data", policy)).toEqual([]);
  expect(
    validateDevcontainerMount("/home/a/project", "/work/project", policy),
  ).toEqual([]);
  expect(
    validateDevcontainerMount(
      "/state/dedicated/claude",
      "/home/nas/.claude",
      policy,
    ),
  ).toEqual([]);
  expect(
    validateDevcontainerMount("/state/dedicated/claude", "/data", policy)
      .length,
  ).toBeGreaterThan(0);
});
