/**
 * Public barrel for {@link GitWorktreeService}. The implementation is split
 * into siblings under `git_worktree_service/`; external consumers import the
 * Tag, Live layer, Fake factory, and types from here.
 *
 * Internal Ops Tags and the D2 functions they support are intentionally NOT
 * re-exported. The colocated test file imports them through the sub-paths
 * (`./git_worktree_service/cherry_pick.ts`, etc.) instead.
 */

export {
  GitWorktreeService,
  type GitWorktreeServiceFakeConfig,
  GitWorktreeServiceLive,
  makeGitWorktreeServiceFake,
} from "./git_worktree_service/service.ts";
export type {
  CreateWorktreeParams,
  WorktreeEntry,
  WorktreeHandle,
  WorktreeTeardownPlan,
} from "./git_worktree_service/types.ts";
