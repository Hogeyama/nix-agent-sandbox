/**
 * PromptService — Effect-based abstraction over interactive worktree prompts.
 *
 * Live implementation delegates to the existing async prompt functions.
 * Fake factory allows tests to supply pre-configured responses.
 */

import { Context, Effect, Layer } from "effect";
import type { WorktreeEntry } from "./management.ts";
import {
  type BranchAction,
  type DirtyWorktreeAction,
  promptBranchAction,
  promptDirtyWorktreeAction,
  promptReuseWorktree,
  promptWorktreeAction,
  type WorktreeAction,
} from "./prompts.ts";

// ---------------------------------------------------------------------------
// Service definition
// ---------------------------------------------------------------------------

export class PromptService extends Context.Tag("nas/PromptService")<
  PromptService,
  {
    readonly worktreeAction: (path: string) => Effect.Effect<WorktreeAction>;
    readonly dirtyWorktreeAction: (
      path: string,
    ) => Effect.Effect<DirtyWorktreeAction | null>;
    readonly branchAction: (
      branch: string | null,
      base: string | null,
      root: string | null,
    ) => Effect.Effect<BranchAction>;
    readonly reuseWorktree: (
      entries: readonly WorktreeEntry[],
    ) => Effect.Effect<WorktreeEntry | null>;
    readonly renameBranchPrompt: (
      current: string,
    ) => Effect.Effect<string | null>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

export const PromptServiceLive = Layer.succeed(PromptService, {
  worktreeAction: (path) =>
    Effect.tryPromise(() => promptWorktreeAction(path)).pipe(Effect.orDie),

  dirtyWorktreeAction: (path) =>
    Effect.tryPromise(() => promptDirtyWorktreeAction(path)).pipe(Effect.orDie),

  branchAction: (branch, base, root) =>
    Effect.tryPromise(() => promptBranchAction(branch, base, root)).pipe(
      Effect.orDie,
    ),

  reuseWorktree: (entries) =>
    Effect.sync(() => promptReuseWorktree(entries as WorktreeEntry[])),

  renameBranchPrompt: (current) =>
    Effect.sync(() => {
      const answer = prompt(`[nas] New branch name (current: ${current}):`);
      return answer?.trim() || null;
    }),
});

// ---------------------------------------------------------------------------
// Fake (for testing)
// ---------------------------------------------------------------------------

export interface PromptServiceFakeConfig {
  worktreeAction?: WorktreeAction;
  dirtyWorktreeAction?: DirtyWorktreeAction | null;
  branchAction?: BranchAction;
  reuseWorktree?: WorktreeEntry | null;
  renameBranchPrompt?: string | null;
}

export function makePromptServiceFake(
  config: PromptServiceFakeConfig = {},
): Layer.Layer<PromptService> {
  return Layer.succeed(PromptService, {
    worktreeAction: (_path) => Effect.succeed(config.worktreeAction ?? "keep"),

    dirtyWorktreeAction: (_path) =>
      Effect.succeed(config.dirtyWorktreeAction ?? null),

    branchAction: (_branch, _base, _root) =>
      Effect.succeed(config.branchAction ?? "delete"),

    reuseWorktree: (_entries) => Effect.succeed(config.reuseWorktree ?? null),

    renameBranchPrompt: (_current) =>
      Effect.succeed(config.renameBranchPrompt ?? null),
  });
}
