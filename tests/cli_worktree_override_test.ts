import { assertEquals, assertThrows } from "@std/assert";
import {
  applyWorktreeOverride,
  parseProfileAndWorktreeArgs,
} from "../src/cli.ts";
import type { Profile } from "../src/config/types.ts";

function createProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    worktree: overrides.worktree ?? { base: "origin/main", onCreate: "echo hook" },
    nix: overrides.nix ?? { enable: "auto", mountSocket: true, extraPackages: [] },
    docker: overrides.docker ?? { enable: false, shared: false },
    gcloud: overrides.gcloud ?? { mountConfig: false },
    aws: overrides.aws ?? { mountConfig: false },
    gpg: overrides.gpg ?? { forwardAgent: false },
    extraMounts: overrides.extraMounts ?? [],
    env: overrides.env ?? [],
  };
}

Deno.test("parseProfileAndWorktreeArgs keeps defaults when unspecified", () => {
  const result = parseProfileAndWorktreeArgs([]);
  assertEquals(result.profileName, undefined);
  assertEquals(result.worktreeOverride, { type: "none" });
});

Deno.test("parseProfileAndWorktreeArgs captures profile and HEAD alias", () => {
  const result = parseProfileAndWorktreeArgs(["my-profile", "-b", "@"]);
  assertEquals(result.profileName, "my-profile");
  assertEquals(result.worktreeOverride, { type: "enable", base: "HEAD" });
});

Deno.test("parseProfileAndWorktreeArgs supports combined short option with HEAD alias", () => {
  const result = parseProfileAndWorktreeArgs(["-b@"]);
  assertEquals(result.profileName, undefined);
  assertEquals(result.worktreeOverride, { type: "enable", base: "HEAD" });
});

Deno.test("parseProfileAndWorktreeArgs supports combined short option with branch name", () => {
  const result = parseProfileAndWorktreeArgs(["-bfeature/login"]);
  assertEquals(result.profileName, undefined);
  assertEquals(result.worktreeOverride, {
    type: "enable",
    base: "feature/login",
  });
});

Deno.test("parseProfileAndWorktreeArgs supports disabling worktree", () => {
  const result = parseProfileAndWorktreeArgs(["--no-worktree"]);
  assertEquals(result.profileName, undefined);
  assertEquals(result.worktreeOverride, { type: "disable" });
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
