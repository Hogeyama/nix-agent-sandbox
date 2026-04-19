/**
 * worktree teardown 時のインタラクティブプロンプト
 *
 * These functions are pure UI: they display information and collect user input.
 * Git I/O (dirty checks, commit lists) is done by GitWorktreeService before
 * calling these functions — the results are passed in as parameters.
 */

import type { WorktreeEntry } from "./git_worktree.ts";

export type WorktreeAction = "keep" | "delete";
export type DirtyWorktreeAction = "stash" | "delete" | "keep";
export type BranchAction = "rename" | "cherry-pick" | "delete";

export function promptWorktreeAction(
  _worktreePath: string,
  isDirty: boolean,
): WorktreeAction {
  if (isDirty) {
    console.log("[nas] ⚠ Worktree has uncommitted changes.");
  }

  console.log("[nas] What to do with the worktree?");
  console.log("  1. Delete");
  console.log("  2. Keep");

  while (true) {
    const answer = prompt("[nas] Choose [1/2]:");
    if (answer === null) {
      console.log("[nas] stdin closed, keeping worktree.");
      return "keep";
    }
    if (answer.trim() === "1") return "delete";
    if (answer.trim() === "2") return "keep";
    console.log("[nas] Please enter 1 or 2.");
  }
}

export function promptDirtyWorktreeAction(
  _worktreePath: string,
): DirtyWorktreeAction {
  console.log("[nas] Worktree has uncommitted changes.");
  console.log("[nas] How should we handle them before deleting it?");
  console.log("  1. Stash and delete");
  console.log("  2. Delete without stashing");
  console.log("  3. Keep");

  while (true) {
    const answer = prompt("[nas] Choose [1/2/3]:");
    if (answer === null) {
      console.log("[nas] stdin closed, keeping worktree.");
      return "keep";
    }
    if (answer.trim() === "1") return "stash";
    if (answer.trim() === "2") return "delete";
    if (answer.trim() === "3") return "keep";
    console.log("[nas] Please enter 1, 2, or 3.");
  }
}

export function promptBranchAction(
  branchName: string | null,
  commitLines: string[],
): BranchAction {
  if (!branchName) return "delete";

  if (commitLines.length > 0) {
    console.log(`[nas] Recent commits on ${branchName}:`);
    for (const line of commitLines) {
      console.log(`  ${line}`);
    }
  } else {
    console.log(`[nas] No unique commits on ${branchName}; deleting branch.`);
    return "delete";
  }

  console.log("[nas] What to do with the branch?");
  console.log("  1. Delete");
  console.log("  2. Cherry-pick to base branch");
  console.log("  3. Rename and keep");

  while (true) {
    const answer = prompt("[nas] Choose [1/2/3]:");
    if (answer === null) {
      console.log("[nas] stdin closed, keeping branch.");
      return "rename";
    }
    if (answer.trim() === "1") return "delete";
    if (answer.trim() === "2") return "cherry-pick";
    if (answer.trim() === "3") return "rename";
    console.log("[nas] Please enter 1, 2, or 3.");
  }
}

export function promptReuseWorktree(
  entries: WorktreeEntry[],
): WorktreeEntry | null {
  console.log("[nas] Existing worktree(s) found for this profile:");
  for (let i = 0; i < entries.length; i++) {
    const branch = entries[i].branch
      ? entries[i].branch.replace("refs/heads/", "")
      : "(detached)";
    console.log(`  ${i + 1}. ${entries[i].path}  [${branch}]`);
  }
  console.log("  0. Create new worktree");

  while (true) {
    const raw = prompt(`[nas] Choose [0-${entries.length}]:`);
    if (raw === null) {
      console.log("[nas] stdin closed, creating new worktree.");
      return null;
    }
    const answer = raw.trim();
    if (answer === "0" || answer === "") return null;
    const idx = parseInt(answer, 10);
    if (idx >= 1 && idx <= entries.length) return entries[idx - 1];
    console.log(`[nas] Please enter 0-${entries.length}.`);
  }
}
