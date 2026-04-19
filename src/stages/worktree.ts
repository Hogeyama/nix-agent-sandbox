/**
 * git worktree ステージ — barrel re-export
 */

export { resolveBase } from "./worktree/git_helpers.ts";
export {
  GitWorktreeService,
  GitWorktreeServiceLive,
} from "./worktree/git_worktree_service.ts";
export type { CleanResult, WorktreeEntry } from "./worktree/management.ts";
export {
  cleanNasWorktrees,
  listNasWorktrees,
  listOrphanNasBranches,
} from "./worktree/management.ts";
export {
  PromptService,
  PromptServiceLive,
} from "./worktree/prompt_service.ts";
export { createWorktreeStage } from "./worktree/stage.ts";
