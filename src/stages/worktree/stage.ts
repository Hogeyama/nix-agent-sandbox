/**
 * WorktreeStage — git worktree のライフサイクル管理
 */

import { stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { logInfo } from "../../log.ts";
import type {
  ProceduralResult,
  ProceduralStage,
  StageInput,
} from "../../pipeline/types.ts";
import {
  findWorktreeForBranch,
  generateBranchName,
  generateWorktreeName,
  getGitRoot,
  inheritDirtyBaseWorktree,
  isWorktreeDirty,
  resolveBase,
  resolveLocalBranch,
  validateBaseBranch,
} from "./git_helpers.ts";
import { findProfileWorktrees } from "./management.ts";
import {
  promptBranchAction,
  promptDirtyWorktreeAction,
  promptReuseWorktree,
  promptWorktreeAction,
  stashDirtyWorktree,
} from "./prompts.ts";

export class WorktreeStage implements ProceduralStage {
  kind = "procedural" as const;
  name = "WorktreeStage";

  /** execute で作成/再利用した worktree のパス（teardown 用） */
  private worktreePath: string | null = null;
  private repoRoot: string | null = null;
  private branchName: string | null = null;
  private baseBranch: string | null = null;

  async execute(input: StageInput): Promise<ProceduralResult> {
    const wt = input.profile.worktree;
    if (!wt) {
      logInfo("[nas] Worktree: skipped (not configured)");
      return { outputOverrides: {} };
    }

    const workDir = input.prior.workDir;
    const repoRoot = await getGitRoot(workDir);
    this.repoRoot = repoRoot;

    const resolvedBase = await resolveBase(repoRoot, wt.base);
    this.baseBranch = resolvedBase;

    await validateBaseBranch(repoRoot, resolvedBase);

    // 同じプロファイルの既存 worktree を検索
    const existing = await findProfileWorktrees(repoRoot, input.profileName);
    if (existing.length > 0) {
      const reused = await promptReuseWorktree(existing);
      if (reused) {
        this.worktreePath = reused.path;
        this.branchName = reused.branch
          ? reused.branch.replace("refs/heads/", "")
          : null;
        logInfo(`[nas] Reusing worktree: ${reused.path}`);
        return {
          outputOverrides: { workDir: reused.path, mountDir: repoRoot },
        };
      }
    }

    const worktreeName = generateWorktreeName(input.profileName);
    const branchName = generateBranchName(input.profileName);
    // .nas/worktrees/ 内に作成 → 元リポのマウントだけで完結する
    const worktreePath = path.join(repoRoot, ".nas", "worktrees", worktreeName);

    await ensureNasGitignore(repoRoot);
    this.worktreePath = worktreePath;
    this.branchName = branchName;

    logInfo(
      `[nas] Creating worktree: ${worktreePath} (branch: ${branchName}) from ${resolvedBase}`,
    );
    console.log(
      `$ git -C ${repoRoot} worktree add -b ${branchName} ${worktreePath} ${resolvedBase}`,
    );
    await $`git -C ${repoRoot} worktree add -b ${branchName} ${worktreePath} ${resolvedBase}`;

    // nas worktree list で base を表示できるよう、branch に base ref を記録しておく
    await $`git -C ${repoRoot} config ${`branch.${branchName}.nasBase`} ${resolvedBase}`.quiet();

    await inheritDirtyBaseWorktree(repoRoot, resolvedBase, worktreePath);

    if (wt.onCreate) {
      logInfo(`[nas] Running on-create hook: ${wt.onCreate}`);
      console.log(`$ bash -c ${wt.onCreate} (cwd: ${worktreePath})`);
      await $`bash -c ${wt.onCreate}`.cwd(worktreePath);
    }

    // worktree は元リポの .nas/worktrees/ 内に作成される。
    // mountDir に元リポを指定すれば 1 つのマウントで
    // working tree・git metadata・オブジェクト DB すべてが解決する。
    return {
      outputOverrides: { workDir: worktreePath, mountDir: repoRoot },
    };
  }

  async teardown(_input: StageInput): Promise<void> {
    if (!this.worktreePath || !this.repoRoot) return;

    // Show the current HEAD so the user can reference this commit later
    try {
      const head = (
        await $`git -C ${this.worktreePath} rev-parse HEAD`.text()
      ).trim();
      console.log(`[nas] Worktree HEAD: ${head}`);
    } catch {
      /* ignore – worktree may already be gone */
    }

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
    const branchAction = await promptBranchAction(
      this.branchName,
      this.baseBranch,
      this.repoRoot,
    );

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
    )?.trim();
    if (!newName) {
      console.log("[nas] No name entered, keeping original branch name.");
      return;
    }
    try {
      await $`git -C ${this.repoRoot} branch -m ${this.branchName} ${newName}`;
      console.log(`[nas] Renamed branch: ${this.branchName} → ${newName}`);
      this.branchName = newName;
    } catch (err) {
      console.error(`[nas] Failed to rename branch: ${(err as Error).message}`);
    }
  }

  private async cherryPickToBase(): Promise<boolean> {
    if (!this.branchName || !this.repoRoot || !this.baseBranch) return false;

    // base ブランチ上にないコミット一覧を取得
    const commits = (
      await $`git -C ${this.repoRoot} log ${this.baseBranch}..${this.branchName} --format=%H --reverse`.text()
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
        await $`git -C ${this.repoRoot} rev-parse --verify refs/heads/${targetBranch}`.quiet();
      } catch {
        console.log(
          `[nas] Creating local branch "${targetBranch}" from ${this.baseBranch}`,
        );
        console.log(
          `$ git -C ${this.repoRoot} branch ${targetBranch} ${this.baseBranch}`,
        );
        await $`git -C ${this.repoRoot} branch ${targetBranch} ${this.baseBranch}`;
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
    const dirty = await isWorktreeDirty(worktreePath);
    let stashed = false;
    const stashMessage = `nas cherry-pick ${targetBranch} ${new Date().toISOString()}`;

    if (dirty) {
      console.log(
        `[nas] Worktree for "${targetBranch}" has uncommitted changes; stashing temporarily before cherry-pick.`,
      );
      try {
        console.log(
          `$ git -C ${worktreePath} stash push --include-untracked -m ${stashMessage}`,
        );
        await $`git -C ${worktreePath} stash push --include-untracked -m ${stashMessage}`;
        stashed = true;
      } catch (err) {
        console.error(
          `[nas] Failed to stash changes in "${targetBranch}" worktree: ${
            (err as Error).message
          }`,
        );
        console.error(`[nas]   ${worktreePath}`);
        return false;
      }
    }

    console.log(`[nas] Cherry-picking in worktree: ${worktreePath}`);
    let success = false;
    try {
      console.log(
        `$ git -C ${worktreePath} cherry-pick ${commitList.join(" ")}`,
      );
      await $`git -C ${worktreePath} cherry-pick ${commitList}`;
      success = true;
    } catch (cpErr) {
      console.error(
        `[nas] cherry-pick exited with error: ${(cpErr as Error).message}`,
      );
      const resolved = await this.resolveEmptyCherryPicks(
        worktreePath,
        commitList.length,
      );
      if (resolved) {
        success = true;
      } else {
        console.error("[nas] Cherry-pick failed with conflicts.");
        try {
          await $`git -C ${worktreePath} cherry-pick --abort`.quiet();
        } catch {
          /* ignore */
        }
      }
    }

    if (!success) {
      if (stashed) {
        try {
          console.log(`$ git -C ${worktreePath} stash pop`);
          await $`git -C ${worktreePath} stash pop`;
        } catch (err) {
          console.error(
            `[nas] Failed to restore stashed changes in "${targetBranch}" worktree: ${
              (err as Error).message
            }`,
          );
        }
      }
      return false;
    }

    if (stashed) {
      try {
        console.log(`$ git -C ${worktreePath} stash pop`);
        await $`git -C ${worktreePath} stash pop`;
      } catch (err) {
        console.error(
          `[nas] Cherry-pick succeeded, but restoring stashed changes failed: ${
            (err as Error).message
          }`,
        );
        return false;
      }
    }

    console.log("[nas] Cherry-pick completed successfully.");
    return true;
  }

  /** targetBranch がどこにもチェックアウトされていない場合の cherry-pick */
  private async cherryPickDetached(
    commitList: string[],
    targetBranch: string,
  ): Promise<boolean> {
    const targetRef = (
      await $`git -C ${this.repoRoot} rev-parse refs/heads/${targetBranch}`.text()
    ).trim();
    const tmpWorktree = path.join(
      this.repoRoot!,
      ".nas",
      "worktrees",
      `nas-cherry-pick-tmp-${Date.now()}`,
    );
    console.log(
      `$ git -C ${this.repoRoot} worktree add --detach ${tmpWorktree} ${targetRef}`,
    );
    await $`git -C ${this.repoRoot} worktree add --detach ${tmpWorktree} ${targetRef}`;
    try {
      console.log(
        `$ git -C ${tmpWorktree} cherry-pick ${commitList.join(" ")}`,
      );
      await $`git -C ${tmpWorktree} cherry-pick ${commitList}`;

      const newHead = (
        await $`git -C ${tmpWorktree} rev-parse HEAD`.text()
      ).trim();
      console.log(
        `$ git -C ${this.repoRoot} branch -f ${targetBranch} ${newHead}`,
      );
      await $`git -C ${this.repoRoot} branch -f ${targetBranch} ${newHead}`;
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
        console.log(
          `$ git -C ${this.repoRoot} branch -f ${targetBranch} ${newHead}`,
        );
        await $`git -C ${this.repoRoot} branch -f ${targetBranch} ${newHead}`;
        return true;
      }

      console.error("[nas] Cherry-pick failed with conflicts.");
      try {
        await $`git -C ${tmpWorktree} cherry-pick --abort`.quiet();
      } catch {
        /* ignore */
      }
      return false;
    } finally {
      await $`git -C ${this.repoRoot} worktree remove --force ${tmpWorktree}`.quiet();
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
        await $`git -C ${worktree} rev-parse CHERRY_PICK_HEAD`.quiet();
      } catch {
        // cherry-pick 進行中ではない → 完了済み
        console.log("[nas] Cherry-pick completed (empty commits skipped).");
        return true;
      }

      // working tree がクリーンなら空コミット → skip
      const status = await $`git -C ${worktree} status --porcelain`
        .quiet()
        .text();
      if (status.trim() === "") {
        console.log("[nas] Skipping empty cherry-pick (already applied).");
        try {
          await $`git -C ${worktree} cherry-pick --skip`;
        } catch {}
      } else {
        // 変更がある = 実際のコンフリクト
        return false;
      }
    }

    // ループ終了後、まだ CHERRY_PICK_HEAD が残っているか確認
    try {
      await $`git -C ${worktree} rev-parse CHERRY_PICK_HEAD`.quiet();
      return false; // まだ進行中 → 失敗
    } catch {
      console.log("[nas] Cherry-pick completed (empty commits skipped).");
      return true;
    }
  }
}

/** .nas/.gitignore が存在しなければ作成する */
async function ensureNasGitignore(repoRoot: string): Promise<void> {
  const gitignorePath = path.join(repoRoot, ".nas", ".gitignore");
  try {
    await stat(gitignorePath);
  } catch {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(repoRoot, ".nas"), { recursive: true });
    await writeFile(gitignorePath, "*\n");
  }
}
