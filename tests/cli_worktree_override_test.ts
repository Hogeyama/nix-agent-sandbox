import { assertEquals, assertThrows } from "@std/assert";
import {
  applyWorktreeOverride,
  parseProfileAndWorktreeArgs,
} from "../src/cli.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/config/types.ts";
import type { Profile } from "../src/config/types.ts";

function createProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    worktree: overrides.worktree ??
      { base: "origin/main", onCreate: "echo hook" },
    nix: overrides.nix ??
      { enable: "auto", mountSocket: true, extraPackages: [] },
    docker: overrides.docker ?? { enable: false, shared: false },
    gcloud: overrides.gcloud ?? { mountConfig: false },
    aws: overrides.aws ?? { mountConfig: false },
    gpg: overrides.gpg ?? { forwardAgent: false },
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    extraMounts: overrides.extraMounts ?? [],
    env: overrides.env ?? [],
  };
}

Deno.test("parseProfileAndWorktreeArgs keeps defaults when unspecified", () => {
  const result = parseProfileAndWorktreeArgs([]);
  assertEquals(result.profileName, undefined);
  assertEquals(result.worktreeOverride, { type: "none" });
  assertEquals(result.agentArgs, []);
});

Deno.test("parseProfileAndWorktreeArgs captures profile after worktree options", () => {
  const result = parseProfileAndWorktreeArgs(["-b", "@", "my-profile"]);
  assertEquals(result.profileName, "my-profile");
  assertEquals(result.worktreeOverride, { type: "enable", base: "HEAD" });
  assertEquals(result.agentArgs, []);
});

Deno.test("parseProfileAndWorktreeArgs supports combined short option with HEAD alias", () => {
  const result = parseProfileAndWorktreeArgs(["-b@"]);
  assertEquals(result.profileName, undefined);
  assertEquals(result.worktreeOverride, { type: "enable", base: "HEAD" });
  assertEquals(result.agentArgs, []);
});

Deno.test("parseProfileAndWorktreeArgs supports combined short option with branch name", () => {
  const result = parseProfileAndWorktreeArgs(["-bfeature/login", "my-profile"]);
  assertEquals(result.profileName, "my-profile");
  assertEquals(result.worktreeOverride, {
    type: "enable",
    base: "feature/login",
  });
  assertEquals(result.agentArgs, []);
});

Deno.test("parseProfileAndWorktreeArgs supports disabling worktree", () => {
  const result = parseProfileAndWorktreeArgs(["--no-worktree"]);
  assertEquals(result.profileName, undefined);
  assertEquals(result.worktreeOverride, { type: "disable" });
  assertEquals(result.agentArgs, []);
});

Deno.test("parseProfileAndWorktreeArgs collects agent args after profile", () => {
  const result = parseProfileAndWorktreeArgs([
    "-b",
    "feature/base",
    "copilot",
    "--resume=2b2155c8-e59b-4c76-b1df-7f9d14aeecfb",
    "-p",
    "continue",
  ]);
  assertEquals(result.profileName, "copilot");
  assertEquals(result.worktreeOverride, {
    type: "enable",
    base: "feature/base",
  });
  assertEquals(result.agentArgs, [
    "--resume=2b2155c8-e59b-4c76-b1df-7f9d14aeecfb",
    "-p",
    "continue",
  ]);
});

Deno.test("parseProfileAndWorktreeArgs treats nas-style flags after profile as agent args", () => {
  const result = parseProfileAndWorktreeArgs([
    "copilot",
    "--no-worktree",
    "-b",
    "feature/agent-side",
  ]);
  assertEquals(result.profileName, "copilot");
  assertEquals(result.worktreeOverride, { type: "none" });
  assertEquals(result.agentArgs, [
    "--no-worktree",
    "-b",
    "feature/agent-side",
  ]);
});

Deno.test("parseProfileAndWorktreeArgs throws when branch is missing", () => {
  assertThrows(
    () => parseProfileAndWorktreeArgs(["-b"]),
    Error,
    "requires a branch name",
  );
});

Deno.test("applyWorktreeOverride enables with preserved on-create hook", () => {
  const profile = createProfile();
  const result = applyWorktreeOverride(profile, {
    type: "enable",
    base: "feature/login",
  });
  assertEquals(result.worktree, {
    base: "feature/login",
    onCreate: "echo hook",
  });
});

Deno.test("applyWorktreeOverride disables worktree config", () => {
  const profile = createProfile();
  const result = applyWorktreeOverride(profile, { type: "disable" });
  assertEquals(result.worktree, undefined);
});
