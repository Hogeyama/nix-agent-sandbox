/**
 * CLI エントリポイント
 */

import { loadConfig, resolveProfile } from "./config/load.ts";
import { createContext } from "./pipeline/context.ts";
import { runPipeline } from "./pipeline/pipeline.ts";
import { WorktreeStage } from "./stages/worktree.ts";
import { cleanNasWorktrees, listNasWorktrees } from "./stages/worktree.ts";
import { NixDetectStage } from "./stages/nix_detect.ts";
import { MountStage } from "./stages/mount.ts";
import { DockerBuildStage, LaunchStage } from "./stages/launch.ts";
import { dockerImageExists, dockerRemoveImage } from "./docker/client.ts";

const VERSION = "0.1.0";

export async function main(args: string[]): Promise<void> {
  // `--` 以降はエージェントに渡す引数
  const dashDashIdx = args.indexOf("--");
  const nasArgs = dashDashIdx >= 0 ? args.slice(0, dashDashIdx) : args;
  const agentExtraArgs = dashDashIdx >= 0 ? args.slice(dashDashIdx + 1) : [];

  // フラグ処理 (nas 自身の引数のみ)
  if (nasArgs.includes("--help") || nasArgs.includes("-h")) {
    printUsage();
    return;
  }
  if (nasArgs.includes("--version") || nasArgs.includes("-V")) {
    console.log(`nas ${VERSION}`);
    return;
  }

  // サブコマンド処理
  const subcommand = nasArgs.find((a) => !a.startsWith("-"));

  if (subcommand === "rebuild") {
    await runRebuild(nasArgs.filter((a) => a !== "rebuild"));
    return;
  }

  if (subcommand === "worktree") {
    await runWorktreeCommand(nasArgs.filter((a) => a !== "worktree"));
    return;
  }

  // プロファイル名 (最初の非フラグ引数)
  const profileName = subcommand;

  try {
    const config = await loadConfig();
    const { name, profile } = resolveProfile(config, profileName);
    const ctx = createContext(config, profile, name, Deno.cwd());

    const stages = [
      new WorktreeStage(),
      new DockerBuildStage(),
      new NixDetectStage(),
      new MountStage(),
      new LaunchStage(agentExtraArgs),
    ];

    await runPipeline(stages, ctx);
  } catch (err) {
    console.error(`[nas] Error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}

async function runRebuild(
  nasArgs: string[],
): Promise<void> {
  const force = nasArgs.includes("--force") || nasArgs.includes("-f");
  const profileName = nasArgs.find((a) => !a.startsWith("-"));
  try {
    const config = await loadConfig();
    const { name, profile } = resolveProfile(config, profileName);
    const ctx = createContext(config, profile, name, Deno.cwd());

    if (await dockerImageExists(ctx.imageName)) {
      console.log(`[nas] Removing Docker image "${ctx.imageName}"...`);
      await dockerRemoveImage(ctx.imageName, { force });
    } else {
      console.log(
        `[nas] Docker image "${ctx.imageName}" does not exist, skipping removal`,
      );
    }

    const stages = [
      new DockerBuildStage(),
    ];

    await runPipeline(stages, ctx);
  } catch (err) {
    console.error(`[nas] Error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}

async function runWorktreeCommand(
  nasArgs: string[],
): Promise<void> {
  const sub = nasArgs.find((a) => !a.startsWith("-"));
  const force = nasArgs.includes("--force") || nasArgs.includes("-f");
  const deleteBranch = nasArgs.includes("--delete-branch") ||
    nasArgs.includes("-B");

  try {
    if (sub === "list" || sub === undefined) {
      const entries = await listNasWorktrees(Deno.cwd());
      if (entries.length === 0) {
        console.log("[nas] No nas worktrees found.");
        return;
      }
      for (const e of entries) {
        const branch = e.branch
          ? e.branch.replace("refs/heads/", "")
          : "(detached)";
        console.log(`  ${e.path}  [${branch}]  ${e.head.slice(0, 8)}`);
      }
    } else if (sub === "clean") {
      const removed = await cleanNasWorktrees(Deno.cwd(), {
        force,
        deleteBranch,
      });
      console.log(`[nas] Removed ${removed} worktree(s).`);
    } else {
      console.error(`[nas] Unknown worktree subcommand: ${sub}`);
      console.error(
        "  Usage: nas worktree [list|clean] [--force] [--delete-branch]",
      );
      Deno.exit(1);
    }
  } catch (err) {
    console.error(`[nas] Error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}

function printUsage(): void {
  console.log(`nas - Nix Agent Sandbox

Usage:
  nas [profile-name] [options] [-- agent-args...]
  nas rebuild [profile-name] [options]
  nas worktree [list|clean] [options]

Subcommands:
  rebuild   Docker イメージを削除して再ビルドする
  worktree  git worktree の管理

Options:
  -h, --help      Show this help
  -V, --version   Show version

Rebuild options:
  -f, --force     Force remove Docker image (docker rmi --force)

Worktree options:
  list            nas が作成した worktree を一覧表示（デフォルト）
  clean           nas が作成した worktree をすべて削除
  -f, --force     確認なしで削除
  -B, --delete-branch  worktree 削除時にブランチも削除

Examples:
  nas                                    # Use default profile (interactive)
  nas copilot-nix                        # Use specific profile
  nas copilot-nix -- -p "list files"     # Pass args to the agent
  nas rebuild                            # Rebuild Docker image only
  nas rebuild --force                    # Force remove image and rebuild
  nas worktree list                      # List all nas worktrees
  nas worktree clean                     # Remove all nas worktrees
  nas worktree clean --force             # Remove without confirmation
  nas worktree clean --delete-branch     # Remove worktrees and their branches
  nas worktree clean -f -B              # Force remove worktrees and branches

Profile agent-args (in .agent-sandbox.yml):
  profiles:
    copilot-nix:
      agent: copilot
      agent-args:
        - "--yolo"
`);
}
