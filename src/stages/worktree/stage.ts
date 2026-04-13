/**
 * WorktreeStage — git worktree のライフサイクル管理 (EffectStage)
 */

import * as path from "node:path";
import { Effect, Exit, type Scope } from "effect";
import { logInfo } from "../../log.ts";
import type {
  EffectStage,
  EffectStageResult,
  StageInput,
} from "../../pipeline/types.ts";
import { FsService } from "../../services/fs.ts";
import { ProcessService } from "../../services/process.ts";
import {
  findWorktreeForBranch,
  generateBranchName,
  generateWorktreeName,
  getGitRoot,
  inheritDirtyBaseWorktree,
  isWorktreeDirty,
  resolveBase,
  validateBaseBranch,
} from "./git_helpers.ts";
import { findProfileWorktrees } from "./management.ts";
import { PromptService } from "./prompt_service.ts";
import { stashDirtyWorktree } from "./prompts.ts";

type Proc = Effect.Effect.Success<typeof ProcessService>;
type Prompts = Effect.Effect.Success<typeof PromptService>;
type Fs = Effect.Effect.Success<typeof FsService>;

/**
 * remote ref (e.g. "origin/main") からローカルブランチ名を推定する。
 * git で refs/remotes/ 下に存在するか確認し、リモート ref なら最初のセグメントを除去。
 * ローカルブランチ (e.g. "feature/foo") はそのまま返す。
 */
function resolveLocalBranchEffect(
  proc: Proc,
  repoRoot: string,
  ref: string,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    const result = yield* gitExec(proc, [
      "git",
      "-C",
      repoRoot,
      "rev-parse",
      "--verify",
      `refs/remotes/${ref}`,
    ]);
    if (result !== null) {
      const match = ref.match(/^[^/]+\/(.+)$/);
      return match ? match[1] : ref;
    }
    return ref;
  });
}

/** Run a git command via ProcessService, catching defects and returning null on failure. */
function gitExec(
  proc: Proc,
  cmd: string[],
  opts?: { cwd?: string },
): Effect.Effect<string | null> {
  return proc.exec(cmd, opts).pipe(
    Effect.exit,
    Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : null)),
  );
}

/** Extract a human-readable message from an Exit.Failure. */
function exitMessage(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) return "";
  const cause = exit.cause;
  if (cause._tag === "Die") {
    const d = cause.defect;
    return d instanceof Error ? d.message : String(d);
  }
  if (cause._tag === "Fail") {
    const e = cause.error;
    return e instanceof Error ? e.message : String(e);
  }
  return "unknown error";
}

export function createWorktreeStage(): EffectStage<
  PromptService | FsService | ProcessService
