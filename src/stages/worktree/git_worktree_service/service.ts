/**
 * GitWorktreeService — Effect-based abstraction over git worktree lifecycle.
 *
 * Encapsulates git worktree creation, querying, teardown, cherry-pick,
 * branch management, and dirty-state handling. Stages call intentful
 * methods instead of shelling out to git directly.
 *
 * Live implementation delegates to ProcessService and FsService.
 * Fake factory provides configurable stubs for testing.
 */

import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import { logInfo } from "../../../log.ts";
import { createWorktree, makeCreateWorktreeStackLayer } from "./create.ts";
import {
  checkDirty,
  type FsService,
  FsServiceTag,
  gitExec,
  type ProcessService,
  ProcessServiceTag,
  parseWorktreeList,
} from "./internal.ts";
import type {
  CreateWorktreeParams,
  WorktreeEntry,
  WorktreeHandle,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export class GitWorktreeService extends Context.Tag("nas/GitWorktreeService")<
  GitWorktreeService,
  {
    /** Resolve the git repository root for a working directory. */
    readonly resolveRepository: (workDir: string) => Effect.Effect<string>;

    /** Resolve "HEAD" to actual branch name; validate that the base ref exists. */
    readonly resolveBaseBranch: (
      repoRoot: string,
      base: string,
    ) => Effect.Effect<string>;

    /** Find existing nas-managed worktrees under `.nas/worktrees/`. */
    readonly findNasWorktrees: (
      repoRoot: string,
    ) => Effect.Effect<WorktreeEntry[]>;

    /** Create a new worktree (add, config, inherit dirty state, onCreate hook). */
    readonly createWorktree: (
      params: CreateWorktreeParams,
    ) => Effect.Effect<WorktreeHandle>;

    /** Check if a worktree has uncommitted changes. */
    readonly isWorktreeDirty: (worktreePath: string) => Effect.Effect<boolean>;

    /** Get the HEAD commit hash of a worktree. */
    readonly getHead: (worktreePath: string) => Effect.Effect<string | null>;

    /** List oneline commits on branch not on baseBranch, up to limit. */
    readonly listBranchCommits: (opts: {
      repoRoot: string;
      branchName: string;
      baseBranch: string;
      limit: number;
    }) => Effect.Effect<string[]>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const GitWorktreeServiceLive: Layer.Layer<
  GitWorktreeService,
  never,
  ProcessService | FsService
> = Layer.effect(
  GitWorktreeService,
  Effect.gen(function* () {
    const proc = yield* ProcessServiceTag;
    const fs = yield* FsServiceTag;

    return GitWorktreeService.of({
      resolveRepository: (workDir) =>
        Effect.gen(function* () {
          // --show-toplevel は worktree 内ではそのパスを返すため、
          // --git-common-dir の親ディレクトリで本体リポジトリルートを取得する
          const toplevel = yield* gitExec(proc, [
            "git",
            "-C",
            workDir,
            "rev-parse",
            "--show-toplevel",
          ]);
          if (toplevel === null) {
            return yield* Effect.fail(
              new Error(
                `"${workDir}" is not inside a git repository. Worktree requires a git repo.`,
              ),
            );
          }

          const commonDir = yield* gitExec(proc, [
            "git",
            "-C",
            workDir,
            "rev-parse",
            "--git-common-dir",
          ]);
          if (commonDir !== null) {
            const absCommonDir = path.resolve(workDir, commonDir.trim());
            const mainRoot = path.dirname(absCommonDir);
            if (mainRoot !== toplevel.trim()) {
              logInfo(
                `[nas] Detected git worktree; using main repository root: ${mainRoot}`,
              );
              return mainRoot;
            }
          }

          return toplevel.trim();
        }).pipe(Effect.orDie),

      resolveBaseBranch: (repoRoot, base) =>
        Effect.gen(function* () {
          // Resolve "HEAD" to current branch name
          let resolved = base;
          if (base === "HEAD") {
            const branch = yield* gitExec(proc, [
              "git",
              "-C",
              repoRoot,
              "symbolic-ref",
              "--short",
              "HEAD",
            ]);
            if (branch === null) {
              return yield* Effect.fail(
                new Error(
                  'worktree.base is "HEAD" but the repository is in detached HEAD state.',
                ),
              );
            }
            resolved = branch.trim();
            console.log(`[nas] Resolved HEAD to current branch: ${resolved}`);
          }

          // Validate the base ref exists
          const valid = yield* gitExec(proc, [
            "git",
            "-C",
            repoRoot,
            "rev-parse",
            "--verify",
            "--end-of-options",
            resolved,
          ]);
          if (valid === null) {
            return yield* Effect.fail(
              new Error(
                `Base ref "${resolved}" not found. Run "git fetch" to update remote refs.`,
              ),
            );
          }

          return resolved;
        }).pipe(Effect.orDie),

      findNasWorktrees: (repoRoot) =>
        Effect.gen(function* () {
          const output = yield* proc.exec([
            "git",
            "-C",
            repoRoot,
            "worktree",
            "list",
            "--porcelain",
          ]);

          const raw = parseWorktreeList(output);
          // Filter to worktrees under .nas/worktrees/ directory
          const nasWorktreeDir = path.join(repoRoot, ".nas", "worktrees");
          const nasEntries = raw.filter(
            (e) =>
              e.path.startsWith(nasWorktreeDir + path.sep) &&
              path.basename(e.path).startsWith("nas-"),
          );

          // Read nasBase config for each branch
          const entries: WorktreeEntry[] = [];
          for (const entry of nasEntries) {
            let base: string | null = null;
            if (entry.branch) {
              const branchName = entry.branch.replace("refs/heads/", "");
              const value = yield* gitExec(proc, [
                "git",
                "-C",
                repoRoot,
                "config",
                "--get",
                `branch.${branchName}.nasBase`,
              ]);
              if (value !== null) {
                const trimmed = value.trim();
                base = trimmed.length > 0 ? trimmed : null;
              }
            }
            entries.push({ ...entry, base });
          }

          return entries;
        }),

      createWorktree: (params) =>
        createWorktree(params).pipe(
          Effect.provide(makeCreateWorktreeStackLayer(proc, fs)),
        ),

      isWorktreeDirty: (worktreePath) => checkDirty(proc, worktreePath),

      getHead: (worktreePath) =>
        gitExec(proc, ["git", "-C", worktreePath, "rev-parse", "HEAD"]).pipe(
          Effect.map((h) => (h !== null ? h.trim() : null)),
        ),

      listBranchCommits: (opts) =>
        Effect.gen(function* () {
          const gitDir = ["-C", opts.repoRoot];
          const result = yield* gitExec(proc, [
            "git",
            ...gitDir,
            "log",
            "--oneline",
            `-${opts.limit}`,
            "--end-of-options",
            `${opts.baseBranch}..${opts.branchName}`,
          ]);
          if (result === null || result.trim() === "") return [];
          return result.trim().split("\n");
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface GitWorktreeServiceFakeConfig {
  readonly resolveRepository?: (workDir: string) => Effect.Effect<string>;
  readonly resolveBaseBranch?: (
    repoRoot: string,
    base: string,
  ) => Effect.Effect<string>;
  readonly findNasWorktrees?: (
    repoRoot: string,
  ) => Effect.Effect<WorktreeEntry[]>;
  readonly createWorktree?: (
    params: CreateWorktreeParams,
  ) => Effect.Effect<WorktreeHandle>;
  readonly isWorktreeDirty?: (worktreePath: string) => Effect.Effect<boolean>;
  readonly getHead?: (worktreePath: string) => Effect.Effect<string | null>;
  readonly listBranchCommits?: (opts: {
    repoRoot: string;
    branchName: string;
    baseBranch: string;
    limit: number;
  }) => Effect.Effect<string[]>;
}

export function makeGitWorktreeServiceFake(
  overrides: GitWorktreeServiceFakeConfig = {},
): Layer.Layer<GitWorktreeService> {
  const defaultHandle: WorktreeHandle = {
    worktreePath: "/tmp/fake-worktree",
    branchName: "wt/fake",
    repoRoot: "/tmp/fake-repo",
    baseBranch: "main",
    close: () => Effect.void,
  };

  return Layer.succeed(
    GitWorktreeService,
    GitWorktreeService.of({
      resolveRepository:
        overrides.resolveRepository ?? ((workDir) => Effect.succeed(workDir)),
      resolveBaseBranch:
        overrides.resolveBaseBranch ??
        ((_repoRoot, base) => Effect.succeed(base)),
      findNasWorktrees:
        overrides.findNasWorktrees ?? (() => Effect.succeed([])),
      createWorktree:
        overrides.createWorktree ?? (() => Effect.succeed(defaultHandle)),
      isWorktreeDirty:
        overrides.isWorktreeDirty ?? (() => Effect.succeed(false)),
      getHead: overrides.getHead ?? (() => Effect.succeed(null)),
      listBranchCommits:
        overrides.listBranchCommits ?? (() => Effect.succeed([])),
    }),
  );
}
