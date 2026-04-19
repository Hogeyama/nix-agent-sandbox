/**
 * Cherry-pick a branch's commits onto its base, with three nested D2 flows:
 *
 *  - {@link cherryPickToBase}: top-level. Resolves the local target branch,
 *    creates it if needed, and dispatches to either an in-worktree flow (if
 *    the target branch is already checked out somewhere) or a detached
 *    temporary worktree.
 *  - {@link cherryPickInWorktree}: stash → cherry-pick → abort/pop sequence
 *    inside an existing worktree.
 *  - {@link cherryPickInTmpWorktree}: cherry-pick inside a fresh detached
 *    worktree, then forward the target branch to its new HEAD.
 *
 * Each D2 has its own Ops Tag so unit tests can fake just the primitives the
 * branch they're exercising touches.
 */

import * as path from "node:path";
import { Context, Effect, Exit, Layer } from "effect";
import { logError, logInfo } from "../../../log.ts";
import {
  checkDirty,
  exitMessage,
  findWorktreeForBranch,
  gitExec,
  type Proc,
  resolveEmptyCherryPicks,
  resolveLocalBranch,
} from "./internal.ts";

/**
 * Module-internal service describing the primitive-level operations
 * {@link cherryPickToBase} (and its nested `setupExit` generator) compose.
 * The in-worktree / detached cherry-pick flows are **not** exposed here:
 * {@link cherryPickToBase} composes `cherryPickInWorktree` and
 * {@link cherryPickDetached} directly and surfaces their Ops in its own R.
 * That keeps this Tag's Live factory a pure forwarding over git primitives
 * instead of a wrapper that provides nested layers.
 *
 * @internal Exported only for the colocated test file.
 */
export class CherryPickToBaseOps extends Context.Tag(
  "nas/git_worktree/CherryPickToBaseOps",
)<
  CherryPickToBaseOps,
  {
    readonly listCommitsBetween: (
      repoRoot: string,
      baseBranch: string,
      branchName: string,
    ) => Effect.Effect<string>;
    readonly resolveLocalBranch: (
      repoRoot: string,
      ref: string,
    ) => Effect.Effect<string>;
    readonly verifyRefExists: (
      repoRoot: string,
      refName: string,
    ) => Effect.Effect<boolean>;
    readonly createBranch: (
      repoRoot: string,
      branchName: string,
      fromRef: string,
    ) => Effect.Effect<void>;
    readonly findWorktreeForBranch: (
      repoRoot: string,
      branchName: string,
    ) => Effect.Effect<string | null>;
    readonly cherryPickInDetachedWorktree: (
      commitList: string[],
      targetBranch: string,
      repoRoot: string,
    ) => Effect.Effect<boolean>;
  }
>() {}

export function makeCherryPickToBaseOpsLayer(
  proc: Proc,
): Layer.Layer<CherryPickToBaseOps> {
  return Layer.succeed(CherryPickToBaseOps, {
    listCommitsBetween: (repoRoot, baseBranch, branchName) =>
      proc.exec([
        "git",
        "-C",
        repoRoot,
        "log",
        "--format=%H",
        "--reverse",
        "--end-of-options",
        `${baseBranch}..${branchName}`,
      ]),
    resolveLocalBranch: (repoRoot, ref) =>
      resolveLocalBranch(proc, repoRoot, ref),
    verifyRefExists: (repoRoot, refName) =>
      gitExec(proc, [
        "git",
        "-C",
        repoRoot,
        "rev-parse",
        "--verify",
        "--end-of-options",
        refName,
      ]).pipe(Effect.map((r) => r !== null)),
    createBranch: (repoRoot, branchName, fromRef) =>
      proc
        .exec([
          "git",
          "-C",
          repoRoot,
          "branch",
          "--end-of-options",
          branchName,
          fromRef,
        ])
        .pipe(Effect.asVoid),
    findWorktreeForBranch: (repoRoot, branchName) =>
      findWorktreeForBranch(proc, repoRoot, branchName),
    cherryPickInDetachedWorktree: (commitList, targetBranch, repoRoot) =>
      cherryPickDetached(proc, commitList, targetBranch, repoRoot),
  });
}

/**
 * @internal Exported only for the colocated test file.
 */
