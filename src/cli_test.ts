/**
 * CLI パース関数のユニットテスト
 * parseProfileAndWorktreeArgs / applyWorktreeOverride
 */

import { expect, test } from "bun:test";
import { applyWorktreeOverride, parseProfileAndWorktreeArgs } from "./cli.ts";
import type { Profile } from "./config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
} from "./config/types.ts";

const baseProfile: Profile = {
  agent: "claude",
  agentArgs: [],
  nix: { enable: false, mountSocket: false, extraPackages: [] },
  docker: { enable: false, shared: false },
  gcloud: { mountConfig: false },
  aws: { mountConfig: false },
  gpg: { forwardAgent: false },
  session: DEFAULT_SESSION_CONFIG,
  display: structuredClone(DEFAULT_DISPLAY_CONFIG),
  network: structuredClone(DEFAULT_NETWORK_CONFIG),
  dbus: structuredClone(DEFAULT_DBUS_CONFIG),
  hook: DEFAULT_HOOK_CONFIG,
  extraMounts: [],
  env: [],
};

// ============================================================
// parseProfileAndWorktreeArgs
// ============================================================

test("parseProfileAndWorktreeArgs: empty args", () => {
  const result = parseProfileAndWorktreeArgs([]);
  expect(result.profileName).toEqual(undefined);
  expect(result.profileIndex).toEqual(undefined);
  expect(result.worktreeOverride).toEqual({ type: "none" });
  expect(result.agentArgs).toEqual([]);
});

test("parseProfileAndWorktreeArgs: profile name only", () => {
  const result = parseProfileAndWorktreeArgs(["dev"]);
  expect(result.profileName).toEqual("dev");
  expect(result.profileIndex).toEqual(0);
  expect(result.worktreeOverride).toEqual({ type: "none" });
  expect(result.agentArgs).toEqual([]);
});

test("parseProfileAndWorktreeArgs: profile with agent args after it", () => {
  const result = parseProfileAndWorktreeArgs(["dev", "-p", "hello"]);
  expect(result.profileName).toEqual("dev");
  expect(result.profileIndex).toEqual(0);
  expect(result.agentArgs).toEqual(["-p", "hello"]);
});

test("parseProfileAndWorktreeArgs: --worktree with branch", () => {
  const result = parseProfileAndWorktreeArgs(["--worktree", "main"]);
  expect(result.profileName).toEqual(undefined);
  expect(result.worktreeOverride).toEqual({ type: "enable", base: "main" });
});

test("parseProfileAndWorktreeArgs: -b with branch", () => {
  const result = parseProfileAndWorktreeArgs(["-b", "feature/login"]);
  expect(result.worktreeOverride).toEqual({
    type: "enable",
    base: "feature/login",
  });
});

test("parseProfileAndWorktreeArgs: -b short form (no space)", () => {
  const result = parseProfileAndWorktreeArgs(["-bfeature/login"]);
  expect(result.worktreeOverride).toEqual({
    type: "enable",
    base: "feature/login",
  });
});

test("parseProfileAndWorktreeArgs: -b@ normalizes to HEAD", () => {
  const result = parseProfileAndWorktreeArgs(["-b@"]);
  expect(result.profileName).toEqual(undefined);
  expect(result.worktreeOverride).toEqual({ type: "enable", base: "HEAD" });
  expect(result.agentArgs).toEqual([]);
});

test("parseProfileAndWorktreeArgs: -b @ normalizes to HEAD", () => {
  const result = parseProfileAndWorktreeArgs(["-b", "@"]);
  expect(result.worktreeOverride).toEqual({ type: "enable", base: "HEAD" });
});

test("parseProfileAndWorktreeArgs: -b HEAD stays HEAD", () => {
  const result = parseProfileAndWorktreeArgs(["-b", "HEAD"]);
  expect(result.worktreeOverride).toEqual({ type: "enable", base: "HEAD" });
});

test("parseProfileAndWorktreeArgs: --no-worktree", () => {
  const result = parseProfileAndWorktreeArgs(["--no-worktree"]);
  expect(result.worktreeOverride).toEqual({ type: "disable" });
});

test("parseProfileAndWorktreeArgs: --worktree before profile", () => {
  const result = parseProfileAndWorktreeArgs(["--worktree", "main", "dev"]);
  expect(result.profileName).toEqual("dev");
  expect(result.worktreeOverride).toEqual({ type: "enable", base: "main" });
});

test("parseProfileAndWorktreeArgs: --no-worktree before profile", () => {
  const result = parseProfileAndWorktreeArgs(["--no-worktree", "dev"]);
  expect(result.profileName).toEqual("dev");
  expect(result.worktreeOverride).toEqual({ type: "disable" });
});

