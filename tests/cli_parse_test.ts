/**
 * CLI パース関数のユニットテスト
 * parseProfileAndWorktreeArgs / applyWorktreeOverride
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  applyWorktreeOverride,
  parseProfileAndWorktreeArgs,
} from "../src/cli.ts";
import type { Profile } from "../src/config/types.ts";

const baseProfile: Profile = {
  agent: "claude",
  agentArgs: [],
  nix: { enable: false, mountSocket: false, extraPackages: [] },
  docker: { enable: false, shared: false },
  gcloud: { mountConfig: false },
  aws: { mountConfig: false },
  gpg: { forwardAgent: false },
  extraMounts: [],
  env: [],
};

// ============================================================
// parseProfileAndWorktreeArgs
// ============================================================

Deno.test("parseProfileAndWorktreeArgs: empty args", () => {
  const result = parseProfileAndWorktreeArgs([]);
  assertEquals(result.profileName, undefined);
  assertEquals(result.profileIndex, undefined);
  assertEquals(result.worktreeOverride, { type: "none" });
  assertEquals(result.agentArgs, []);
});

Deno.test("parseProfileAndWorktreeArgs: profile name only", () => {
  const result = parseProfileAndWorktreeArgs(["dev"]);
  assertEquals(result.profileName, "dev");
  assertEquals(result.profileIndex, 0);
  assertEquals(result.worktreeOverride, { type: "none" });
  assertEquals(result.agentArgs, []);
});

Deno.test("parseProfileAndWorktreeArgs: profile with agent args after it", () => {
  const result = parseProfileAndWorktreeArgs(["dev", "-p", "hello"]);
  assertEquals(result.profileName, "dev");
  assertEquals(result.profileIndex, 0);
  assertEquals(result.agentArgs, ["-p", "hello"]);
});

Deno.test("parseProfileAndWorktreeArgs: --worktree with branch", () => {
  const result = parseProfileAndWorktreeArgs(["--worktree", "main"]);
  assertEquals(result.profileName, undefined);
  assertEquals(result.worktreeOverride, { type: "enable", base: "main" });
});

Deno.test("parseProfileAndWorktreeArgs: -b with branch", () => {
  const result = parseProfileAndWorktreeArgs(["-b", "feature/login"]);
  assertEquals(result.worktreeOverride, {
    type: "enable",
    base: "feature/login",
  });
});

Deno.test("parseProfileAndWorktreeArgs: -b short form (no space)", () => {
  const result = parseProfileAndWorktreeArgs(["-bfeature/login"]);
  assertEquals(result.worktreeOverride, {
    type: "enable",
    base: "feature/login",
  });
});

Deno.test("parseProfileAndWorktreeArgs: -b @ normalizes to HEAD", () => {
  const result = parseProfileAndWorktreeArgs(["-b", "@"]);
  assertEquals(result.worktreeOverride, { type: "enable", base: "HEAD" });
});

Deno.test("parseProfileAndWorktreeArgs: -b HEAD stays HEAD", () => {
  const result = parseProfileAndWorktreeArgs(["-b", "HEAD"]);
  assertEquals(result.worktreeOverride, { type: "enable", base: "HEAD" });
});

Deno.test("parseProfileAndWorktreeArgs: --no-worktree", () => {
  const result = parseProfileAndWorktreeArgs(["--no-worktree"]);
  assertEquals(result.worktreeOverride, { type: "disable" });
});

Deno.test("parseProfileAndWorktreeArgs: --worktree before profile", () => {
  const result = parseProfileAndWorktreeArgs([
    "--worktree",
    "main",
    "dev",
  ]);
  assertEquals(result.profileName, "dev");
  assertEquals(result.worktreeOverride, { type: "enable", base: "main" });
});

Deno.test("parseProfileAndWorktreeArgs: --no-worktree before profile", () => {
  const result = parseProfileAndWorktreeArgs(["--no-worktree", "dev"]);
  assertEquals(result.profileName, "dev");
  assertEquals(result.worktreeOverride, { type: "disable" });
});

Deno.test("parseProfileAndWorktreeArgs: profile then agent args including flags", () => {
  const result = parseProfileAndWorktreeArgs([
    "dev",
    "--resume=session-123",
    "-v",
  ]);
  assertEquals(result.profileName, "dev");
  assertEquals(result.agentArgs, ["--resume=session-123", "-v"]);
});

Deno.test("parseProfileAndWorktreeArgs: --worktree without branch throws", () => {
  assertThrows(
    () => parseProfileAndWorktreeArgs(["--worktree"]),
    Error,
    "requires a branch name",
  );
});

Deno.test("parseProfileAndWorktreeArgs: -b without branch throws", () => {
  assertThrows(
    () => parseProfileAndWorktreeArgs(["-b"]),
    Error,
    "requires a branch name",
  );
});

Deno.test("parseProfileAndWorktreeArgs: --worktree with flag-like branch throws", () => {
  assertThrows(
    () => parseProfileAndWorktreeArgs(["--worktree", "--something"]),
    Error,
    "requires a branch name",
  );
});

Deno.test("parseProfileAndWorktreeArgs: -b with flag-like value throws", () => {
  assertThrows(
    () => parseProfileAndWorktreeArgs(["-b", "-x"]),
    Error,
    "requires a branch name",
  );
});

Deno.test("parseProfileAndWorktreeArgs: -b short form with flag-like value throws", () => {
  assertThrows(
    () => parseProfileAndWorktreeArgs(["-b-x"]),
    Error,
    "requires a branch name",
  );
});

// ============================================================
// applyWorktreeOverride
// ============================================================

Deno.test("applyWorktreeOverride: none returns profile unchanged", () => {
  const result = applyWorktreeOverride(baseProfile, { type: "none" });
  assertEquals(result, baseProfile);
});

Deno.test("applyWorktreeOverride: disable removes worktree", () => {
  const profile: Profile = {
    ...baseProfile,
    worktree: { base: "main", onCreate: "" },
  };
  const result = applyWorktreeOverride(profile, { type: "disable" });
  assertEquals(result.worktree, undefined);
});

Deno.test("applyWorktreeOverride: enable sets worktree with base", () => {
  const result = applyWorktreeOverride(baseProfile, {
    type: "enable",
    base: "feature/x",
  });
  assertEquals(result.worktree?.base, "feature/x");
  assertEquals(result.worktree?.onCreate, "");
});

Deno.test("applyWorktreeOverride: enable preserves existing onCreate", () => {
  const profile: Profile = {
    ...baseProfile,
    worktree: { base: "main", onCreate: "npm install" },
  };
  const result = applyWorktreeOverride(profile, {
    type: "enable",
    base: "develop",
  });
  assertEquals(result.worktree?.base, "develop");
  assertEquals(result.worktree?.onCreate, "npm install");
});

Deno.test("applyWorktreeOverride: enable without existing worktree uses empty onCreate", () => {
  const result = applyWorktreeOverride(baseProfile, {
    type: "enable",
    base: "main",
  });
  assertEquals(result.worktree?.onCreate, "");
});
