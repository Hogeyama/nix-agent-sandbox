/**
 * Dirty-state inheritance: when a new worktree is created from a base branch
 * whose checkout has uncommitted changes, mirror those changes into the new
 * worktree (staged diff, unstaged diff, untracked files).
 */

import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import { logInfo } from "../../../log.ts";
import {
  applyPatch,
  checkDirty,
  type Fs,
  findWorktreeForBranch,
  isSafeRelativePath,
  type Proc,
} from "./internal.ts";

/**
 * Inherit dirty changes from the base branch's worktree to the new worktree.
 * Applies staged diff, unstaged diff, and copies untracked files.
 */
export function inheritDirtyBaseWorktree(
  proc: Proc,
  fs: Fs,
  repoRoot: string,
  localBaseBranch: string,
  targetWorktreePath: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const sourceWorktreePath = yield* findWorktreeForBranch(
      proc,
      repoRoot,
      localBaseBranch,
    );
    if (!sourceWorktreePath || sourceWorktreePath === targetWorktreePath)
      return;

    const dirty = yield* checkDirty(proc, sourceWorktreePath);
    if (!dirty) return;

    logInfo(
      `[nas] Inheriting dirty changes from ${sourceWorktreePath} (${localBaseBranch})`,
    );

    yield* applyTrackedDiff(sourceWorktreePath, targetWorktreePath).pipe(
      Effect.provide(makeApplyTrackedDiffOpsLayer(proc, fs)),
    );
    yield* copyUntrackedFiles(proc, fs, sourceWorktreePath, targetWorktreePath);
  });
}

/**
 * Module-internal service for {@link applyTrackedDiff}. The function branches
 * on whether each of staged / unstaged diffs is empty, and we want those
 * branches reachable from unit tests without running real git processes.
 *
 * @internal Exported only for the colocated test file.
 */
export class ApplyTrackedDiffOps extends Context.Tag(
  "nas/git_worktree/ApplyTrackedDiffOps",
)<
  ApplyTrackedDiffOps,
  {
    readonly readTrackedDiff: (
      sourceWorktreePath: string,
      opts: { readonly cached: boolean },
    ) => Effect.Effect<string>;
    readonly applyPatchToTarget: (
      targetWorktreePath: string,
      patch: string,
      extraArgs: readonly string[],
    ) => Effect.Effect<void>;
  }
>() {}

function makeApplyTrackedDiffOpsLayer(
  proc: Proc,
  fs: Fs,
): Layer.Layer<ApplyTrackedDiffOps> {
  return Layer.succeed(ApplyTrackedDiffOps, {
    readTrackedDiff: (sourceWorktreePath, { cached }) =>
      proc.exec([
        "git",
        "-C",
        sourceWorktreePath,
        "diff",
        "--no-ext-diff",
        "--binary",
        ...(cached ? ["--cached"] : []),
      ]),
    applyPatchToTarget: (targetWorktreePath, patch, extraArgs) =>
      applyPatch(proc, fs, targetWorktreePath, patch, [...extraArgs]),
  });
}

/**
 * Apply tracked diffs (staged + unstaged) from source to target worktree.
 *
 * @internal Exported only for the colocated test file.
 */
export function applyTrackedDiff(
  sourceWorktreePath: string,
  targetWorktreePath: string,
): Effect.Effect<void, never, ApplyTrackedDiffOps> {
  return Effect.gen(function* () {
    const ops = yield* ApplyTrackedDiffOps;
    const stagedPatch = yield* ops.readTrackedDiff(sourceWorktreePath, {
      cached: true,
    });
    if (stagedPatch.trim().length > 0) {
      yield* ops.applyPatchToTarget(targetWorktreePath, stagedPatch, [
        "--index",
      ]);
    }

    const unstagedPatch = yield* ops.readTrackedDiff(sourceWorktreePath, {
      cached: false,
    });
    if (unstagedPatch.trim().length > 0) {
      yield* ops.applyPatchToTarget(targetWorktreePath, unstagedPatch, []);
    }
  });
}

/** Copy untracked files from source to target worktree. */
function copyUntrackedFiles(
  proc: Proc,
  fs: Fs,
  sourceWorktreePath: string,
  targetWorktreePath: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const output = yield* proc.exec([
      "git",
      "-C",
      sourceWorktreePath,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    if (output.length === 0) return;

    const untrackedFiles = output.split("\0").filter((f) => f.length > 0);
    for (const relativePath of untrackedFiles) {
      // The source worktree may be attacker-controlled (untrusted clone).
      // Reject any path that could escape the target directory.
      if (!isSafeRelativePath(relativePath, targetWorktreePath)) {
        console.error(`[nas] Skipping unsafe untracked path: ${relativePath}`);
        continue;
      }
      const sourcePath = path.join(sourceWorktreePath, relativePath);
      const targetPath = path.join(targetWorktreePath, relativePath);
      yield* fs.mkdir(path.dirname(targetPath), { recursive: true });
      // `cp -P` preserves symlinks as symlinks instead of dereferencing
      // them. This prevents an untracked `evil -> /etc/passwd` symlink in
      // the source worktree from exfiltrating host files into the new
      // worktree (where the agent container would read them).
      yield* proc.exec(["cp", "-P", "--", sourcePath, targetPath]);
    }
  });
}
