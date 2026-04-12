/**
 * git worktree ステージ — barrel re-export
 */

export { resolveBase } from "./worktree/git_helpers.ts";
export type { CleanResult, WorktreeEntry } from "./worktree/management.ts";
export {
  cleanNasWorktrees,
  listNasWorktrees,
  listOrphanNasBranches,
} from "./worktree/management.ts";
export { createWorktreeStage } from "./worktree/stage.ts";
