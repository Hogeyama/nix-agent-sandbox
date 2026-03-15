/**
 * CLI エントリポイント
 */

import { loadConfig, resolveProfile } from "./config/load.ts";
import type { Profile } from "./config/types.ts";
import { createContext } from "./pipeline/context.ts";
import { runPipeline } from "./pipeline/pipeline.ts";
import { WorktreeStage } from "./stages/worktree.ts";
import { cleanNasWorktrees, listNasWorktrees } from "./stages/worktree.ts";
import { NixDetectStage } from "./stages/nix_detect.ts";
import { MountStage } from "./stages/mount.ts";
import { DindStage } from "./stages/dind.ts";
import { ProxyStage } from "./stages/proxy.ts";
import { DockerBuildStage, LaunchStage } from "./stages/launch.ts";
import { dockerImageExists, dockerRemoveImage } from "./docker/client.ts";

const VERSION = "0.1.0";

type WorktreeOverride =
  | { type: "none" }
  | { type: "enable"; base: string }
  | { type: "disable" };

interface ParsedMainArgs {
  profileName?: string;
  profileIndex?: number;
  worktreeOverride: WorktreeOverride;
  agentArgs: string[];
}

export async function main(args: string[]): Promise<void> {
  // `--` 以降は常にエージェントに渡す引数。profile 名の後ろも同様に agent 引数として扱う。
  const dashDashIdx = args.indexOf("--");
  const argsBeforeDashDash = dashDashIdx >= 0
    ? args.slice(0, dashDashIdx)
    : args;
  const explicitAgentArgs = dashDashIdx >= 0 ? args.slice(dashDashIdx + 1) : [];

  // サブコマンド処理
  const subcommand = findFirstNonFlagArg(argsBeforeDashDash);

  if (subcommand === "rebuild" || subcommand === "worktree") {
    if (
      argsBeforeDashDash.includes("--help") || argsBeforeDashDash.includes("-h")
    ) {
      printUsage();
      return;
    }
    if (
      argsBeforeDashDash.includes("--version") ||
      argsBeforeDashDash.includes("-V")
    ) {
      console.log(`nas ${VERSION}`);
      return;
    }
  }

  if (subcommand === "rebuild") {
    await runRebuild(argsBeforeDashDash.filter((a) => a !== "rebuild"));
    return;
  }

  if (subcommand === "worktree") {
    await runWorktreeCommand(
      argsBeforeDashDash.filter((a) => a !== "worktree"),
    );
    return;
  }

  const {
    profileName,
    profileIndex,
    worktreeOverride,
    agentArgs,
  } = parseProfileAndWorktreeArgs(
    argsBeforeDashDash,
  );
  const nasControlArgs = profileIndex === undefined
    ? argsBeforeDashDash
    : argsBeforeDashDash.slice(0, profileIndex);
  const agentExtraArgs = [...agentArgs, ...explicitAgentArgs];

  if (nasControlArgs.includes("--help") || nasControlArgs.includes("-h")) {
    printUsage();
    return;
  }
  if (nasControlArgs.includes("--version") || nasControlArgs.includes("-V")) {
    console.log(`nas ${VERSION}`);
    return;
  }

  try {
    const config = await loadConfig();
    const { name, profile } = resolveProfile(config, profileName);
    const effectiveProfile = applyWorktreeOverride(profile, worktreeOverride);
    const ctx = createContext(config, effectiveProfile, name, Deno.cwd());

    const stages = [
      new WorktreeStage(),
      new DockerBuildStage(),
      new NixDetectStage(),
      new MountStage(),
      new DindStage(),
      new ProxyStage(),
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
      const result = await cleanNasWorktrees(Deno.cwd(), {
        force,
        deleteBranch,
      });
      const parts: string[] = [];
      if (result.worktrees > 0) {
        parts.push(`${result.worktrees} worktree(s)`);
      }
      if (result.orphanBranches > 0) {
        parts.push(`${result.orphanBranches} orphan branch(es)`);
      }
      if (parts.length > 0) {
        console.log(`[nas] Removed ${parts.join(", ")}.`);
      }
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

function parseProfileAndWorktreeArgs(nasArgs: string[]): ParsedMainArgs {
  let profileName: string | undefined;
  let profileIndex: number | undefined;
  let worktreeOverride: WorktreeOverride = { type: "none" };
  const agentArgs: string[] = [];

  for (let i = 0; i < nasArgs.length; i++) {
    const arg = nasArgs[i];
    if (profileName !== undefined) {
      agentArgs.push(arg);
      continue;
    }
    if (arg === "--worktree" || arg === "-b") {
      const branch = nasArgs[i + 1];
      if (!branch || branch.startsWith("-")) {
        throw new Error("--worktree/-b requires a branch name.");
      }
      i++;
      worktreeOverride = {
        type: "enable",
        base: normalizeWorktreeBase(branch),
      };
      continue;
    }
    if (arg.startsWith("-b") && arg.length > 2) {
      const branch = arg.slice(2);
      if (branch.startsWith("-")) {
        throw new Error("--worktree/-b requires a branch name.");
      }
      worktreeOverride = {
        type: "enable",
        base: normalizeWorktreeBase(branch),
      };
      continue;
    }
    if (arg === "--no-worktree") {
      worktreeOverride = { type: "disable" };
      continue;
    }
    if (!arg.startsWith("-") && profileName === undefined) {
      profileName = arg;
      profileIndex = i;
    }
  }

  return { profileName, profileIndex, worktreeOverride, agentArgs };
}

function applyWorktreeOverride(
  profile: Profile,
  override: WorktreeOverride,
): Profile {
  if (override.type === "none") return profile;
  if (override.type === "disable") {
    return { ...profile, worktree: undefined };
  }
  const onCreate = profile.worktree?.onCreate ?? "";
  return { ...profile, worktree: { base: override.base, onCreate } };
}

function normalizeWorktreeBase(branch: string): string {
  if (branch === "@" || branch === "HEAD") return "HEAD";
  return branch;
}

function findFirstNonFlagArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--worktree" || arg === "-b") {
      i++;
      continue;
    }
    if (arg.startsWith("-b") && arg.length > 2) continue;
    if (arg === "--no-worktree") continue;
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

function printUsage(): void {
  console.log(`nas - Nix Agent Sandbox

Usage:
  nas [options-before-profile] [profile-name] [agent-args...]
  nas rebuild [profile-name] [options]
  nas worktree [list|clean] [options]

Subcommands:
  rebuild   Docker イメージを削除して再ビルドする
  worktree  git worktree の管理

Options:
  -h, --help      Show this help
  -V, --version   Show version
  -b, --worktree <branch>  Enable worktree and set base branch (use @ or HEAD for current HEAD)
  --no-worktree   Disable worktree even if configured in profile

Main command notes:
  - nas options must appear before [profile-name]
  - args after [profile-name] are passed to the agent
  - if [profile-name] is omitted, use -- before agent args

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
  nas copilot-nix -p "list files"        # Pass args after profile to the agent
  nas copilot-nix --resume=session-id    # Copilot CLI resume without --
  nas -- -p "list files"                 # Pass args to the default profile
  nas rebuild                            # Rebuild Docker image only
  nas rebuild --force                    # Force remove image and rebuild
  nas worktree list                      # List all nas worktrees
  nas worktree clean                     # Remove all nas worktrees
  nas worktree clean --force             # Remove without confirmation
  nas worktree clean --delete-branch     # Remove worktrees and their branches
  nas worktree clean -f -B              # Force remove worktrees and branches
  nas my-profile -b feature/login       # Create worktree from feature/login
  nas --worktree @                      # Use default profile, base current HEAD

Profile agent-args (in .agent-sandbox.yml):
  profiles:
    copilot-nix:
      agent: copilot
      agent-args:
        - "--yolo"
    codex-nix:
      agent: codex
      agent-args:
        - "--model"
        - "gpt-5-codex"
`);
}

export { applyWorktreeOverride, parseProfileAndWorktreeArgs };