export function cherryPickToBase(
  branchName: string,
  repoRoot: string,
  baseBranch: string,
): Effect.Effect<boolean, never, CherryPickToBaseOps | CherryPickOps> {
  return Effect.gen(function* () {
    const ops = yield* CherryPickToBaseOps;
    const commitsRaw = (yield* ops.listCommitsBetween(
      repoRoot,
      baseBranch,
      branchName,
    )).trim();

    if (!commitsRaw) {
      logInfo("[nas] No commits to cherry-pick.");
      return true;
    }

    const commitList = commitsRaw.split("\n");
    logInfo(
      `[nas] Cherry-picking ${commitList.length} commit(s) onto ${baseBranch}...`,
    );

    const targetBranch = yield* ops.resolveLocalBranch(repoRoot, baseBranch);

    const setupExit = yield* Effect.gen(function* () {
      const refExists = yield* ops.verifyRefExists(
        repoRoot,
        `refs/heads/${targetBranch}`,
      );
      if (!refExists) {
        logInfo(
          `[nas] Creating local branch "${targetBranch}" from ${baseBranch}`,
        );
        logInfo(`$ git -C ${repoRoot} branch ${targetBranch} ${baseBranch}`);
        yield* ops.createBranch(repoRoot, targetBranch, baseBranch);
      }

      const checkedOutIn = yield* ops.findWorktreeForBranch(
        repoRoot,
        targetBranch,
      );

      if (checkedOutIn) {
        return yield* cherryPickInWorktree(
          checkedOutIn,
          commitList,
          targetBranch,
        );
      }

      return yield* ops.cherryPickInDetachedWorktree(
        commitList,
        targetBranch,
        repoRoot,
      );
    }).pipe(Effect.exit);

    if (Exit.isFailure(setupExit)) {
      logError(`[nas] Cherry-pick setup failed: ${exitMessage(setupExit)}`);
      return false;
    }
    return setupExit.value;
  });
}

/**
 * Module-internal service describing the intentful git operations that
 * {@link cherryPickInWorktree} composes. Factoring this out lets unit tests
 * replace individual steps (stash / cherry-pick / abort / pop) with fakes so
 * every branch of the composition can be exercised without a real git
 * process.
 *
 * @internal Exported only for the colocated test file; not for use from other
 * stages or services.
 */
export class CherryPickOps extends Context.Tag(
  "nas/git_worktree/CherryPickOps",
)<
  CherryPickOps,
  {
    readonly isDirty: (worktreePath: string) => Effect.Effect<boolean>;
    readonly stashPush: (
      worktreePath: string,
      message: string,
    ) => Effect.Effect<boolean>;
    readonly applyCherryPick: (
      worktreePath: string,
      commits: readonly string[],
    ) => Effect.Effect<boolean>;
    readonly resolveEmpties: (
      worktreePath: string,
      expected: number,
    ) => Effect.Effect<boolean>;
    readonly cherryPickAbort: (worktreePath: string) => Effect.Effect<void>;
    readonly stashPop: (worktreePath: string) => Effect.Effect<boolean>;
  }
>() {}

export function makeCherryPickOpsLayer(proc: Proc): Layer.Layer<CherryPickOps> {
  return Layer.succeed(CherryPickOps, {
    isDirty: (wt) => checkDirty(proc, wt),
    stashPush: (wt, message) =>
      gitExec(proc, [
        "git",
        "-C",
        wt,
        "stash",
        "push",
        "--include-untracked",
        "-m",
        message,
      ]).pipe(Effect.map((r) => r !== null)),
    applyCherryPick: (wt, commits) =>
      gitExec(proc, [
        "git",
        "-C",
        wt,
        "cherry-pick",
        "--end-of-options",
        ...commits,
      ]).pipe(Effect.map((r) => r !== null)),
    resolveEmpties: (wt, expected) =>
      resolveEmptyCherryPicks(proc, wt, expected),
    cherryPickAbort: (wt) =>
      gitExec(proc, ["git", "-C", wt, "cherry-pick", "--abort"]).pipe(
        Effect.asVoid,
      ),
    stashPop: (wt) =>
      gitExec(proc, ["git", "-C", wt, "stash", "pop"]).pipe(
        Effect.map((r) => r !== null),
      ),
  });
}

/**
 * @internal Exported only for the colocated test file.
 */
export function cherryPickInWorktree(
  worktreePath: string,
  commitList: string[],
  targetBranch: string,
): Effect.Effect<boolean, never, CherryPickOps> {
  return Effect.gen(function* () {
    const ops = yield* CherryPickOps;
    const dirty = yield* ops.isDirty(worktreePath);
    let stashed = false;
    const stashMessage = `nas cherry-pick ${targetBranch} ${new Date().toISOString()}`;

    if (dirty) {
      logInfo(
        `[nas] Worktree for "${targetBranch}" has uncommitted changes; stashing temporarily before cherry-pick.`,
      );
      const stashOk = yield* ops.stashPush(worktreePath, stashMessage);
      if (!stashOk) {
        logError(`[nas] Failed to stash changes in "${targetBranch}" worktree`);
        logError(`[nas]   ${worktreePath}`);
        return false;
      }
      stashed = true;
    }

    logInfo(`[nas] Cherry-picking in worktree: ${worktreePath}`);
    let success = yield* ops.applyCherryPick(worktreePath, commitList);

    if (!success) {
      logError("[nas] cherry-pick exited with error");
      const resolved = yield* ops.resolveEmpties(
        worktreePath,
        commitList.length,
      );
      if (resolved) {
        success = true;
      } else {
        logError("[nas] Cherry-pick failed with conflicts.");
        yield* ops.cherryPickAbort(worktreePath);
      }
    }

    if (!success && stashed) {
      const popOk = yield* ops.stashPop(worktreePath);
      if (!popOk) {
        logError(
          `[nas] Failed to restore stashed changes in "${targetBranch}" worktree`,
        );
      }
      return false;
    }
    if (!success) return false;

    if (stashed) {
      const popOk = yield* ops.stashPop(worktreePath);
      if (!popOk) {
        logError(
          `[nas] Cherry-pick succeeded, but restoring stashed changes failed`,
        );
        return false;
      }
    }

    logInfo("[nas] Cherry-pick completed successfully.");
    return true;
  });
}

