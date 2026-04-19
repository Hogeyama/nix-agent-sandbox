/**
 * parseProfileAndWorktreeArgs / applyWorktreeOverride tests.
 *
 * These functions sit between user CLI input and the rest of the nas
 * pipeline. A parse bug could silently route a worktree base to the wrong
 * argument slot or swallow agent args — worth exercising exhaustively.
 */

import { expect, test } from "bun:test";
import type { Profile } from "../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
} from "../config/types.ts";
import { applyWorktreeOverride, parseProfileAndWorktreeArgs } from "./args.ts";

// ---------------------------------------------------------------------------
// parseProfileAndWorktreeArgs
// ---------------------------------------------------------------------------

test("parse: empty input produces no profile and no override", () => {
  expect(parseProfileAndWorktreeArgs([])).toEqual({
    profileName: undefined,
    profileIndex: undefined,
    sessionName: undefined,
    worktreeOverride: { type: "none" },
    agentArgs: [],
  });
});

test("parse: first non-flag arg is the profile; later args go to agent", () => {
  const parsed = parseProfileAndWorktreeArgs([
    "myprofile",
    "-p",
    "hello",
    "--extra",
  ]);
  expect(parsed.profileName).toEqual("myprofile");
  expect(parsed.profileIndex).toEqual(0);
  expect(parsed.agentArgs).toEqual(["-p", "hello", "--extra"]);
});

test("parse: flags before profile do not enter agentArgs", () => {
  const parsed = parseProfileAndWorktreeArgs([
    "--no-worktree",
    "myprofile",
    "-p",
    "x",
  ]);
  expect(parsed.profileName).toEqual("myprofile");
  expect(parsed.profileIndex).toEqual(1);
  expect(parsed.agentArgs).toEqual(["-p", "x"]);
  expect(parsed.worktreeOverride).toEqual({ type: "disable" });
});

// ---------------------------------------------------------------------------
// --worktree / -b
// ---------------------------------------------------------------------------

test("parse: --worktree <branch> enables worktree with that base", () => {
  const parsed = parseProfileAndWorktreeArgs([
    "--worktree",
    "feature/x",
    "profile",
  ]);
  expect(parsed.worktreeOverride).toEqual({
    type: "enable",
    base: "feature/x",
  });
});

test("parse: -b <branch> enables worktree", () => {
  const parsed = parseProfileAndWorktreeArgs(["-b", "main", "profile"]);
  expect(parsed.worktreeOverride).toEqual({ type: "enable", base: "main" });
});

test("parse: -b@ / --worktree @ / --worktree HEAD all normalise to HEAD", () => {
  for (const arg of [
    ["--worktree", "@"],
    ["--worktree", "HEAD"],
    ["-b", "@"],
    ["-b", "HEAD"],
  ]) {
    const parsed = parseProfileAndWorktreeArgs([...arg, "profile"]);
    expect(parsed.worktreeOverride).toEqual({ type: "enable", base: "HEAD" });
  }
});

test("parse: -b<branch> (no space) enables worktree", () => {
  const parsed = parseProfileAndWorktreeArgs(["-bfeature/x", "profile"]);
  expect(parsed.worktreeOverride).toEqual({
    type: "enable",
    base: "feature/x",
  });
});

test("parse: --worktree missing value throws", () => {
  expect(() => parseProfileAndWorktreeArgs(["--worktree"])).toThrow(
    /branch name/,
  );
});

test("parse: --worktree followed by another flag throws", () => {
  expect(() => parseProfileAndWorktreeArgs(["--worktree", "--quiet"])).toThrow(
    /branch name/,
  );
});

test("parse: -b followed by another flag throws", () => {
  expect(() => parseProfileAndWorktreeArgs(["-b", "--quiet"])).toThrow(
    /branch name/,
  );
});

test("parse: -b-branch (inline flag-looking value) throws", () => {
  // `-b-foo` is ambiguous; args.ts treats the slice as "-foo" which starts
  // with `-` and must be rejected.
  expect(() => parseProfileAndWorktreeArgs(["-b-foo"])).toThrow(/branch name/);
});

// ---------------------------------------------------------------------------
// --name
// ---------------------------------------------------------------------------

test("parse: --name <value> sets sessionName", () => {
  const parsed = parseProfileAndWorktreeArgs(["--name", "my-session", "pro"]);
  expect(parsed.sessionName).toEqual("my-session");
  expect(parsed.profileName).toEqual("pro");
});

test("parse: --name missing value throws", () => {
  expect(() => parseProfileAndWorktreeArgs(["--name"])).toThrow(/session name/);
});

test("parse: --name followed by another flag throws", () => {
  expect(() => parseProfileAndWorktreeArgs(["--name", "--quiet"])).toThrow(
    /session name/,
  );
});

// ---------------------------------------------------------------------------
// --no-worktree
// ---------------------------------------------------------------------------

test("parse: --no-worktree sets disable override", () => {
  const parsed = parseProfileAndWorktreeArgs(["--no-worktree"]);
  expect(parsed.worktreeOverride).toEqual({ type: "disable" });
});

// ---------------------------------------------------------------------------
// Mixed / ordering
// ---------------------------------------------------------------------------

test("parse: flags after profile go into agentArgs verbatim", () => {
  const parsed = parseProfileAndWorktreeArgs([
    "profile",
    "-b",
    "this-goes-to-agent",
    "--worktree",
    "also-to-agent",
  ]);
  expect(parsed.worktreeOverride).toEqual({ type: "none" });
  expect(parsed.agentArgs).toEqual([
    "-b",
    "this-goes-to-agent",
    "--worktree",
    "also-to-agent",
  ]);
});

test("parse: --name and -b can be combined before profile", () => {
  const parsed = parseProfileAndWorktreeArgs([
    "--name",
    "alpha",
    "-b",
    "main",
    "profile",
    "extra",
  ]);
  expect(parsed.sessionName).toEqual("alpha");
  expect(parsed.worktreeOverride).toEqual({ type: "enable", base: "main" });
  expect(parsed.profileName).toEqual("profile");
  expect(parsed.agentArgs).toEqual(["extra"]);
});

// ---------------------------------------------------------------------------
// applyWorktreeOverride
// ---------------------------------------------------------------------------

function baseProfile(): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    worktree: { base: "main", onCreate: "echo hi" },
    nix: { enable: "auto", mountSocket: true, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
  };
}

test("applyWorktreeOverride: 'none' returns profile unchanged", () => {
  const p = baseProfile();
  expect(applyWorktreeOverride(p, { type: "none" })).toBe(p);
});

test("applyWorktreeOverride: 'disable' clears worktree config", () => {
  const p = baseProfile();
  const out = applyWorktreeOverride(p, { type: "disable" });
  expect(out.worktree).toBeUndefined();
  // original profile is unchanged
  expect(p.worktree).toEqual({ base: "main", onCreate: "echo hi" });
});

test("applyWorktreeOverride: 'enable' preserves existing onCreate", () => {
  const p = baseProfile();
  const out = applyWorktreeOverride(p, { type: "enable", base: "feature" });
  expect(out.worktree).toEqual({ base: "feature", onCreate: "echo hi" });
});

test("applyWorktreeOverride: 'enable' uses empty onCreate when profile had none", () => {
  const p: Profile = { ...baseProfile(), worktree: undefined };
  const out = applyWorktreeOverride(p, { type: "enable", base: "HEAD" });
  expect(out.worktree).toEqual({ base: "HEAD", onCreate: "" });
});
