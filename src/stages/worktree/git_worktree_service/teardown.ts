/**
 * Worktree teardown: stash / branch-rename / cherry-pick / worktree-remove /
 * branch-delete. The composed flow lives in {@link executeTeardown}; the
 * individual git primitives go through {@link TeardownOps} so unit tests can
 * fake any branch (stash failure, rename, cherry-pick failure, ...).
 */

import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import { logError, logInfo } from "../../../log.ts";
import {
  type CherryPickOps,
  type CherryPickToBaseOps,
  cherryPickToBase,
} from "./cherry_pick.ts";
import { gitExec, type Proc } from "./internal.ts";
import type { WorktreeHandle, WorktreeTeardownPlan } from "./types.ts";

/**
 * Module-internal service describing the primitive-level operations
 * {@link executeTeardown} needs (stash / rename / worktree remove / branch
 * delete). Each method is a thin wrapper over a single git invocation so the
 * teardown's branching — keep / stash-fails / rename / cherry-pick-success /
 * cherry-pick-fail — is reachable from unit tests without a real git
 * process.
 *
 * Cherry-pick is **not** here; `executeTeardown` composes
 * {@link cherryPickToBase} directly and surfaces its Ops in its own R so that
 * tests can fake the cherry-pick stack independently instead of through a
 * pre-wired wrapper.
 *
 * @internal Exported only for the colocated test file.
 */
export class TeardownOps extends Context.Tag("nas/git_worktree/TeardownOps")<
  TeardownOps,
  {
    readonly stashWorktreeChanges: (
      worktreePath: string,
    ) => Effect.Effect<void>;
    readonly renameBranch: (
      branchName: string,
      repoRoot: string,
      newName: string | null,
    ) => Effect.Effect<void>;
    readonly removeWorktree: (
      repoRoot: string,
      worktreePath: string,
    ) => Effect.Effect<boolean>;
    readonly deleteBranch: (
      repoRoot: string,
      branchName: string,
    ) => Effect.Effect<boolean>;
  }
>() {}

export function makeTeardownOpsLayer(proc: Proc): Layer.Layer<TeardownOps> {
  return Layer.succeed(TeardownOps, {
    stashWorktreeChanges: (wt) => stashWorktreeChanges(proc, wt),
    renameBranch: (branchName, repoRoot, newName) =>
      renameBranch(proc, branchName, repoRoot, newName),
    removeWorktree: (repoRoot, worktreePath) =>
      gitExec(proc, [
        "git",
        "-C",
        repoRoot,
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]).pipe(Effect.map((r) => r !== null)),
    deleteBranch: (repoRoot, branchName) =>
      gitExec(proc, [
        "git",
        "-C",
        repoRoot,
        "branch",
        "-D",
        "--end-of-options",
        branchName,
      ]).pipe(Effect.map((r) => r !== null)),
  });
}

/**
 * @internal Exported only for the colocated test file.
 */
export function executeTeardown(
  handle: WorktreeHandle,
  plan: WorktreeTeardownPlan,
): Effect.Effect<
  void,
  never,
  TeardownOps | CherryPickToBaseOps | CherryPickOps
> {
  return Effect.gen(function* () {
    const ops = yield* TeardownOps;
    if (plan.action === "keep") {
      logInfo(`[nas] Worktree kept: ${handle.worktreePath}`);
      return;
    }

    // Stash if requested
    if (plan.dirtyAction === "stash") {
      const stashResult = yield* ops
        .stashWorktreeChanges(handle.worktreePath)
        .pipe(Effect.either);
      if (stashResult._tag === "Left") {
        logError(`[nas] ${stashResult.left}`);
        logInfo(`[nas] Worktree kept: ${handle.worktreePath}`);
        return;
      }
    }
    if (plan.dirtyAction === "keep") {
      logInfo(`[nas] Worktree kept: ${handle.worktreePath}`);
      return;
    }

    // Handle branch action
    let shouldDeleteBranch = plan.branchAction !== "rename";

    if (plan.branchAction === "rename") {
      yield* ops.renameBranch(
        handle.branchName,
        handle.repoRoot,
        plan.newBranchName ?? null,
      );
    } else if (plan.branchAction === "cherry-pick") {
      const success = yield* cherryPickToBase(
        handle.branchName,
        handle.repoRoot,
        handle.baseBranch,
      );
      if (!success) {
        shouldDeleteBranch = false;
        logInfo(
          `[nas] Branch "${handle.branchName}" is preserved for manual resolution.`,
        );
      }
    }

    // Remove worktree
    logInfo(`[nas] Removing worktree: ${handle.worktreePath}`);
    const removeOk = yield* ops.removeWorktree(
      handle.repoRoot,
      handle.worktreePath,
    );
    if (!removeOk) {
      logError("[nas] Failed to remove worktree");
    }

    // Delete branch unless renamed or cherry-pick failed
    if (shouldDeleteBranch && handle.branchName) {
      const delOk = yield* ops.deleteBranch(handle.repoRoot, handle.branchName);
      if (delOk) {
        logInfo(`[nas] Deleted branch: ${handle.branchName}`);
      } else {
        logError(`[nas] Failed to delete branch: ${handle.branchName}`);
      }
    }
  });
}

function stashWorktreeChanges(
  proc: Proc,
  worktreePath: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const stashMessage = `nas teardown ${path.basename(worktreePath)} ${new Date().toISOString()}`;
    logInfo(
      `$ git -C ${worktreePath} stash push --include-untracked -m ${stashMessage}`,
    );
    yield* proc.exec([
      "git",
      "-C",
      worktreePath,
      "stash",
      "push",
      "--include-untracked",
      "-m",
      stashMessage,
    ]);
    logInfo(`[nas] Stashed worktree changes: ${stashMessage}`);
  });
}

function renameBranch(
  proc: Proc,
  branchName: string,
  repoRoot: string,
  newName: string | null,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!newName) {
      logInfo("[nas] No name entered, keeping original branch name.");
      return;
    }
    const result = yield* gitExec(proc, [
      "git",
      "-C",
      repoRoot,
      "branch",
      "-m",
      "--end-of-options",
      branchName,
      newName,
    ]);
    if (result !== null) {
      logInfo(`[nas] Renamed branch: ${branchName} → ${newName}`);
    } else {
      logError(`[nas] Failed to rename branch: ${branchName}`);
    }
  });
}
