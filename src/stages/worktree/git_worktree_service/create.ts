/**
 * Worktree creation: `git worktree add`, record the base ref under
 * `branch.<name>.nasBase`, inherit dirty state from the base branch's
 * worktree, and run an optional `onCreate` shell hook. Returns a
 * {@link WorktreeHandle} whose `close` runs the teardown stack snapshotted
 * at acquisition time.
 */

import { Context, Effect, Layer } from "effect";
import { logInfo } from "../../../log.ts";
import {
  type CherryPickOps,
  type CherryPickToBaseOps,
  makeCherryPickOpsLayer,
  makeCherryPickToBaseOpsLayer,
} from "./cherry_pick.ts";
import { inheritDirtyBaseWorktree } from "./inherit_dirty.ts";
import {
  ensureNasGitignore,
  type Fs,
  type Proc,
  resolveLocalBranch,
} from "./internal.ts";
import {
  executeTeardown,
  makeTeardownOpsLayer,
  type TeardownOps,
} from "./teardown.ts";
import type { CreateWorktreeParams, WorktreeHandle } from "./types.ts";

/**
 * Module-internal service describing the primitive-level operations
 * {@link createWorktree} composes (worktree add, nasBase config, onCreate
 * hook, plus the `ensureNasGitignore` / `resolveLocalBranch` /
 * `inheritDirtyBaseWorktree` helpers). Every branch — with / without
 * onCreate hook, base as local branch vs remote-style ref — is reachable
 * from unit tests through fakes of this Tag.
 *
 * The teardown callback is **not** here: {@link createWorktree} snapshots
 * the ambient teardown-related Ops with `Effect.context` and wires
 * {@link executeTeardown} into the handle's `close` directly. That keeps
 * `WorktreeHandle.close`'s requirements (`R = never`) while surfacing every
 * Ops dependency in `createWorktree`'s own R so tests can fake them
 * independently.
 *
 * @internal Exported only for the colocated test file.
 */
export class CreateWorktreeOps extends Context.Tag(
  "nas/git_worktree/CreateWorktreeOps",
)<
  CreateWorktreeOps,
  {
    readonly ensureNasGitignore: (repoRoot: string) => Effect.Effect<void>;
    readonly addWorktree: (
      repoRoot: string,
      branchName: string,
      worktreePath: string,
      baseBranch: string,
    ) => Effect.Effect<void>;
    readonly recordNasBase: (
      repoRoot: string,
      branchName: string,
      baseBranch: string,
    ) => Effect.Effect<void>;
    readonly resolveLocalBranch: (
      repoRoot: string,
      ref: string,
    ) => Effect.Effect<string>;
    readonly inheritDirtyBaseWorktree: (
      repoRoot: string,
      localBaseBranch: string,
      targetWorktreePath: string,
    ) => Effect.Effect<void>;
    readonly runOnCreateHook: (
      cwd: string,
      script: string,
    ) => Effect.Effect<void>;
  }
>() {}

export function makeCreateWorktreeOpsLayer(
  proc: Proc,
  fs: Fs,
): Layer.Layer<CreateWorktreeOps> {
  return Layer.succeed(CreateWorktreeOps, {
    ensureNasGitignore: (repoRoot) => ensureNasGitignore(repoRoot, fs),
    addWorktree: (repoRoot, branchName, worktreePath, baseBranch) =>
      proc
        .exec([
          "git",
          "-C",
          repoRoot,
          "worktree",
          "add",
          "-b",
          branchName,
          "--end-of-options",
          worktreePath,
          baseBranch,
        ])
        .pipe(Effect.asVoid),
    recordNasBase: (repoRoot, branchName, baseBranch) =>
      proc
        .exec([
          "git",
          "-C",
          repoRoot,
          "config",
          `branch.${branchName}.nasBase`,
          baseBranch,
        ])
        .pipe(Effect.asVoid),
    resolveLocalBranch: (repoRoot, ref) =>
      resolveLocalBranch(proc, repoRoot, ref),
    inheritDirtyBaseWorktree: (repoRoot, localBaseBranch, targetWorktreePath) =>
      inheritDirtyBaseWorktree(
        proc,
        fs,
        repoRoot,
        localBaseBranch,
        targetWorktreePath,
      ),
    runOnCreateHook: (cwd, script) =>
      proc.exec(["bash", "-c", script], { cwd }).pipe(Effect.asVoid),
  });
}

/** Combined teardown stack provided to a {@link createWorktree} call. */
export function makeCreateWorktreeStackLayer(
  proc: Proc,
  fs: Fs,
): Layer.Layer<
  CreateWorktreeOps | TeardownOps | CherryPickToBaseOps | CherryPickOps
> {
  return Layer.mergeAll(
    makeCreateWorktreeOpsLayer(proc, fs),
    makeTeardownOpsLayer(proc),
    makeCherryPickToBaseOpsLayer(proc),
    makeCherryPickOpsLayer(proc),
  );
}

/**
 * @internal Exported only for the colocated test file.
 */
export function createWorktree(
  params: CreateWorktreeParams,
): Effect.Effect<
  WorktreeHandle,
  never,
  CreateWorktreeOps | TeardownOps | CherryPickToBaseOps | CherryPickOps
> {
  return Effect.gen(function* () {
    const ops = yield* CreateWorktreeOps;
    // Snapshot the teardown stack now so `handle.close` can run later with
    // no ambient Ops layer, keeping WorktreeHandle.close's R = never.
    const teardownContext = yield* Effect.context<
      TeardownOps | CherryPickToBaseOps | CherryPickOps
    >();
    yield* ops.ensureNasGitignore(params.repoRoot);

    logInfo(
      `[nas] Creating worktree: ${params.worktreePath} (branch: ${params.branchName}) from ${params.baseBranch}`,
    );
    logInfo(
      `$ git -C ${params.repoRoot} worktree add -b ${params.branchName} ${params.worktreePath} ${params.baseBranch}`,
    );
    yield* ops.addWorktree(
      params.repoRoot,
      params.branchName,
      params.worktreePath,
      params.baseBranch,
    );

    // Record base ref in branch config for `nas worktree list`
    yield* ops.recordNasBase(
      params.repoRoot,
      params.branchName,
      params.baseBranch,
    );

    const localBaseBranch = yield* ops.resolveLocalBranch(
      params.repoRoot,
      params.baseBranch,
    );
    yield* ops.inheritDirtyBaseWorktree(
      params.repoRoot,
      localBaseBranch,
      params.worktreePath,
    );

    if (params.onCreate) {
      logInfo(`[nas] Running on-create hook: ${params.onCreate}`);
      logInfo(`$ bash -c ${params.onCreate} (cwd: ${params.worktreePath})`);
      yield* ops.runOnCreateHook(params.worktreePath, params.onCreate);
    }

    const handle: WorktreeHandle = {
      worktreePath: params.worktreePath,
      branchName: params.branchName,
      repoRoot: params.repoRoot,
      baseBranch: params.baseBranch,
      close: (plan) =>
        executeTeardown(handle, plan).pipe(Effect.provide(teardownContext)),
    };

    return handle;
  });
}
