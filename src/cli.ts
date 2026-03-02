/**
 * CLI エントリポイント
 */

import { loadConfig, resolveProfile } from "./config/load.ts";
import { createContext } from "./pipeline/context.ts";
import { runPipeline } from "./pipeline/pipeline.ts";
import { WorktreeStage } from "./stages/worktree.ts";
import { NixDetectStage } from "./stages/nix_detect.ts";
import { MountStage } from "./stages/mount.ts";
import { DockerBuildStage, LaunchStage } from "./stages/launch.ts";
import { dockerImageExists, dockerRemoveImage } from "./docker/client.ts";

const VERSION = "0.1.0";

export async function main(args: string[]): Promise<void> {
  // `--` 以降はエージェントに渡す引数
  const dashDashIdx = args.indexOf("--");
  const nawArgs = dashDashIdx >= 0 ? args.slice(0, dashDashIdx) : args;
  const agentExtraArgs = dashDashIdx >= 0 ? args.slice(dashDashIdx + 1) : [];

  // フラグ処理 (naw 自身の引数のみ)
  if (nawArgs.includes("--help") || nawArgs.includes("-h")) {
    printUsage();
    return;
  }
  if (nawArgs.includes("--version") || nawArgs.includes("-V")) {
    console.log(`naw ${VERSION}`);
    return;
  }

  // サブコマンド処理
  const subcommand = nawArgs.find((a) => !a.startsWith("-"));

  if (subcommand === "rebuild") {
    await runRebuild(nawArgs.filter((a) => a !== "rebuild"), agentExtraArgs);
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
    console.error(`[naw] Error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}

async function runRebuild(nawArgs: string[], agentExtraArgs: string[]): Promise<void> {
  const profileName = nawArgs.find((a) => !a.startsWith("-"));
  try {
    const config = await loadConfig();
    const { name, profile } = resolveProfile(config, profileName);
    const ctx = createContext(config, profile, name, Deno.cwd());

    if (await dockerImageExists(ctx.imageName)) {
      console.log(`[naw] Removing Docker image "${ctx.imageName}"...`);
      await dockerRemoveImage(ctx.imageName);
    } else {
      console.log(`[naw] Docker image "${ctx.imageName}" does not exist, skipping removal`);
    }

    const stages = [
      new WorktreeStage(),
      new DockerBuildStage(),
      new NixDetectStage(),
      new MountStage(),
      new LaunchStage(agentExtraArgs),
    ];

    await runPipeline(stages, ctx);
  } catch (err) {
    console.error(`[naw] Error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}

function printUsage(): void {
  console.log(`naw - Nix Agent Workspace

Usage:
  naw [profile-name] [options] [-- agent-args...]
  naw rebuild [profile-name] [options] [-- agent-args...]

Subcommands:
  rebuild   Docker イメージを削除して再ビルドしてから起動する

Options:
  -h, --help      Show this help
  -V, --version   Show version

Examples:
  naw                                    # Use default profile (interactive)
  naw copilot-nix                        # Use specific profile
  naw copilot-nix -- -p "list files"     # Pass args to the agent
  naw rebuild                            # Rebuild Docker image and launch
  naw rebuild copilot-nix               # Rebuild with specific profile
`);
}
