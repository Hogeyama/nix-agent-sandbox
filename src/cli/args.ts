/**
 * プロファイル・worktree 引数パース
 */

import type { Profile } from "../config/types.ts";

export type WorktreeOverride =
  | { type: "none" }
  | { type: "enable"; base: string }
  | { type: "disable" };

export interface ParsedMainArgs {
  profileName?: string;
  profileIndex?: number;
  worktreeOverride: WorktreeOverride;
  agentArgs: string[];
}

export function parseProfileAndWorktreeArgs(nasArgs: string[]): ParsedMainArgs {
  let profileName: string | undefined;
  let profileIndex: number | undefined;
  let worktreeOverride: WorktreeOverride = { type: "none" };
  const agentArgs: string[] = [];

  for (let i = 0; i < nasArgs.length; i++) {
    const arg = nasArgs[i];
    if (profileName !== undefined) {
      agentArgs.push(arg);
      continue;
    }
    if (arg === "--worktree" || arg === "-b") {
      const branch = nasArgs[i + 1];
      if (!branch || branch.startsWith("-")) {
        throw new Error("--worktree/-b requires a branch name.");
      }
      i++;
      worktreeOverride = {
        type: "enable",
        base: normalizeWorktreeBase(branch),
      };
      continue;
    }
    if (arg.startsWith("-b") && arg.length > 2) {
      const branch = arg.slice(2);
      if (branch.startsWith("-")) {
        throw new Error("--worktree/-b requires a branch name.");
      }
      worktreeOverride = {
        type: "enable",
        base: normalizeWorktreeBase(branch),
      };
      continue;
    }
    if (arg === "--no-worktree") {
      worktreeOverride = { type: "disable" };
      continue;
    }
    if (!arg.startsWith("-") && profileName === undefined) {
      profileName = arg;
      profileIndex = i;
    }
  }

  return { profileName, profileIndex, worktreeOverride, agentArgs };
}

export function applyWorktreeOverride(
  profile: Profile,
  override: WorktreeOverride,
): Profile {
  if (override.type === "none") return profile;
  if (override.type === "disable") {
    return { ...profile, worktree: undefined };
  }
  const onCreate = profile.worktree?.onCreate ?? "";
  return { ...profile, worktree: { base: override.base, onCreate } };
}

function normalizeWorktreeBase(branch: string): string {
  if (branch === "@" || branch === "HEAD") return "HEAD";
  return branch;
}
