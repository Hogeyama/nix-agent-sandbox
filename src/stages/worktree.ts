/**
 * git worktree ステージ
 */

import $ from "dax";
import * as path from "@std/path";
import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import type { WorktreeCleanup } from "../config/types.ts";

export class WorktreeStage implements Stage {
  name = "WorktreeStage";

  /** execute で作成した worktree のパス（teardown 用） */
  private worktreePath: string | null = null;
  private repoRoot: string | null = null;
  private cleanup: WorktreeCleanup = "auto";

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    const wt = ctx.profile.worktree;
    if (!wt) {
      console.log("[nas] Worktree: skipped (not configured)");
      return ctx;
    }

    this.cleanup = wt.cleanup;

    const repoRoot = await getGitRoot(ctx.workDir);
    this.repoRoot = repoRoot;

    await validateBaseBranch(repoRoot, wt.base);

    const worktreeName = generateWorktreeName(ctx.profileName);
    const branchName = generateBranchName(ctx.profileName);
    // .git/nas-worktrees/ 内に作成 → 元リポのマウントだけで完結する
    const worktreePath = path.join(repoRoot, ".git", "nas-worktrees", worktreeName);
    this.worktreePath = worktreePath;

    console.log(
      `[nas] Creating worktree: ${worktreePath} (branch: ${branchName}) from ${wt.base}`,
    );
    await $`git -C ${repoRoot} worktree add -b ${branchName} ${worktreePath} ${wt.base}`
      .printCommand();

    if (wt.onCreate) {
      console.log(`[nas] Running on-create hook: ${wt.onCreate}`);
      await $`bash -c ${wt.onCreate}`.cwd(worktreePath).printCommand();
    }

    // worktree は元リポの .git/nas-worktrees/ 内に作成される。
    // mountDir に元リポを指定すれば 1 つのマウントで
    // working tree・git metadata・オブジェクト DB すべてが解決する。
    return { ...ctx, workDir: worktreePath, mountDir: repoRoot };
  }

  async teardown(_ctx: ExecutionContext): Promise<void> {
    if (!this.worktreePath || !this.repoRoot) return;

    if (this.cleanup === "keep") {
      console.log(`[nas] Worktree kept: ${this.worktreePath}`);
      return;
    }

    if (this.cleanup === "auto") {
      const dirty = await isWorktreeDirty(this.worktreePath);
      if (dirty) {
        console.log(
          `[nas] Worktree has uncommitted changes, keeping: ${this.worktreePath}`,
        );
        return;
      }
    }

    // cleanup === "force" or (cleanup === "auto" && clean)
    console.log(`[nas] Removing worktree: ${this.worktreePath}`);
    try {
      await $`git -C ${this.repoRoot} worktree remove --force ${this.worktreePath}`;
    } catch (err) {
      console.error(
        `[nas] Failed to remove worktree: ${(err as Error).message}`,
      );
    }
  }
}

async function getGitRoot(dir: string): Promise<string> {
  try {
    const result = await $`git -C ${dir} rev-parse --show-toplevel`.text();
    return result.trim();
  } catch {
    throw new Error(
      `"${dir}" is not inside a git repository. Worktree requires a git repo.`,
    );
  }
}

async function validateBaseBranch(
  repoRoot: string,
  base: string,
): Promise<void> {
  try {
    await $`git -C ${repoRoot} rev-parse --verify ${base}`.quiet("both");
  } catch {
    throw new Error(
      `Base ref "${base}" not found. Run "git fetch" to update remote refs.`,
    );
  }
}

async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const status = await $`git -C ${worktreePath} status --porcelain`.text();
  return status.trim().length > 0;
}

function generateWorktreeName(profileName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `nas-${profileName}-${ts}`;
}

function generateBranchName(profileName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `nas/${profileName}/${ts}`;
}

// --- Worktree management (subcommand) ---

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string;
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

/** nas worktree をすべて削除する */
export async function cleanNasWorktrees(
  workDir: string,
  opts: { force?: boolean; deleteBranch?: boolean } = {},
): Promise<number> {
  const repoRoot = await getGitRoot(workDir);
  const entries = await listNasWorktrees(workDir);

  if (entries.length === 0) {
    console.log("[nas] No nas worktrees found.");
    return 0;
  }

  if (!opts.force) {
    console.log(`[nas] Found ${entries.length} nas worktree(s):`);
    for (const entry of entries) {
      const branch = entry.branch
        ? entry.branch.replace("refs/heads/", "")
        : "(detached)";
      console.log(`  ${entry.path}  [${branch}]`);
    }
    const action = opts.deleteBranch ? "Remove all (including branches)" : "Remove all";
    const ok = confirm(`[nas] ${action}?`);
    if (!ok) {
      console.log("[nas] Aborted.");
      return 0;
    }
  }

  let removed = 0;
  for (const entry of entries) {
    try {
      await $`git -C ${repoRoot} worktree remove --force ${entry.path}`;
      console.log(`[nas] Removed: ${entry.path}`);
      removed++;

      if (opts.deleteBranch && entry.branch) {
        const branchName = entry.branch.replace("refs/heads/", "");
        try {
          await $`git -C ${repoRoot} branch -D ${branchName}`;
          console.log(`[nas] Deleted branch: ${branchName}`);
        } catch (err) {
          console.error(
            `[nas] Failed to delete branch ${branchName}: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[nas] Failed to remove ${entry.path}: ${(err as Error).message}`,
      );
    }
  }

  return removed;
}
