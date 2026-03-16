/**
 * git worktree ステージ
 */

import $ from "dax";
import * as path from "@std/path";
import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import { logInfo } from "../log.ts";

export class WorktreeStage implements Stage {
  name = "WorktreeStage";

  /** execute で作成/再利用した worktree のパス（teardown 用） */
  private worktreePath: string | null = null;
  private repoRoot: string | null = null;
  private branchName: string | null = null;
  private baseBranch: string | null = null;

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    const wt = ctx.profile.worktree;
    if (!wt) {
      logInfo("[nas] Worktree: skipped (not configured)");
      return ctx;
    }

    const repoRoot = await getGitRoot(ctx.workDir);
    this.repoRoot = repoRoot;

    const resolvedBase = await resolveBase(repoRoot, wt.base);
    this.baseBranch = resolvedBase;

    await validateBaseBranch(repoRoot, resolvedBase);

    // 同じプロファイルの既存 worktree を検索
    const existing = await findProfileWorktrees(repoRoot, ctx.profileName);
    if (existing.length > 0) {
      const reused = await promptReuseWorktree(existing);
      if (reused) {
        this.worktreePath = reused.path;
        this.branchName = reused.branch
          ? reused.branch.replace("refs/heads/", "")
          : null;
        logInfo(`[nas] Reusing worktree: ${reused.path}`);
        return { ...ctx, workDir: reused.path, mountDir: repoRoot };
      }
    }

    const worktreeName = generateWorktreeName(ctx.profileName);
    const branchName = generateBranchName(ctx.profileName);
    // .git/nas-worktrees/ 内に作成 → 元リポのマウントだけで完結する
    const worktreePath = path.join(
      repoRoot,
      ".git",
      "nas-worktrees",
      worktreeName,
    );
    this.worktreePath = worktreePath;
    this.branchName = branchName;

    logInfo(
      `[nas] Creating worktree: ${worktreePath} (branch: ${branchName}) from ${resolvedBase}`,
    );
    await $`git -C ${repoRoot} worktree add -b ${branchName} ${worktreePath} ${resolvedBase}`
      .printCommand();

    await inheritDirtyBaseWorktree(repoRoot, resolvedBase, worktreePath);

    if (wt.onCreate) {
      logInfo(`[nas] Running on-create hook: ${wt.onCreate}`);
      await $`bash -c ${wt.onCreate}`.cwd(worktreePath).printCommand();
    }