> {
  return {
    kind: "effect",
    name: "WorktreeStage",

    run(
      input: StageInput,
    ): Effect.Effect<
      EffectStageResult,
      unknown,
      Scope.Scope | PromptService | FsService | ProcessService
    > {
      return Effect.gen(function* () {
        const wt = input.profile.worktree;
        if (!wt) {
          logInfo("[nas] Worktree: skipped (not configured)");
          return {};
        }

        const proc = yield* ProcessService;
        const fsService = yield* FsService;
        const prompts = yield* PromptService;

        const workDir = input.prior.workDir;
        const repoRoot = yield* Effect.tryPromise({
          try: () => getGitRoot(workDir),
          catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
        });

        const resolvedBase = yield* Effect.tryPromise({
          try: () => resolveBase(repoRoot, wt.base),
          catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
        });

        yield* Effect.tryPromise({
          try: () => validateBaseBranch(repoRoot, resolvedBase),
          catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
        });

        // 同じプロファイルの既存 worktree を検索
        const existing = yield* Effect.tryPromise({
          try: () => findProfileWorktrees(repoRoot, input.profileName),
          catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
        });
        if (existing.length > 0) {
          const reused = yield* prompts.reuseWorktree(existing);
          if (reused) {
            logInfo(`[nas] Reusing worktree: ${reused.path}`);
            return { workDir: reused.path, mountDir: repoRoot };
          }
        }

        const worktreeName = generateWorktreeName(input.profileName);
        const branchName = generateBranchName(input.profileName);
        // .nas/worktrees/ 内に作成 → 元リポのマウントだけで完結する
        const worktreePath = path.join(
          repoRoot,
          ".nas",
          "worktrees",
          worktreeName,
        );

        yield* ensureNasGitignoreEffect(repoRoot, fsService);

        logInfo(
          `[nas] Creating worktree: ${worktreePath} (branch: ${branchName}) from ${resolvedBase}`,
        );
        console.log(
          `$ git -C ${repoRoot} worktree add -b ${branchName} ${worktreePath} ${resolvedBase}`,
        );
        yield* proc.exec([
          "git",
          "-C",
          repoRoot,
          "worktree",
          "add",
          "-b",
          branchName,
          worktreePath,
          resolvedBase,
        ]);

        // nas worktree list で base を表示できるよう、branch に base ref を記録しておく
        yield* proc.exec([
          "git",
          "-C",
          repoRoot,
          "config",
          `branch.${branchName}.nasBase`,
          resolvedBase,
        ]);

        const localBaseBranch = yield* resolveLocalBranchEffect(
          proc,
          repoRoot,
          resolvedBase,
        );
        yield* Effect.tryPromise({
          try: () =>
            inheritDirtyBaseWorktree(repoRoot, localBaseBranch, worktreePath),
          catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
        });

        if (wt.onCreate) {
          logInfo(`[nas] Running on-create hook: ${wt.onCreate}`);
          console.log(`$ bash -c ${wt.onCreate} (cwd: ${worktreePath})`);
          yield* proc.exec(["bash", "-c", wt.onCreate], {
            cwd: worktreePath,
          });
        }

        // Register teardown finalizer
        yield* Effect.addFinalizer(() =>
          teardownWorktree(
            prompts,
            proc,
            worktreePath,
            repoRoot,
            branchName,
            resolvedBase,
          ),
        );

        // worktree は元リポの .nas/worktrees/ 内に作成される。
        // mountDir に元リポを指定すれば 1 つのマウントで
        // working tree・git metadata・オブジェクト DB すべてが解決する。
        return { workDir: worktreePath, mountDir: repoRoot };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

function teardownWorktree(
  prompts: Prompts,
  proc: Proc,
  worktreePath: string,
  repoRoot: string,
  branchName: string,
  baseBranch: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    // Show the current HEAD so the user can reference this commit later
    const head = yield* gitExec(proc, [
      "git",
      "-C",
      worktreePath,
      "rev-parse",
      "HEAD",
    ]);
    if (head !== null) {
      console.log(`[nas] Worktree HEAD: ${head.trim()}`);
    }

    const worktreeAction = yield* prompts.worktreeAction(worktreePath);

    if (worktreeAction === "keep") {
      console.log(`[nas] Worktree kept: ${worktreePath}`);
      return;
    }

    const dirtyWorktreeAction =
      yield* prompts.dirtyWorktreeAction(worktreePath);
    if (dirtyWorktreeAction === "keep") {
      console.log(`[nas] Worktree kept: ${worktreePath}`);
      return;
    }
    if (dirtyWorktreeAction === "stash") {
      const stashResult = yield* Effect.tryPromise({
        try: () => stashDirtyWorktree(worktreePath),
        catch: (err) =>
          new Error(
            `Failed to stash worktree changes: ${err instanceof Error ? err.message : String(err)}`,
          ),
      }).pipe(Effect.either);
      if (stashResult._tag === "Left") {
        console.error(`[nas] ${stashResult.left.message}`);
        console.log(`[nas] Worktree kept: ${worktreePath}`);
        return;
      }
    }

    // worktree を削除する場合、ブランチをどうするか聞く
    const branchAction = yield* prompts.branchAction(
      branchName,
      baseBranch,
      repoRoot,
    );

    let shouldDeleteBranch = branchAction !== "rename";

    if (branchAction === "rename") {
      yield* renameBranchEffect(prompts, proc, branchName, repoRoot);
    } else if (branchAction === "cherry-pick") {
      const success = yield* cherryPickToBase(
        proc,
        branchName,
        repoRoot,
        baseBranch,
      );
      if (!success) {
        shouldDeleteBranch = false;
        console.log(
          `[nas] Branch "${branchName}" is preserved for manual resolution.`,
        );
      }
    }

    // worktree を削除
    console.log(`[nas] Removing worktree: ${worktreePath}`);
    const removeResult = yield* gitExec(proc, [
      "git",
      "-C",
      repoRoot,
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    if (removeResult === null) {
      console.error("[nas] Failed to remove worktree");
    }

    // rename / cherry-pick 失敗時以外はブランチ削除
    if (shouldDeleteBranch && branchName) {
      const delResult = yield* gitExec(proc, [
        "git",
        "-C",
        repoRoot,
        "branch",
        "-D",
        branchName,
      ]);
      if (delResult !== null) {
        console.log(`[nas] Deleted branch: ${branchName}`);
      } else {
        console.error(`[nas] Failed to delete branch: ${branchName}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Rename branch
// ---------------------------------------------------------------------------

function renameBranchEffect(
  prompts: Prompts,
  proc: Proc,
  branchName: string,
  repoRoot: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const newName = yield* prompts.renameBranchPrompt(branchName);
    if (!newName) {
      console.log("[nas] No name entered, keeping original branch name.");
      return;
    }
    const result = yield* gitExec(proc, [
      "git",
      "-C",
      repoRoot,
      "branch",
      "-m",
      branchName,
      newName,
    ]);
    if (result !== null) {
      console.log(`[nas] Renamed branch: ${branchName} \u2192 ${newName}`);
    } else {
      console.error(`[nas] Failed to rename branch: ${branchName}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Cherry-pick to base
// ---------------------------------------------------------------------------

function cherryPickToBase(
  proc: Proc,
  branchName: string,
  repoRoot: string,
  baseBranch: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    // base ブランチ上にないコミット一覧を取得
    const commitsRaw = (yield* proc.exec([
      "git",
      "-C",
      repoRoot,
      "log",
      `${baseBranch}..${branchName}`,
      "--format=%H",
      "--reverse",
    ])).trim();

    if (!commitsRaw) {
      console.log("[nas] No commits to cherry-pick.");
      return true;
    }

    const commitList = commitsRaw.split("\n");
    console.log(
      `[nas] Cherry-picking ${commitList.length} commit(s) onto ${baseBranch}...`,
    );

    // base が remote ref (origin/main) の場合、ローカルブランチ名を推定
    const targetBranch = yield* resolveLocalBranchEffect(
      proc,
      repoRoot,
      baseBranch,
    );

    const setupExit = yield* Effect.gen(function* () {
      // ローカルブランチが存在するか確認、なければ作成
      const verifyResult = yield* gitExec(proc, [
        "git",
        "-C",
        repoRoot,
        "rev-parse",
        "--verify",
        `refs/heads/${targetBranch}`,
      ]);
      if (verifyResult === null) {
        console.log(
          `[nas] Creating local branch "${targetBranch}" from ${baseBranch}`,
        );
        console.log(
          `$ git -C ${repoRoot} branch ${targetBranch} ${baseBranch}`,
        );
        yield* proc.exec([
          "git",
          "-C",
          repoRoot,
          "branch",
          targetBranch,
          baseBranch,
        ]);
      }

      // targetBranch が既にどこかの worktree でチェックアウトされているか確認
      const checkedOutIn = yield* Effect.tryPromise({
        try: () => findWorktreeForBranch(repoRoot, targetBranch),
        catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
      });

      if (checkedOutIn) {
        return yield* cherryPickInWorktreeEffect(
          proc,
          checkedOutIn,
          commitList,
          targetBranch,
        );
      }

      return yield* cherryPickDetachedEffect(
        proc,
        commitList,
        targetBranch,
        repoRoot,
      );
    }).pipe(Effect.exit);

    if (Exit.isFailure(setupExit)) {
      console.error(
        `[nas] Cherry-pick setup failed: ${exitMessage(setupExit)}`,
      );
      return false;
    }
    return setupExit.value;
  });
}

// ---------------------------------------------------------------------------
// Cherry-pick in worktree
// ---------------------------------------------------------------------------

function cherryPickInWorktreeEffect(
  proc: Proc,
  worktreePath: string,
  commitList: string[],
  targetBranch: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const dirty = yield* Effect.tryPromise({
      try: () => isWorktreeDirty(worktreePath),
      catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
    }).pipe(Effect.orDie);
    let stashed = false;
    const stashMessage = `nas cherry-pick ${targetBranch} ${new Date().toISOString()}`;

    if (dirty) {
      console.log(
        `[nas] Worktree for "${targetBranch}" has uncommitted changes; stashing temporarily before cherry-pick.`,
      );
      const stashOk = yield* gitExec(proc, [
        "git",
        "-C",
        worktreePath,
        "stash",
        "push",
        "--include-untracked",
        "-m",
        stashMessage,
      ]);
      if (stashOk === null) {
        console.error(
          `[nas] Failed to stash changes in "${targetBranch}" worktree`,
        );
        console.error(`[nas]   ${worktreePath}`);
        return false;
      }
      stashed = true;
    }

    console.log(`[nas] Cherry-picking in worktree: ${worktreePath}`);
    const cpOk = yield* gitExec(proc, [
      "git",
      "-C",
      worktreePath,
      "cherry-pick",
      ...commitList,
    ]);
    let success = cpOk !== null;

    if (!success) {
      console.error("[nas] cherry-pick exited with error");
      const resolved = yield* resolveEmptyCherryPicksEffect(
        proc,
        worktreePath,
        commitList.length,
      );
      if (resolved) {
        success = true;
      } else {
        console.error("[nas] Cherry-pick failed with conflicts.");
        yield* gitExec(proc, [
          "git",
          "-C",
          worktreePath,
          "cherry-pick",
          "--abort",
        ]);
      }
    }

    if (!success && stashed) {
      const popOk = yield* gitExec(proc, [
        "git",
        "-C",
        worktreePath,
        "stash",
        "pop",
      ]);
      if (popOk === null) {
        console.error(
          `[nas] Failed to restore stashed changes in "${targetBranch}" worktree`,
        );
      }
      return false;
    }
    if (!success) {
      return false;
    }

    if (stashed) {
      const popOk = yield* gitExec(proc, [
        "git",
        "-C",
        worktreePath,
        "stash",
        "pop",
      ]);
      if (popOk === null) {
        console.error(
          `[nas] Cherry-pick succeeded, but restoring stashed changes failed`,
        );
        return false;
      }
    }

    console.log("[nas] Cherry-pick completed successfully.");
    return true;
  });
}

// ---------------------------------------------------------------------------
// Cherry-pick detached
// ---------------------------------------------------------------------------

function cherryPickDetachedEffect(
  proc: Proc,
  commitList: string[],
  targetBranch: string,
  repoRoot: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const targetRef = (yield* proc.exec([
      "git",
      "-C",
      repoRoot,
      "rev-parse",
      `refs/heads/${targetBranch}`,
    ])).trim();
    const tmpWorktree = path.join(
      repoRoot,
      ".nas",
      "worktrees",
      `nas-cherry-pick-tmp-${Date.now()}`,
    );
    console.log(
      `$ git -C ${repoRoot} worktree add --detach ${tmpWorktree} ${targetRef}`,
    );
    yield* proc.exec([
      "git",
      "-C",
      repoRoot,
      "worktree",
      "add",
      "--detach",
      tmpWorktree,
      targetRef,
    ]);

    // Use Effect.acquireUseRelease to ensure tmp worktree cleanup
    const result = yield* Effect.acquireUseRelease(
      Effect.succeed(tmpWorktree),
      (tw) =>
        cherryPickInTmpWorktree(proc, tw, commitList, targetBranch, repoRoot),
      (tw) =>
        gitExec(proc, [
          "git",
          "-C",
          repoRoot,
          "worktree",
          "remove",
          "--force",
          tw,
        ]).pipe(Effect.ignore),
    );

    return result;
  });
}

function cherryPickInTmpWorktree(
  proc: Proc,
  tmpWorktree: string,
  commitList: string[],
  targetBranch: string,
  repoRoot: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    console.log(`$ git -C ${tmpWorktree} cherry-pick ${commitList.join(" ")}`);
    const cpOk = yield* gitExec(proc, [
      "git",
      "-C",
      tmpWorktree,
      "cherry-pick",
      ...commitList,
    ]);

    if (cpOk !== null) {
      const newHead = (yield* proc.exec([
        "git",
        "-C",
        tmpWorktree,
        "rev-parse",
        "HEAD",
      ])).trim();
      console.log(`$ git -C ${repoRoot} branch -f ${targetBranch} ${newHead}`);
      yield* proc.exec([
        "git",
        "-C",
        repoRoot,
        "branch",
        "-f",
        targetBranch,
        newHead,
      ]);
      console.log("[nas] Cherry-pick completed successfully.");
      return true;
    }

    console.error("[nas] cherry-pick exited with error");
    const resolved = yield* resolveEmptyCherryPicksEffect(
      proc,
      tmpWorktree,
      commitList.length,
    );
    if (resolved) {
      const newHead = (yield* proc.exec([
        "git",
        "-C",
        tmpWorktree,
        "rev-parse",
        "HEAD",
      ])).trim();
      console.log(`$ git -C ${repoRoot} branch -f ${targetBranch} ${newHead}`);
      yield* proc.exec([
        "git",
        "-C",
        repoRoot,
        "branch",
        "-f",
        targetBranch,
        newHead,
      ]);
      return true;
    }

    console.error("[nas] Cherry-pick failed with conflicts.");
    yield* gitExec(proc, ["git", "-C", tmpWorktree, "cherry-pick", "--abort"]);
    return false;
  });
}

// ---------------------------------------------------------------------------
// Resolve empty cherry-picks
// ---------------------------------------------------------------------------

function resolveEmptyCherryPicksEffect(
  proc: Proc,
  worktree: string,
  maxAttempts: number,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    for (let i = 0; i < maxAttempts; i++) {
      // CHERRY_PICK_HEAD が存在するか（cherry-pick 進行中か）
      const cpHead = yield* gitExec(proc, [
        "git",
        "-C",
        worktree,
        "rev-parse",
        "CHERRY_PICK_HEAD",
      ]);
      if (cpHead === null) {
        console.log("[nas] Cherry-pick completed (empty commits skipped).");
        return true;
      }

      // working tree がクリーンなら空コミット → skip
      const status = (yield* proc.exec([
        "git",
        "-C",
        worktree,
        "status",
        "--porcelain",
      ])).trim();
      if (status === "") {
        console.log("[nas] Skipping empty cherry-pick (already applied).");
        yield* gitExec(proc, ["git", "-C", worktree, "cherry-pick", "--skip"]);
      } else {
        return false;
      }
    }

    // ループ終了後、まだ CHERRY_PICK_HEAD が残っているか確認
    const finalCheck = yield* gitExec(proc, [
      "git",
      "-C",
      worktree,
      "rev-parse",
      "CHERRY_PICK_HEAD",
    ]);
    if (finalCheck === null) {
      console.log("[nas] Cherry-pick completed (empty commits skipped).");
      return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** .nas/.gitignore が存在しなければ作成する (Effect version) */
function ensureNasGitignoreEffect(
  repoRoot: string,
  fsService: Fs,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const gitignorePath = path.join(repoRoot, ".nas", ".gitignore");
    const fileExists = yield* fsService.exists(gitignorePath);
    if (!fileExists) {
      yield* fsService.mkdir(path.join(repoRoot, ".nas"), { recursive: true });
      yield* fsService.writeFile(gitignorePath, "*\n");
    }
  });
}