test("parseProfileAndWorktreeArgs: captures profile after worktree options", () => {
  const result = parseProfileAndWorktreeArgs(["-b", "@", "my-profile"]);
  expect(result.profileName).toEqual("my-profile");
  expect(result.worktreeOverride).toEqual({ type: "enable", base: "HEAD" });
  expect(result.agentArgs).toEqual([]);
});

test("parseProfileAndWorktreeArgs: profile then agent args including flags", () => {
  const result = parseProfileAndWorktreeArgs([
    "dev",
    "--resume=session-123",
    "-v",
  ]);
  expect(result.profileName).toEqual("dev");
  expect(result.agentArgs).toEqual(["--resume=session-123", "-v"]);
});

test("parseProfileAndWorktreeArgs: collects agent args after profile", () => {
  const result = parseProfileAndWorktreeArgs([
    "-b",
    "feature/base",
    "copilot",
    "--resume=2b2155c8-e59b-4c76-b1df-7f9d14aeecfb",
    "-p",
    "continue",
  ]);
  expect(result.profileName).toEqual("copilot");
  expect(result.worktreeOverride).toEqual({
    type: "enable",
    base: "feature/base",
  });
  expect(result.agentArgs).toEqual([
    "--resume=2b2155c8-e59b-4c76-b1df-7f9d14aeecfb",
    "-p",
    "continue",
  ]);
});

test("parseProfileAndWorktreeArgs: treats nas-style flags after profile as agent args", () => {
  const result = parseProfileAndWorktreeArgs([
    "copilot",
    "--no-worktree",
    "-b",
    "feature/agent-side",
  ]);
  expect(result.profileName).toEqual("copilot");
  expect(result.worktreeOverride).toEqual({ type: "none" });
  expect(result.agentArgs).toEqual([
    "--no-worktree",
    "-b",
    "feature/agent-side",
  ]);
});

test("parseProfileAndWorktreeArgs: --worktree without branch throws", () => {
  expect(() => parseProfileAndWorktreeArgs(["--worktree"])).toThrow(
    "requires a branch name",
  );
});

test("parseProfileAndWorktreeArgs: -b without branch throws", () => {
  expect(() => parseProfileAndWorktreeArgs(["-b"])).toThrow(
    "requires a branch name",
  );
});

test("parseProfileAndWorktreeArgs: --worktree with flag-like branch throws", () => {
  expect(() =>
    parseProfileAndWorktreeArgs(["--worktree", "--something"]),
  ).toThrow("requires a branch name");
});

test("parseProfileAndWorktreeArgs: -b with flag-like value throws", () => {
  expect(() => parseProfileAndWorktreeArgs(["-b", "-x"])).toThrow(
    "requires a branch name",
  );
});

test("parseProfileAndWorktreeArgs: -b short form with flag-like value throws", () => {
  expect(() => parseProfileAndWorktreeArgs(["-b-x"])).toThrow(
    "requires a branch name",
  );
});

// ============================================================
// applyWorktreeOverride
// ============================================================

test("applyWorktreeOverride: none returns profile unchanged", () => {
  const result = applyWorktreeOverride(baseProfile, { type: "none" });
  expect(result).toEqual(baseProfile);
});

test("applyWorktreeOverride: disable removes worktree", () => {
  const profile: Profile = {
    ...baseProfile,
    worktree: { base: "main", onCreate: "" },
  };
  const result = applyWorktreeOverride(profile, { type: "disable" });
  expect(result.worktree).toEqual(undefined);
});

test("applyWorktreeOverride: enable sets worktree with base", () => {
  const result = applyWorktreeOverride(baseProfile, {
    type: "enable",
    base: "feature/x",
  });
  expect(result.worktree?.base).toEqual("feature/x");
  expect(result.worktree?.onCreate).toEqual("");
});

test("applyWorktreeOverride: enable preserves existing onCreate", () => {
  const profile: Profile = {
    ...baseProfile,
    worktree: { base: "main", onCreate: "npm install" },
  };
  const result = applyWorktreeOverride(profile, {
    type: "enable",
    base: "develop",
  });
  expect(result.worktree?.base).toEqual("develop");
  expect(result.worktree?.onCreate).toEqual("npm install");
});

test("applyWorktreeOverride: enable without existing worktree uses empty onCreate", () => {
  const result = applyWorktreeOverride(baseProfile, {
    type: "enable",
    base: "main",
  });
  expect(result.worktree?.onCreate).toEqual("");
});