    // worktree は元リポの .git/nas-worktrees/ 内に作成される。
    // mountDir に元リポを指定すれば 1 つのマウントで
    // working tree・git metadata・オブジェクト DB すべてが解決する。
    return { ...ctx, workDir: worktreePath, mountDir: repoRoot };
  }

  async teardown(_ctx: ExecutionContext): Promise<void> {
    if (!this.worktreePath || !this.repoRoot) return;

    // Show the current HEAD so the user can reference this commit later
    try {
      const head = (await $`git -C ${this.worktreePath} rev-parse HEAD`.text())
        .trim();
      console.log(`[nas] Worktree HEAD: ${head}`);
    } catch { /* ignore – worktree may already be gone */ }

    const worktreeAction = await promptWorktreeAction(this.worktreePath);

    if (worktreeAction === "keep") {
      console.log(`[nas] Worktree kept: ${this.worktreePath}`);
      return;
    }

    const dirtyWorktreeAction = await promptDirtyWorktreeAction(
      this.worktreePath,
    );
    if (dirtyWorktreeAction === "keep") {
      console.log(`[nas] Worktree kept: ${this.worktreePath}`);
      return;
    }
    if (dirtyWorktreeAction === "stash") {
      try {
        await stashDirtyWorktree(this.worktreePath);
      } catch (err) {
        console.error(
          `[nas] Failed to stash worktree changes: ${(err as Error).message}`,
        );
        console.log(`[nas] Worktree kept: ${this.worktreePath}`);
        return;
      }
    }

    // worktree を削除する場合、ブランチをどうするか聞く
    const branchAction = await promptBranchAction(this.branchName);

    let shouldDeleteBranch = branchAction !== "rename";

    if (branchAction === "rename") {
      await this.renameBranch();
    } else if (branchAction === "cherry-pick") {
      const success = await this.cherryPickToBase();
      if (!success) {
        // cherry-pick 失敗時はブランチを残す
        shouldDeleteBranch = false;
        console.log(
          `[nas] Branch "${this.branchName}" is preserved for manual resolution.`,
        );
      }
    }
    // branchAction === "delete" → worktree 削除時にブランチも削除

    // worktree を削除
    console.log(`[nas] Removing worktree: ${this.worktreePath}`);
    try {
      await $`git -C ${this.repoRoot} worktree remove --force ${this.worktreePath}`;
    } catch (err) {
      console.error(
        `[nas] Failed to remove worktree: ${(err as Error).message}`,
      );
    }

    // rename / cherry-pick 失敗時以外はブランチ削除
    if (shouldDeleteBranch && this.branchName) {
      try {
        await $`git -C ${this.repoRoot} branch -D ${this.branchName}`;
        console.log(`[nas] Deleted branch: ${this.branchName}`);
      } catch (err) {
        console.error(
          `[nas] Failed to delete branch: ${(err as Error).message}`,
        );
      }
    }
  }

  private async renameBranch(): Promise<void> {
    if (!this.branchName || !this.repoRoot) return;
    const newName = prompt(
      `[nas] New branch name (current: ${this.branchName}):`,
    )
      ?.trim();
    if (!newName) {
      console.log("[nas] No name entered, keeping original branch name.");
      return;
    }
    try {
      await $`git -C ${this.repoRoot} branch -m ${this.branchName} ${newName}`;
      console.log(`[nas] Renamed branch: ${this.branchName} → ${newName}`);
      this.branchName = newName;
    } catch (err) {
      console.error(
        `[nas] Failed to rename branch: ${(err as Error).message}`,
      );
    }
  }

  private async cherryPickToBase(): Promise<boolean> {
    if (!this.branchName || !this.repoRoot || !this.baseBranch) return false;

    // base ブランチ上にないコミット一覧を取得
    const commits = (
      await $`git -C ${this.repoRoot} log ${this.baseBranch}..${this.branchName} --format=%H --reverse`
        .text()
    ).trim();

    if (!commits) {
      console.log("[nas] No commits to cherry-pick.");
      return true;
    }

    const commitList = commits.split("\n");
    console.log(
      `[nas] Cherry-picking ${commitList.length} commit(s) onto ${this.baseBranch}...`,
    );

    // base が remote ref (origin/main) の場合、ローカルブランチ名を推定
    const targetBranch = resolveLocalBranch(this.baseBranch);

    try {
      // ローカルブランチが存在するか確認、なければ作成
      try {
        await $`git -C ${this.repoRoot} rev-parse --verify refs/heads/${targetBranch}`
          .quiet("both");
      } catch {
        console.log(
          `[nas] Creating local branch "${targetBranch}" from ${this.baseBranch}`,
        );
        await $`git -C ${this.repoRoot} branch ${targetBranch} ${this.baseBranch}`
          .printCommand();
      }

      // targetBranch が既にどこかの worktree でチェックアウトされているか確認
      const checkedOutIn = await findWorktreeForBranch(
        this.repoRoot,
        targetBranch,
      );

      if (checkedOutIn) {
        // そのworktreeで直接 cherry-pick（working tree も同期される）
        return await this.cherryPickInWorktree(
          checkedOutIn,
          commitList,
          targetBranch,
        );
      }

      // どこにもチェックアウトされていない → detached HEAD で一時 worktree を使う
      return await this.cherryPickDetached(commitList, targetBranch);
    } catch (err) {
      console.error(
        `[nas] Cherry-pick setup failed: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** targetBranch がチェックアウトされている worktree で直接 cherry-pick */
  private async cherryPickInWorktree(
    worktreePath: string,
    commitList: string[],
    targetBranch: string,
  ): Promise<boolean> {
    // dirty check — 未コミットの変更があると cherry-pick できない
    const dirty = await isWorktreeDirty(worktreePath);
    if (dirty) {
      console.error(
        `[nas] Cannot cherry-pick: worktree for "${targetBranch}" has uncommitted changes.`,
      );
      console.error(`[nas]   ${worktreePath}`);
      return false;
    }

    console.log(`[nas] Cherry-picking in worktree: ${worktreePath}`);
    try {
      await $`git -C ${worktreePath} cherry-pick ${commitList}`.printCommand();
      console.log("[nas] Cherry-pick completed successfully.");
      return true;
    } catch (cpErr) {
      console.error(
        `[nas] cherry-pick exited with error: ${(cpErr as Error).message}`,
      );
      const resolved = await this.resolveEmptyCherryPicks(
        worktreePath,
        commitList.length,
      );
      if (resolved) return true;

      console.error("[nas] Cherry-pick failed with conflicts.");
      try {
        await $`git -C ${worktreePath} cherry-pick --abort`.quiet("both");
      } catch { /* ignore */ }
      return false;
    }
  }

  /** targetBranch がどこにもチェックアウトされていない場合の cherry-pick */
  private async cherryPickDetached(
    commitList: string[],
    targetBranch: string,
  ): Promise<boolean> {
    const targetRef = (
      await $`git -C ${this.repoRoot} rev-parse refs/heads/${targetBranch}`
        .text()
    ).trim();
    const tmpWorktree = path.join(
      this.repoRoot!,
      ".git",
      "nas-worktrees",
      `nas-cherry-pick-tmp-${Date.now()}`,
    );
    await $`git -C ${this.repoRoot} worktree add --detach ${tmpWorktree} ${targetRef}`
      .printCommand();
    try {
      await $`git -C ${tmpWorktree} cherry-pick ${commitList}`.printCommand();

      const newHead = (
        await $`git -C ${tmpWorktree} rev-parse HEAD`.text()
      ).trim();
      await $`git -C ${this.repoRoot} branch -f ${targetBranch} ${newHead}`
        .printCommand();
      console.log("[nas] Cherry-pick completed successfully.");
      return true;
    } catch (cpErr) {
      console.error(
        `[nas] cherry-pick exited with error: ${(cpErr as Error).message}`,
      );
      const resolved = await this.resolveEmptyCherryPicks(
        tmpWorktree,
        commitList.length,
      );
      if (resolved) {
        const newHead = (
          await $`git -C ${tmpWorktree} rev-parse HEAD`.text()
        ).trim();
        await $`git -C ${this.repoRoot} branch -f ${targetBranch} ${newHead}`
          .printCommand();
        return true;
      }

      console.error("[nas] Cherry-pick failed with conflicts.");
      try {
        await $`git -C ${tmpWorktree} cherry-pick --abort`.quiet("both");
      } catch { /* ignore */ }
      return false;
    } finally {
      await $`git -C ${this.repoRoot} worktree remove --force ${tmpWorktree}`
        .quiet("both");
    }
  }

  /**
   * 空の cherry-pick（既に適用済み）を --skip でスキップしていく。
   * 全コミットが処理されれば true、コンフリクト等で解決不能なら false。
   */
  private async resolveEmptyCherryPicks(
    worktree: string,
    maxAttempts: number,
  ): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      // CHERRY_PICK_HEAD が存在するか（cherry-pick 進行中か）
      try {
        await $`git -C ${worktree} rev-parse CHERRY_PICK_HEAD`.quiet("both");
      } catch {
        // cherry-pick 進行中ではない → 完了済み
        console.log("[nas] Cherry-pick completed (empty commits skipped).");
        return true;
      }

      // working tree がクリーンなら空コミット → skip
      const status = await $`git -C ${worktree} status --porcelain`.quiet(
        "both",
      ).text();
      if (status.trim() === "") {
        console.log("[nas] Skipping empty cherry-pick (already applied).");
        try {
          await $`git -C ${worktree} cherry-pick --skip`;
        } catch {
          // --skip 後にまた空コミットが来る場合があるのでループを続行
          continue;
        }
      } else {
        // 変更がある = 実際のコンフリクト
        return false;
      }
    }

    // ループ終了後、まだ CHERRY_PICK_HEAD が残っているか確認
    try {
      await $`git -C ${worktree} rev-parse CHERRY_PICK_HEAD`.quiet("both");
      return false; // まだ進行中 → 失敗
    } catch {
      console.log("[nas] Cherry-pick completed (empty commits skipped).");
      return true;
    }
  }
}

// --- Interactive prompts ---

type WorktreeAction = "keep" | "delete";
type DirtyWorktreeAction = "stash" | "delete" | "keep";

async function promptWorktreeAction(
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

async function promptDirtyWorktreeAction(
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

async function stashDirtyWorktree(worktreePath: string): Promise<void> {
  const stashMessage = `nas teardown ${path.basename(worktreePath)} ${
    new Date().toISOString()
  }`;
  await $`git -C ${worktreePath} stash push --include-untracked -m ${stashMessage}`
    .printCommand();
  console.log(`[nas] Stashed worktree changes: ${stashMessage}`);
}

type BranchAction = "rename" | "cherry-pick" | "delete";

async function promptBranchAction(
  branchName: string | null,
): Promise<BranchAction> {
  if (!branchName) return "delete";

  // ブランチ上のコミット数を表示（参考情報）
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

function promptReuseWorktree(
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

// --- Helper functions ---

/**
 * 指定ブランチがチェックアウトされている worktree のパスを返す。
 * どこにもチェックアウトされていなければ null。
 */
async function findWorktreeForBranch(
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
function resolveLocalBranch(ref: string): string {
  const match = ref.match(/^[^/]+\/(.+)$/);
  return match ? match[1] : ref;
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

/**
 * "HEAD" を現在のブランチ名に解決する。それ以外はそのまま返す。
 */
export async function resolveBase(
  repoRoot: string,
  base: string,
): Promise<string> {
  if (base !== "HEAD") return base;
  try {
    const branch =
      (await $`git -C ${repoRoot} symbolic-ref --short HEAD`.text()).trim();
    console.log(`[nas] Resolved HEAD to current branch: ${branch}`);
    return branch;
  } catch {
    throw new Error(
      'worktree.base is "HEAD" but the repository is in detached HEAD state.',
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

async function inheritDirtyBaseWorktree(
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

  if (!await isWorktreeDirty(sourceWorktreePath)) return;

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
    await $`git -C ${sourceWorktreePath} diff --binary --cached`
      .text();
  if (stagedPatch.trim().length > 0) {
    await applyPatchFile(targetWorktreePath, stagedPatch, ["--index"]);
  }

  const unstagedPatch = await $`git -C ${sourceWorktreePath} diff --binary`
    .text();
  if (unstagedPatch.trim().length > 0) {
    await applyPatchFile(targetWorktreePath, unstagedPatch);
  }
}

async function applyPatchFile(
  targetWorktreePath: string,
  patch: string,
  extraArgs: string[] = [],
): Promise<void> {
  const patchFile = await Deno.makeTempFile({
    prefix: "nas-worktree-",
    suffix: ".patch",
  });
  try {
    const normalizedPatch = patch.endsWith("\n") ? patch : `${patch}\n`;
    await Deno.writeTextFile(patchFile, normalizedPatch);
    await $`git -C ${targetWorktreePath} apply --binary --allow-empty ${extraArgs} ${patchFile}`
      .printCommand();
  } finally {
    await Deno.remove(patchFile).catch(() => undefined);
  }
}

async function copyUntrackedFiles(
  sourceWorktreePath: string,
  targetWorktreePath: string,
): Promise<void> {
  const output =
    await $`git -C ${sourceWorktreePath} ls-files --others --exclude-standard -z`
      .text();
  if (output.length === 0) return;

  const untrackedFiles = output
    .split("\0")
    .filter((file) => file.length > 0);

  for (const relativePath of untrackedFiles) {
    const sourcePath = path.join(sourceWorktreePath, relativePath);
    const targetPath = path.join(targetWorktreePath, relativePath);
    await Deno.mkdir(path.dirname(targetPath), { recursive: true });
    await Deno.copyFile(sourcePath, targetPath);
  }
}

function generateWorktreeName(profileName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `nas-${profileName}-${ts}`;
}

function generateBranchName(profileName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `nas/${profileName}/${ts}`;
}

/** プロファイル名にマッチする既存 worktree を検索 */
async function findProfileWorktrees(
  repoRoot: string,
  profileName: string,
): Promise<WorktreeEntry[]> {
  const all = await listNasWorktrees(repoRoot);
  const prefix = `nas-${profileName}-`;
  return all.filter((e) => path.basename(e.path).startsWith(prefix));
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

export interface CleanResult {
  worktrees: number;
  orphanBranches: number;
}

/** worktree に紐づかない nas/* ブランチを一覧取得 */
export async function listOrphanNasBranches(
  workDir: string,
): Promise<string[]> {
  const repoRoot = await getGitRoot(workDir);

  // stale な worktree 参照を先に片付ける
  await $`git -C ${repoRoot} worktree prune`.quiet("both");

  const branchOutput = await $`git -C ${repoRoot} branch --list nas/*`
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
