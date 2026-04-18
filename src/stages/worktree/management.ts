/**
 * worktree の一覧取得・クリーンアップ（サブコマンド用）
 */

import * as path from "node:path";
import { $ } from "bun";
import { getGitRoot } from "./git_helpers.ts";

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string;
  /** branch 作成時に記録された base ref。不明な場合は null。 */
  base: string | null;
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

  const finalize = (entry: Partial<WorktreeEntry>): void => {
    if (!entry.path) return;
    if (!path.basename(entry.path).startsWith("nas-")) return;
    entries.push({
      path: entry.path,
      head: entry.head ?? "",
      branch: entry.branch ?? "",
      base: null,
    });
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "" && current.path) {
      finalize(current);
      current = {};
    }
  }

  // last entry (git worktree list doesn't always end with blank line)
  finalize(current);

  // 各エントリについて branch 作成時に保存した base ref を読み出す
  for (const entry of entries) {
    if (!entry.branch) continue;
    const branchName = entry.branch.replace("refs/heads/", "");
    entry.base = await readBranchBase(repoRoot, branchName);
  }

  return entries;
}

/** branch 作成時に git config へ保存した base ref を取得 */
async function readBranchBase(
  repoRoot: string,
  branchName: string,
): Promise<string | null> {
  try {
    const value =
      await $`git -C ${repoRoot} config --get ${`branch.${branchName}.nasBase`}`
        .quiet()
        .text();
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // exit code 1 = key not found — 過去に作成した worktree には記録がない
    return null;
  }
}

/** worktree に紐づかない nas/* ブランチを一覧取得 */
export async function listOrphanNasBranches(
  workDir: string,
): Promise<string[]> {
  const repoRoot = await getGitRoot(workDir);

  // stale な worktree 参照を先に片付ける
  await $`git -C ${repoRoot} worktree prune`.quiet();

  const pattern = "nas/*";
  const branchOutput =
    await $`git -C ${repoRoot} branch --list ${pattern}`.text();
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
