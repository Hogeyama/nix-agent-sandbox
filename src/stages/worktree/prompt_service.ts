/**
 * PromptService — Effect-based abstraction over interactive worktree prompts.
 *
 * Live implementation delegates to the existing sync prompt functions.
 * Fake factory allows tests to supply pre-configured responses.
 *
 * This service is purely about user interaction — it does NOT perform git I/O.
 * Git state (isDirty, commitLines) is fetched by the stage via GitWorktreeService
 * and passed into these methods as parameters.
 */

import { Context, Effect, Layer } from "effect";
import type { WorktreeEntry } from "../../services/git_worktree.ts";
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
    readonly worktreeAction: (opts: {
      path: string;
      isDirty: boolean;
    }) => Effect.Effect<WorktreeAction>;
    readonly dirtyWorktreeAction: (opts: {
      path: string;
    }) => Effect.Effect<DirtyWorktreeAction>;
    readonly branchAction: (opts: {
      branchName: string | null;
      commitLines: string[];
    }) => Effect.Effect<BranchAction>;
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
  worktreeAction: (opts) =>
    Effect.sync(() => promptWorktreeAction(opts.path, opts.isDirty)),

  dirtyWorktreeAction: (opts) =>
    Effect.sync(() => promptDirtyWorktreeAction(opts.path)),

  branchAction: (opts) =>
    Effect.sync(() => promptBranchAction(opts.branchName, opts.commitLines)),

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
  dirtyWorktreeAction?: DirtyWorktreeAction;
  branchAction?: BranchAction;
  reuseWorktree?: WorktreeEntry | null;
  renameBranchPrompt?: string | null;
}

export function makePromptServiceFake(
  config: PromptServiceFakeConfig = {},
): Layer.Layer<PromptService> {
  return Layer.succeed(PromptService, {
    worktreeAction: (_opts) => Effect.succeed(config.worktreeAction ?? "keep"),

    dirtyWorktreeAction: (_opts) =>
      Effect.succeed(config.dirtyWorktreeAction ?? "delete"),

    branchAction: (_opts) => Effect.succeed(config.branchAction ?? "delete"),

    reuseWorktree: (_entries) => Effect.succeed(config.reuseWorktree ?? null),

    renameBranchPrompt: (_current) =>
      Effect.succeed(config.renameBranchPrompt ?? null),
  });
}
