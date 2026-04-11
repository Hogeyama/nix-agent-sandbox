/**
 * git worktree 関連のヘルパー関数
 */

import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
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

export async function validateBaseBranch(
  repoRoot: string,
  base: string,
): Promise<void> {
  try {
    await $`git -C ${repoRoot} rev-parse --verify ${base}`.quiet();
  } catch {
    throw new Error(
      `Base ref "${base}" not found. Run "git fetch" to update remote refs.`,
    );
  }
}

export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const status = await $`git -C ${worktreePath} status --porcelain`.text();
  return status.trim().length > 0;
}

/**
 * 指定ブランチがチェックアウトされている worktree のパスを返す。
 * どこにもチェックアウトされていなければ null。
 */
export async function findWorktreeForBranch(
  repoRoot: string,
  branchName: string,
): Promise<string | null> {
  const output = await $`git -C ${repoRoot} worktree list --porcelain`.text();
  let currentPath: string | null = null;
  const targetRef = `refs/heads/${branchName}`;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ") && currentPath) {
      if (line.slice("branch ".length) === targetRef) {
        return currentPath;
      }
    } else if (line === "") {
      currentPath = null;
    }
  }
  return null;
}

/**
 * remote ref (e.g. "origin/main") からローカルブランチ名を推定する。
 * ローカル ref ならそのまま返す。
 */
export function resolveLocalBranch(ref: string): string {
  const match = ref.match(/^[^/]+\/(.+)$/);
  return match ? match[1] : ref;
}

export async function inheritDirtyBaseWorktree(
  repoRoot: string,
  baseRef: string,
  targetWorktreePath: string,
): Promise<void> {
  const localBaseBranch = resolveLocalBranch(baseRef);
  const sourceWorktreePath = await findWorktreeForBranch(
    repoRoot,
    localBaseBranch,
  );
  if (!sourceWorktreePath || sourceWorktreePath === targetWorktreePath) return;

  if (!(await isWorktreeDirty(sourceWorktreePath))) return;

  console.log(
    `[nas] Inheriting dirty changes from ${sourceWorktreePath} (${localBaseBranch})`,
  );

  await applyTrackedDiff(sourceWorktreePath, targetWorktreePath);
  await copyUntrackedFiles(sourceWorktreePath, targetWorktreePath);
}

async function applyTrackedDiff(
  sourceWorktreePath: string,
  targetWorktreePath: string,
): Promise<void> {
  const stagedPatch =
    await $`git -C ${sourceWorktreePath} diff --no-ext-diff --binary --cached`.text();
  if (stagedPatch.trim().length > 0) {
    await applyPatchFile(targetWorktreePath, stagedPatch, ["--index"]);
  }

  const unstagedPatch =
    await $`git -C ${sourceWorktreePath} diff --no-ext-diff --binary`.text();
  if (unstagedPatch.trim().length > 0) {
    await applyPatchFile(targetWorktreePath, unstagedPatch);
  }
}

async function applyPatchFile(
  targetWorktreePath: string,
  patch: string,
  extraArgs: string[] = [],
): Promise<void> {
  const tmpDirPath = await mkdtemp(path.join(tmpdir(), "nas-worktree-"));
  const patchFile = path.join(tmpDirPath, "patch.patch");
  try {
    const normalizedPatch = patch.endsWith("\n") ? patch : `${patch}\n`;
    await writeFile(patchFile, normalizedPatch);
    console.log(
      `$ git -C ${targetWorktreePath} apply --binary --allow-empty ${extraArgs.join(
        " ",
      )} ${patchFile}`,
    );
    await $`git -C ${targetWorktreePath} apply --binary --allow-empty ${extraArgs} ${patchFile}`;
  } finally {
    await rm(tmpDirPath, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function copyUntrackedFiles(
  sourceWorktreePath: string,
  targetWorktreePath: string,
): Promise<void> {
  const output =
    await $`git -C ${sourceWorktreePath} ls-files --others --exclude-standard -z`.text();
  if (output.length === 0) return;

  const untrackedFiles = output.split("\0").filter((file) => file.length > 0);

  for (const relativePath of untrackedFiles) {
    const sourcePath = path.join(sourceWorktreePath, relativePath);
    const targetPath = path.join(targetWorktreePath, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }
}

export function generateWorktreeName(profileName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `nas-${profileName}-${ts}`;
}

export function generateBranchName(profileName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `nas/${profileName}/${ts}`;
}
