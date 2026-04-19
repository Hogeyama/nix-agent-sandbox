/**
 * Public types for {@link GitWorktreeService}: configuration inputs, the
 * teardown plan describing how a worktree should be closed, and the handle
 * stages receive after creation.
 */

import type { Effect } from "effect";

export interface CreateWorktreeParams {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly onCreate?: string;
}

export interface WorktreeTeardownPlan {
  readonly action: "keep" | "delete";
  readonly dirtyAction?: "stash" | "delete" | "keep";
  readonly branchAction?: "rename" | "cherry-pick" | "delete";
  readonly newBranchName?: string | null;
}

export interface WorktreeHandle {
  readonly worktreePath: string;
  readonly branchName: string;
  readonly repoRoot: string;
  readonly baseBranch: string;
  readonly close: (plan: WorktreeTeardownPlan) => Effect.Effect<void>;
}

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string;
  readonly branch: string;
  readonly base: string | null;
}
