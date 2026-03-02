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

const VERSION = "0.1.0";

export async function main(args: string[]): Promise<void> {
  // フラグ処理
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }
  if (args.includes("--version") || args.includes("-V")) {
    console.log(`naw ${VERSION}`);
    return;
  }

  // `--` 以降はエージェントに渡す引数
  const dashDashIdx = args.indexOf("--");
  const nawArgs = dashDashIdx >= 0 ? args.slice(0, dashDashIdx) : args;
  const agentExtraArgs = dashDashIdx >= 0 ? args.slice(dashDashIdx + 1) : [];

  // プロファイル名 (最初の非フラグ引数)
  const profileName = nawArgs.find((a) => !a.startsWith("-"));

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

function printUsage(): void {
  console.log(`naw - Nix Agent Workspace

Usage:
  naw [profile-name] [options] [-- agent-args...]

Options:
  -h, --help      Show this help
  -V, --version   Show version

Examples:
  naw                                    # Use default profile (interactive)
  naw copilot-nix                        # Use specific profile
  naw copilot-nix -- -p "list files"     # Pass args to the agent
`);
}
