/**
 * nas worktree サブコマンド
 */

import { cleanNasWorktrees, listNasWorktrees } from "../stages/worktree.ts";
import { exitOnCliError } from "./helpers.ts";

export async function runWorktreeCommand(nasArgs: string[]): Promise<void> {
  const sub = nasArgs.find((a) => !a.startsWith("-"));
  const force = nasArgs.includes("--force") || nasArgs.includes("-f");
  const deleteBranch = nasArgs.includes("--delete-branch") ||
    nasArgs.includes("-B");

  try {
    if (sub === "list" || sub === undefined) {
      const entries = await listNasWorktrees(process.cwd());
      if (entries.length === 0) {
        console.log("[nas] No nas worktrees found.");
        return;
      }
      for (const e of entries) {
        const branch = e.branch
          ? e.branch.replace("refs/heads/", "")
          : "(detached)";
        console.log(`  ${e.path}  [${branch}]  ${e.head.slice(0, 8)}`);
      }
    } else if (sub === "clean") {
      const result = await cleanNasWorktrees(process.cwd(), {
        force,
        deleteBranch,
      });
      const parts: string[] = [];
      if (result.worktrees > 0) {
        parts.push(`${result.worktrees} worktree(s)`);
      }
      if (result.orphanBranches > 0) {
        parts.push(`${result.orphanBranches} orphan branch(es)`);
      }
      if (parts.length > 0) {
        console.log(`[nas] Removed ${parts.join(", ")}.`);
      }
    } else {
      console.error(`[nas] Unknown worktree subcommand: ${sub}`);
      console.error(
        "  Usage: nas worktree [list|clean] [--force] [--delete-branch]",
      );
      process.exit(1);
    }
  } catch (err) {
    exitOnCliError(err);
  }
}
