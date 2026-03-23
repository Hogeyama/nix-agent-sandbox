/**
 * worktree teardown 時のインタラクティブプロンプト
 */

import * as path from "@std/path";
import { isWorktreeDirty } from "./git_helpers.ts";
import type { WorktreeEntry } from "./management.ts";

export type WorktreeAction = "keep" | "delete";
export type DirtyWorktreeAction = "stash" | "delete" | "keep";
export type BranchAction = "rename" | "cherry-pick" | "delete";

export async function promptWorktreeAction(
  worktreePath: string,
): Promise<WorktreeAction> {
  // 未コミットの変更があれば表示
  const dirty = await isWorktreeDirty(worktreePath);
  if (dirty) {
    console.log("[nas] ⚠ Worktree has uncommitted changes.");
  }

  console.log("[nas] What to do with the worktree?");
  console.log("  1. Delete");
  console.log("  2. Keep");

  while (true) {
    const answer = prompt("[nas] Choose [1/2]:")?.trim() ?? "";
    if (answer === "1") return "delete";
    if (answer === "2") return "keep";
    console.log("[nas] Please enter 1 or 2.");
  }
}

export async function promptDirtyWorktreeAction(
  worktreePath: string,
): Promise<DirtyWorktreeAction | null> {
  const dirty = await isWorktreeDirty(worktreePath);
  if (!dirty) return null;

  console.log("[nas] Worktree has uncommitted changes.");
  console.log("[nas] How should we handle them before deleting it?");
  console.log("  1. Stash and delete");
  console.log("  2. Delete without stashing");
  console.log("  3. Keep");

  while (true) {
    const answer = prompt("[nas] Choose [1/2/3]:")?.trim() ?? "";
    if (answer === "1") return "stash";
    if (answer === "2") return "delete";
    if (answer === "3") return "keep";
    console.log("[nas] Please enter 1, 2, or 3.");
  }
}

export async function promptBranchAction(
  branchName: string | null,
): Promise<BranchAction> {
  if (!branchName) return "delete";

  // ブランチ上のコミット数を表示（参考情報）
  const { default: $ } = await import("dax");
  try {
    const log = await $`git log --oneline ${branchName} --not --remotes -10`
      .text();
    if (log.trim()) {
      console.log(`[nas] Recent commits on ${branchName}:`);
      for (const line of log.trim().split("\n")) {
        console.log(`  ${line}`);
      }
    }
  } catch { /* ignore */ }

  console.log("[nas] What to do with the branch?");
  console.log("  1. Delete");
  console.log("  2. Cherry-pick to base branch");
  console.log("  3. Rename and keep");

  while (true) {
    const answer = prompt("[nas] Choose [1/2/3]:")?.trim() ?? "";
    if (answer === "1") return "delete";
    if (answer === "2") return "cherry-pick";
    if (answer === "3") return "rename";
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
  console.log(`  0. Create new worktree`);

  while (true) {
    const raw = prompt(`[nas] Choose [0-${entries.length}]:`);
    const answer = raw?.trim() ?? "";
    if (answer === "0" || answer === "") return null;
    const idx = parseInt(answer, 10);
    if (idx >= 1 && idx <= entries.length) return entries[idx - 1];
    console.log(`[nas] Please enter 0-${entries.length}.`);
  }
}

export async function stashDirtyWorktree(
  worktreePath: string,
): Promise<void> {
  const { default: $ } = await import("dax");
  const stashMessage = `nas teardown ${path.basename(worktreePath)} ${
    new Date().toISOString()
  }`;
  await $`git -C ${worktreePath} stash push --include-untracked -m ${stashMessage}`
    .printCommand();
  console.log(`[nas] Stashed worktree changes: ${stashMessage}`);
}
