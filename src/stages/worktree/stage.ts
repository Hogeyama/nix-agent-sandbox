/**
 * WorktreeStage — git worktree のライフサイクル管理 (EffectStage)
 *
 * This stage is an orchestration boundary. All git I/O is delegated to
 * GitWorktreeService; all user interaction goes through PromptService.
 * The stage itself only calls pure planners, service methods, and
 * returns EffectStageResult.
 */

import * as path from "node:path";
import { Effect, type Scope } from "effect";
import { logInfo } from "../../log.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { WorkspaceState } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import {
  GitWorktreeService,
  type WorktreeHandle,
  type WorktreeTeardownPlan,
} from "./git_worktree.ts";
import { PromptService } from "./prompt_service.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function buildWorkspaceResult(
  imageName: string,
  workDir: string,
  mountDir?: string,
): { workspace: WorkspaceState } {
  const workspace: WorkspaceState = { workDir, imageName };
  return {
    workspace: mountDir ? { ...workspace, mountDir } : workspace,
  };
}

// ---------------------------------------------------------------------------
// Stage factory
// ---------------------------------------------------------------------------

export function createWorktreeStage(
  shared: StageInput,
): Stage<
  "workspace",
  { workspace: WorkspaceState },
  GitWorktreeService | PromptService,
  unknown
> {
  return {
    name: "WorktreeStage",
    needs: ["workspace"],

    run(
      input,
    ): Effect.Effect<
      { workspace: WorkspaceState },
      unknown,
      Scope.Scope | GitWorktreeService | PromptService
    > {
      return Effect.gen(function* () {
        const wt = shared.profile.worktree;
        if (!wt) {
          logInfo("[nas] Worktree: skipped (not configured)");
          return { workspace: input.workspace };
        }

        const svc = yield* GitWorktreeService;
        const prompts = yield* PromptService;

        const workDir = input.workspace.workDir;
        const repoRoot = yield* svc.resolveRepository(workDir);
        const resolvedBase = yield* svc.resolveBaseBranch(repoRoot, wt.base);

        // Check for existing worktrees to reuse
        const existing = yield* svc.findProfileWorktrees(
          repoRoot,
          shared.profileName,
        );
        if (existing.length > 0) {
          const reused = yield* prompts.reuseWorktree(existing);
          if (reused) {
            logInfo(`[nas] Reusing worktree: ${reused.path}`);
            return buildWorkspaceResult(
              input.workspace.imageName,
              reused.path,
              repoRoot,
            );
          }
        }

        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const worktreeName = `nas-${ts}`;
        const branchName = `nas/${ts}`;
        const worktreePath = path.join(
          repoRoot,
          ".nas",
          "worktrees",
          worktreeName,
        );

        // Create worktree via service (returns handle)
        const handle = yield* svc.createWorktree({
          repoRoot,
          worktreePath,
          branchName,
          baseBranch: resolvedBase,
          onCreate: wt.onCreate,
        });

        // Register teardown finalizer
        yield* Effect.addFinalizer(() =>
          buildTeardownPlan(svc, prompts, handle).pipe(
            Effect.flatMap((plan) => handle.close(plan)),
            Effect.catchAll(() =>
              Effect.logWarning("WorktreeStage cleanup failed"),
            ),
          ),
        );

        return buildWorkspaceResult(
          input.workspace.imageName,
          worktreePath,
          repoRoot,
        );
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Teardown plan builder (orchestrates service queries + prompts)
// ---------------------------------------------------------------------------

function buildTeardownPlan(
  svc: Effect.Effect.Success<typeof GitWorktreeService>,
  prompts: Effect.Effect.Success<typeof PromptService>,
  handle: WorktreeHandle,
): Effect.Effect<WorktreeTeardownPlan> {
  return Effect.gen(function* () {
    // Show the current HEAD so the user can reference this commit later
    const head = yield* svc.getHead(handle.worktreePath);
    if (head !== null) {
      console.log(`[nas] Worktree HEAD: ${head.trim()}`);
    }

    const isDirty = yield* svc.isWorktreeDirty(handle.worktreePath);
    const action = yield* prompts.worktreeAction({
      path: handle.worktreePath,
      isDirty,
    });
    if (action === "keep") {
      return { action: "keep" as const };
    }

    // If dirty, ask what to do with uncommitted changes
    let dirtyAction: "stash" | "delete" | "keep" | undefined;
    if (isDirty) {
      dirtyAction = yield* prompts.dirtyWorktreeAction({
        path: handle.worktreePath,
      });
      if (dirtyAction === "keep") {
        return { action: "keep" as const, dirtyAction };
      }
    }

    // Ask what to do with the branch
    const commitLines = yield* svc.listBranchCommits({
      repoRoot: handle.repoRoot,
      branchName: handle.branchName,
      baseBranch: handle.baseBranch,
      limit: 10,
    });
    const branchAction = yield* prompts.branchAction({
      branchName: handle.branchName,
      commitLines,
    });

    let newBranchName: string | null = null;
    if (branchAction === "rename") {
      newBranchName = yield* prompts.renameBranchPrompt(handle.branchName);
    }

    return {
      action: "delete" as const,
      dirtyAction,
      branchAction,
      newBranchName,
    };
  });
}
