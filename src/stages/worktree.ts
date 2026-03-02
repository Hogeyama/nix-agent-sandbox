/**
 * git worktree ステージ
 */

import $ from "dax";
import * as path from "@std/path";
import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";

export class WorktreeStage implements Stage {
  name = "WorktreeStage";

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    const wt = ctx.profile.worktree;
    if (!wt) {
      console.log("[nas] Worktree: skipped (not configured)");
      return ctx;
    }

    const repoRoot = await getGitRoot(ctx.workDir);
    const worktreeName = generateWorktreeName(ctx.profileName);
    const worktreePath = path.join(path.dirname(repoRoot), worktreeName);

    console.log(`[nas] Creating worktree: ${worktreePath} from ${wt.base}`);
    await $`git -C ${repoRoot} worktree add ${worktreePath} ${wt.base}`
      .printCommand();

    if (wt.onCreate) {
      console.log(`[nas] Running on-create hook: ${wt.onCreate}`);
      await $`bash -c ${wt.onCreate}`.cwd(worktreePath).printCommand();
    }

    return { ...ctx, workDir: worktreePath };
  }
}

async function getGitRoot(dir: string): Promise<string> {
  const result = await $`git -C ${dir} rev-parse --show-toplevel`.text();
  return result.trim();
}

function generateWorktreeName(profileName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `nas-${profileName}-${ts}`;
}
