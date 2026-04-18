/**
 * git worktree 関連のヘルパー関数
 */

import { $ } from "bun";

export async function getGitRoot(dir: string): Promise<string> {
  try {
    const result = await $`git -C ${dir} rev-parse --show-toplevel`.text();
    return result.trim();
  } catch {
    throw new Error(
      `"${dir}" is not inside a git repository. Worktree requires a git repo.`,
    );
  }
}

/**
 * "HEAD" を現在のブランチ名に解決する。それ以外はそのまま返す。
 */
export async function resolveBase(
  repoRoot: string,
  base: string,
): Promise<string> {
  if (base !== "HEAD") return base;
  try {
    const branch = (
      await $`git -C ${repoRoot} symbolic-ref --short HEAD`.text()
    ).trim();
    console.log(`[nas] Resolved HEAD to current branch: ${branch}`);
    return branch;
  } catch {
    throw new Error(
      'worktree.base is "HEAD" but the repository is in detached HEAD state.',
    );
  }
}
