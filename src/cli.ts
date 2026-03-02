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

  // プロファイル名 (最初の非フラグ引数)
  const profileName = args.find((a) => !a.startsWith("-"));

  try {
    const config = await loadConfig();
    const { name, profile } = resolveProfile(config, profileName);
    const ctx = createContext(config, profile, name, Deno.cwd());

    const stages = [
      new WorktreeStage(),
      new DockerBuildStage(),
      new NixDetectStage(),
      new MountStage(),
      new LaunchStage(),
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
  naw [profile-name] [options]

Options:
  -h, --help      Show this help
  -V, --version   Show version

Examples:
  naw              # Use default profile
  naw claude-nix   # Use specific profile
`);
}