function cherryPickDetached(
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
      "--end-of-options",
      `refs/heads/${targetBranch}`,
    ])).trim();
    const tmpWorktree = path.join(
      repoRoot,
      ".nas",
      "worktrees",
      `nas-cherry-pick-tmp-${Date.now()}`,
    );
    logInfo(
      `$ git -C ${repoRoot} worktree add --detach ${tmpWorktree} ${targetRef}`,
    );
    yield* proc.exec([
      "git",
      "-C",
      repoRoot,
      "worktree",
      "add",
      "--detach",
      "--end-of-options",
      tmpWorktree,
      targetRef,
    ]);

    const result = yield* Effect.acquireUseRelease(
      Effect.succeed(tmpWorktree),
      (tw) =>
        cherryPickInTmpWorktree(tw, commitList, targetBranch, repoRoot).pipe(
          Effect.provide(makeTmpCherryPickOpsLayer(proc)),
        ),
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

/**
 * Module-internal service for {@link cherryPickInTmpWorktree}. Distinct from
 * {@link CherryPickOps} because the tmp-worktree flow has no stash concept;
 * instead it needs to forward the target branch to the worktree's new HEAD
 * after a successful cherry-pick.
 *
 * @internal Exported only for the colocated test file.
 */
export class TmpCherryPickOps extends Context.Tag(
  "nas/git_worktree/TmpCherryPickOps",
)<
  TmpCherryPickOps,
  {
    readonly applyCherryPick: (
      worktreePath: string,
      commits: readonly string[],
    ) => Effect.Effect<boolean>;
    readonly resolveEmpties: (
      worktreePath: string,
      expected: number,
    ) => Effect.Effect<boolean>;
    readonly cherryPickAbort: (worktreePath: string) => Effect.Effect<void>;
    readonly updateBranchToWorktreeHead: (
      worktreePath: string,
      repoRoot: string,
      targetBranch: string,
    ) => Effect.Effect<void>;
  }
>() {}

function makeTmpCherryPickOpsLayer(proc: Proc): Layer.Layer<TmpCherryPickOps> {
  return Layer.succeed(TmpCherryPickOps, {
    applyCherryPick: (wt, commits) =>
      gitExec(proc, [
        "git",
        "-C",
        wt,
        "cherry-pick",
        "--end-of-options",
        ...commits,
      ]).pipe(Effect.map((r) => r !== null)),
    resolveEmpties: (wt, expected) =>
      resolveEmptyCherryPicks(proc, wt, expected),
    cherryPickAbort: (wt) =>
      gitExec(proc, ["git", "-C", wt, "cherry-pick", "--abort"]).pipe(
        Effect.asVoid,
      ),
    updateBranchToWorktreeHead: (wt, repoRoot, targetBranch) =>
      Effect.gen(function* () {
        const newHead = (yield* proc.exec([
          "git",
          "-C",
          wt,
          "rev-parse",
          "HEAD",
        ])).trim();
        logInfo(`$ git -C ${repoRoot} branch -f ${targetBranch} ${newHead}`);
        yield* proc.exec([
          "git",
          "-C",
          repoRoot,
          "branch",
          "-f",
          "--end-of-options",
          targetBranch,
          newHead,
        ]);
      }),
  });
}

/**
 * @internal Exported only for the colocated test file.
 */
export function cherryPickInTmpWorktree(
  tmpWorktree: string,
  commitList: string[],
  targetBranch: string,
  repoRoot: string,
): Effect.Effect<boolean, never, TmpCherryPickOps> {
  return Effect.gen(function* () {
    const ops = yield* TmpCherryPickOps;
    logInfo(`$ git -C ${tmpWorktree} cherry-pick ${commitList.join(" ")}`);
    const cpOk = yield* ops.applyCherryPick(tmpWorktree, commitList);

    if (cpOk) {
      yield* ops.updateBranchToWorktreeHead(
        tmpWorktree,
        repoRoot,
        targetBranch,
      );
      logInfo("[nas] Cherry-pick completed successfully.");
      return true;
    }

    logError("[nas] cherry-pick exited with error");
    const resolved = yield* ops.resolveEmpties(tmpWorktree, commitList.length);
    if (resolved) {
      yield* ops.updateBranchToWorktreeHead(
        tmpWorktree,
        repoRoot,
        targetBranch,
      );
      return true;
    }

    logError("[nas] Cherry-pick failed with conflicts.");
    yield* ops.cherryPickAbort(tmpWorktree);
    return false;
  });
}
