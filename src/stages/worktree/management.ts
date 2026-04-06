/**
 * worktree の一覧取得・クリーンアップ（サブコマンド用）
 */

import { $ } from "bun";
import * as path from "node:path";
import { getGitRoot } from "./git_helpers.ts";

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string;
}

export interface CleanResult {
  worktrees: number;
  orphanBranches: number;
}

/** 現在のリポジトリの nas worktree を一覧取得 */
export async function listNasWorktrees(
  workDir: string,
): Promise<WorktreeEntry[]> {
  const repoRoot = await getGitRoot(workDir);
  const output = await $`git -C ${repoRoot} worktree list --porcelain`.text();
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "" && current.path) {
      const dirName = path.basename(current.path);
      if (dirName.startsWith("nas-")) {
        entries.push(current as WorktreeEntry);
      }
      current = {};
    }
  }

  // last entry (git worktree list doesn't always end with blank line)
  if (current.path && path.basename(current.path).startsWith("nas-")) {
    entries.push(current as WorktreeEntry);
  }

  return entries;
}

/** プロファイル名にマッチする既存 worktree を検索 */
export async function findProfileWorktrees(
  repoRoot: string,
  profileName: string,
): Promise<WorktreeEntry[]> {
  const all = await listNasWorktrees(repoRoot);
  const prefix = `nas-${profileName}-`;
  return all.filter((e) => path.basename(e.path).startsWith(prefix));
}

/** worktree に紐づかない nas/* ブランチを一覧取得 */
export async function listOrphanNasBranches(
  workDir: string,
): Promise<string[]> {
  const repoRoot = await getGitRoot(workDir);

  // stale な worktree 参照を先に片付ける
  await $`git -C ${repoRoot} worktree prune`.quiet();

  const pattern = "nas/*";
  const branchOutput = await $`git -C ${repoRoot} branch --list ${pattern}`
    .text();
  const allNasBranches = branchOutput
    .split("\n")
    .map((l) => l.trim().replace(/^[*+] /, ""))
    .filter((l) => l.length > 0);

  if (allNasBranches.length === 0) return [];

  const entries = await listNasWorktrees(workDir);
  const worktreeBranches = new Set(
    entries
      .filter((e) => e.branch)
      .map((e) => e.branch.replace("refs/heads/", "")),
  );

  return allNasBranches.filter((b) => !worktreeBranches.has(b));
}

/** nas worktree をすべて削除する */
export async function cleanNasWorktrees(
  workDir: string,
  opts: { force?: boolean; deleteBranch?: boolean } = {},
): Promise<CleanResult> {
  const repoRoot = await getGitRoot(workDir);
  const entries = await listNasWorktrees(workDir);
  const orphanBranches = opts.deleteBranch
    ? await listOrphanNasBranches(workDir)
    : [];

  if (entries.length === 0 && orphanBranches.length === 0) {
    console.log("[nas] No nas worktrees found.");
    return { worktrees: 0, orphanBranches: 0 };
  }

  if (!opts.force) {
    if (entries.length > 0) {
      console.log(`[nas] Found ${entries.length} nas worktree(s):`);
      for (const entry of entries) {
        const branch = entry.branch
          ? entry.branch.replace("refs/heads/", "")
          : "(detached)";
        console.log(`  ${entry.path}  [${branch}]`);
      }
    }
    if (orphanBranches.length > 0) {
      console.log(
        `[nas] Found ${orphanBranches.length} orphan nas branch(es):`,
      );
      for (const b of orphanBranches) {
        console.log(`  ${b}`);
      }
    }
    const action = opts.deleteBranch
      ? "Remove all (including branches)"
      : "Remove all";
    const ok = confirm(`[nas] ${action}?`);
    if (!ok) {
      console.log("[nas] Aborted.");
      return { worktrees: 0, orphanBranches: 0 };
    }
  }

  let removedWorktrees = 0;
  for (const entry of entries) {
    try {
      await $`git -C ${repoRoot} worktree remove --force ${entry.path}`;
      console.log(`[nas] Removed: ${entry.path}`);
      removedWorktrees++;

      if (opts.deleteBranch && entry.branch) {
        const branchName = entry.branch.replace("refs/heads/", "");
        try {
          await $`git -C ${repoRoot} branch -D ${branchName}`;
          console.log(`[nas] Deleted branch: ${branchName}`);
        } catch (err) {
          console.error(
            `[nas] Failed to delete branch ${branchName}: ${
              (err as Error).message
            }`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[nas] Failed to remove ${entry.path}: ${(err as Error).message}`,
      );
    }
  }

  let removedOrphans = 0;
  for (const branchName of orphanBranches) {
    try {
      await $`git -C ${repoRoot} branch -D ${branchName}`;
      console.log(`[nas] Deleted orphan branch: ${branchName}`);
      removedOrphans++;
    } catch (err) {
      console.error(
        `[nas] Failed to delete orphan branch ${branchName}: ${
          (err as Error).message
        }`,
      );
    }
  }

  return { worktrees: removedWorktrees, orphanBranches: removedOrphans };
}
