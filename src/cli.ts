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
import { DbusProxyStage } from "./stages/dbus_proxy.ts";
import { MountStage } from "./stages/mount.ts";
import { HostExecStage } from "./stages/hostexec.ts";
import { DindStage } from "./stages/dind.ts";
import { ProxyStage } from "./stages/proxy.ts";
import { DockerBuildStage, LaunchStage } from "./stages/launch.ts";
import {
  dockerImageExists,
  dockerRemoveImage,
  InterruptedCommandError,
} from "./docker/client.ts";
import { cleanNasContainers } from "./container_clean.ts";
import { sendBrokerRequest } from "./network/broker.ts";
import { serveAuthRouter } from "./network/envoy_auth_router.ts";
import {
  gcNetworkRuntime,
  listPendingEntries,
  readSessionRegistry,
  resolveNetworkRuntimePaths,
} from "./network/registry.ts";
import type { ApprovalScope } from "./network/protocol.ts";
import { sendHostExecBrokerRequest } from "./hostexec/broker.ts";
import { buildArgsString, matchRule } from "./hostexec/match.ts";
import {
  listHostExecPendingEntries,
  readHostExecSessionRegistry,
  resolveHostExecRuntimePaths,
} from "./hostexec/registry.ts";
import { logInfo, type LogLevel, setLogLevel } from "./log.ts";
import { runFzfReview } from "./fzf_review.ts";
import type { ReviewItem } from "./fzf_review.ts";

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
  const logLevel = parseLogLevel(argsBeforeDashDash);
  setLogLevel(logLevel);

  // サブコマンド処理
  const subcommand = findFirstNonFlagArg(argsBeforeDashDash);

  if (
    subcommand === "rebuild" || subcommand === "worktree" ||
    subcommand === "container" || subcommand === "network" ||
    subcommand === "hostexec"
  ) {
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
      removeFirstOccurrence(argsBeforeDashDash, "worktree"),
    );
    return;
  }

  if (subcommand === "container") {
    await runContainerCommand(
      removeFirstOccurrence(argsBeforeDashDash, "container"),
    );
    return;
  }

  if (subcommand === "network") {
    await runNetworkCommand(
      removeFirstOccurrence(argsBeforeDashDash, "network"),
    );
    return;
  }

  if (subcommand === "hostexec") {
    await runHostExecCommand(
      removeFirstOccurrence(args, "hostexec"),
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
    const ctx = createContext(
      config,
      effectiveProfile,
      name,
      Deno.cwd(),
      logLevel,
    );

    const stages = [
      new WorktreeStage(),
      new DockerBuildStage(),
      new NixDetectStage(),
      new DbusProxyStage(),
      new MountStage(),
      new HostExecStage(),
      new DindStage(),
      new ProxyStage(),
      new LaunchStage(agentExtraArgs),
    ];

    await runPipeline(stages, ctx);
  } catch (err) {
    exitOnCliError(err);
  }
}

async function runRebuild(
  nasArgs: string[],
): Promise<void> {
  const force = nasArgs.includes("--force") || nasArgs.includes("-f");
  const profileName = nasArgs.find((a) => !a.startsWith("-"));
  const logLevel = parseLogLevel(nasArgs);
  try {
    const config = await loadConfig();
    const { name, profile } = resolveProfile(config, profileName);
    const ctx = createContext(config, profile, name, Deno.cwd(), logLevel);

    if (await dockerImageExists(ctx.imageName)) {
      logInfo(`[nas] Removing Docker image "${ctx.imageName}"...`);
      await dockerRemoveImage(ctx.imageName, { force });
    } else {
      logInfo(
        `[nas] Docker image "${ctx.imageName}" does not exist, skipping removal`,
      );
    }

    const stages = [
      new DockerBuildStage(),
    ];

    await runPipeline(stages, ctx);
  } catch (err) {
    exitOnCliError(err);
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
    exitOnCliError(err);
  }
}

async function runContainerCommand(
  nasArgs: string[],
): Promise<void> {
  const sub = nasArgs.find((a) => !a.startsWith("-"));

  try {
    if (sub === "clean") {
      const result = await cleanNasContainers();
      const parts: string[] = [];
      if (result.removedContainers.length > 0) {
        parts.push(`${result.removedContainers.length} container(s)`);
      }
      if (result.removedNetworks.length > 0) {
        parts.push(`${result.removedNetworks.length} network(s)`);
      }
      if (result.removedVolumes.length > 0) {
        parts.push(`${result.removedVolumes.length} volume(s)`);
      }
      if (parts.length === 0) {
        console.log("[nas] No unused nas sidecars found.");
        return;
      }
      console.log(`[nas] Removed ${parts.join(", ")}.`);
      if (result.removedContainers.length > 0) {
        console.log(`[nas] Sidecars: ${result.removedContainers.join(", ")}`);
      }
      if (result.removedNetworks.length > 0) {
        console.log(`[nas] Networks: ${result.removedNetworks.join(", ")}`);
      }
      if (result.removedVolumes.length > 0) {
        console.log(`[nas] Volumes: ${result.removedVolumes.join(", ")}`);
      }
      return;
    }

    console.error(`[nas] Unknown container subcommand: ${sub}`);
    console.error("  Usage: nas container clean");
    Deno.exit(1);
  } catch (err) {
    exitOnCliError(err);
  }
}

async function runNetworkCommand(
  nasArgs: string[],
): Promise<void> {
  const sub = nasArgs.find((arg) => !arg.startsWith("-"));
  const runtimeDir = getFlagValue(nasArgs, "--runtime-dir");

  try {
    const paths = await resolveNetworkRuntimePaths(runtimeDir ?? undefined);
    if (sub === "serve-auth-router") {
      await serveAuthRouter(paths.runtimeDir);
      return;
    }

    if (sub === "pending" || sub === undefined) {
      await gcNetworkRuntime(paths);
      const items = await listPendingEntries(paths);
      if (items.length === 0) {
        console.log("[nas] No pending network approvals.");
        return;
      }
      for (const item of items) {
        const target = `${item.target.host}:${item.target.port}`;
        console.log(
          `${item.sessionId} ${item.requestId} ${target} ${item.state} ${item.createdAt}`,
        );
      }
      return;
    }

    if (sub === "approve") {
      const [sessionId, requestId] = positionalArgsAfterSubcommand(
        nasArgs,
        sub,
      );
      const scope = (getFlagValue(nasArgs, "--scope") ?? undefined) as
        | ApprovalScope
        | undefined;
      await sendDecision(paths, sessionId, requestId, {
        type: "approve",
        requestId,
        scope,
      });
      console.log(`[nas] Approved ${sessionId} ${requestId}`);
      return;
    }

    if (sub === "deny") {
      const [sessionId, requestId] = positionalArgsAfterSubcommand(
        nasArgs,
        sub,
      );
      await sendDecision(paths, sessionId, requestId, {
        type: "deny",
        requestId,
      });
      console.log(`[nas] Denied ${sessionId} ${requestId}`);
      return;
    }

    if (sub === "review") {
      await gcNetworkRuntime(paths);
      const items = await listPendingEntries(paths);
      if (items.length === 0) {
        console.log("[nas] No pending network approvals.");
        return;
      }
      const reviewItems: ReviewItem[] = items.map((item) => {
        const target = `${item.target.host}:${item.target.port}`;
        return {
          sessionId: item.sessionId,
          requestId: item.requestId,
          displayLine:
            `${item.sessionId} ${item.requestId} ${target} ${item.state} ${item.createdAt}`,
        };
      });
      const result = await runFzfReview(reviewItems, [
        "once",
        "host-port",
        "host",
      ]);
      if (!result) return;
      for (const selected of result.items) {
        const message = result.action === "approve"
          ? {
            type: "approve" as const,
            requestId: selected.requestId,
            scope: result.scope as ApprovalScope | undefined,
          }
          : { type: "deny" as const, requestId: selected.requestId };
        try {
          await sendDecision(
            paths,
            selected.sessionId,
            selected.requestId,
            message,
          );
          console.log(
            `[nas] ${
              result.action === "approve" ? "Approved" : "Denied"
            } ${selected.sessionId} ${selected.requestId}`,
          );
        } catch (err) {
          console.error(
            `[nas] Warning: failed to ${result.action} ${selected.sessionId} ${selected.requestId}: ${
              (err as Error).message
            }`,
          );
        }
      }
      return;
    }

    if (sub === "gc") {
      const result = await gcNetworkRuntime(paths);
      console.log(
        `[nas] GC removed ${result.removedSessions.length} session(s), ${result.removedPendingDirs.length} pending dir(s), ${result.removedBrokerSockets.length} broker socket(s).`,
      );
      return;
    }

    console.error(`[nas] Unknown network subcommand: ${sub}`);
    console.error(
      "  Usage: nas network [pending|approve|deny|review|gc] [--scope ...]",
    );
    Deno.exit(1);
  } catch (err) {
    exitOnCliError(err);
  }
}

async function runHostExecCommand(
  nasArgs: string[],
): Promise<void> {
  const sub = nasArgs.find((arg) => !arg.startsWith("-"));
  const runtimeDir = getFlagValue(nasArgs, "--runtime-dir");

  try {
    const paths = await resolveHostExecRuntimePaths(runtimeDir ?? undefined);
    if (sub === "pending" || sub === undefined) {
      const items = await listHostExecPendingEntries(paths);
      if (items.length === 0) {
        console.log("[nas] No pending hostexec approvals.");
        return;
      }
      for (const item of items) {
        const argv = [item.argv0, ...item.args].join(" ");
        console.log(
          `${item.sessionId} ${item.requestId} ${item.ruleId} ${item.cwd} ${argv}`,
        );
      }
      return;
    }

    if (sub === "approve") {
      const [sessionId, requestId] = positionalArgsAfterSubcommand(
        nasArgs,
        sub,
      );
      const scope = (getFlagValue(nasArgs, "--scope") ?? undefined) as
        | import("./config/types.ts").HostExecPromptScope
        | undefined;
      await sendHostExecDecision(paths, sessionId, requestId, {
        type: "approve",
        requestId,
        scope,
      });
      console.log(`[nas] Approved ${sessionId} ${requestId}`);
      return;
    }

    if (sub === "deny") {
      const [sessionId, requestId] = positionalArgsAfterSubcommand(
        nasArgs,
        sub,
      );
      await sendHostExecDecision(paths, sessionId, requestId, {
        type: "deny",
        requestId,
      });
      console.log(`[nas] Denied ${sessionId} ${requestId}`);
      return;
    }

    if (sub === "review") {
      const items = await listHostExecPendingEntries(paths);
      if (items.length === 0) {
        console.log("[nas] No pending hostexec approvals.");
        return;
      }
      const reviewItems: ReviewItem[] = items.map((item) => {
        const argv = [item.argv0, ...item.args].join(" ");
        return {
          sessionId: item.sessionId,
          requestId: item.requestId,
          displayLine:
            `${item.sessionId} ${item.requestId} ${item.ruleId} ${item.cwd} ${argv}`,
        };
      });
      const result = await runFzfReview(reviewItems, ["once", "capability"]);
      if (!result) return;
      for (const selected of result.items) {
        const message = result.action === "approve"
          ? {
            type: "approve" as const,
            requestId: selected.requestId,
            scope: result.scope as
              | import("./config/types.ts").HostExecPromptScope
              | undefined,
          }
          : { type: "deny" as const, requestId: selected.requestId };
        try {
          await sendHostExecDecision(
            paths,
            selected.sessionId,
            selected.requestId,
            message,
          );
          console.log(
            `[nas] ${
              result.action === "approve" ? "Approved" : "Denied"
            } ${selected.sessionId} ${selected.requestId}`,
          );
        } catch (err) {
          console.error(
            `[nas] Warning: failed to ${result.action} ${selected.sessionId} ${selected.requestId}: ${
              (err as Error).message
            }`,
          );
        }
      }
      return;
    }

    if (sub === "test") {
      await runHostExecTestCommand(removeFirstOccurrence(nasArgs, "test"));
      return;
    }

    console.error(`[nas] Unknown hostexec subcommand: ${sub}`);
    console.error(
      "  Usage: nas hostexec [pending|approve|deny|review|test] [--scope ...]",
    );
    Deno.exit(1);
  } catch (err) {
    console.error(`[nas] Error: ${(err as Error).message}`);
    Deno.exit(1);
  }
}

async function runHostExecTestCommand(
  nasArgs: string[],
): Promise<void> {
  const profileName = getFlagValue(nasArgs, "--profile");
  const dashDashIdx = nasArgs.indexOf("--");
  if (dashDashIdx === -1 || dashDashIdx + 1 >= nasArgs.length) {
    console.error(
      "[nas] Usage: nas hostexec test --profile <profile> -- <command> [args...]",
    );
    Deno.exit(1);
  }
  const commandArgs = nasArgs.slice(dashDashIdx + 1);
  const argv0 = commandArgs[0];
  const args = commandArgs.slice(1);

  const config = await loadConfig();
  const { profile } = resolveProfile(config, profileName ?? undefined);
  const hostexec = profile.hostexec;
  if (!hostexec) {
    console.error("[nas] No hostexec configuration found in profile.");
    Deno.exit(1);
  }

  const argsStr = buildArgsString(args);
  console.log(`args string: "${argsStr}"`);

  const result = matchRule(
    hostexec.rules,
    argv0,
    args,
  );

  if (result) {
    const envKeys = Object.keys(result.rule.env);
    const envPart = envKeys.length > 0 ? `, env: [${envKeys.join(", ")}]` : "";
    console.log(
      `Matched rule: ${result.rule.id} (approval: ${result.rule.approval}${envPart})`,
    );
  } else {
    console.log("No rule matched (fallback applies)");
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

function removeFirstOccurrence(args: string[], value: string): string[] {
  const index = args.indexOf(value);
  if (index === -1) return [...args];
  return [...args.slice(0, index), ...args.slice(index + 1)];
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

function parseLogLevel(args: string[]): LogLevel {
  return args.includes("--quiet") || args.includes("-q") ? "warn" : "info";
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
    if (arg === "--scope" || arg === "--runtime-dir") {
      i++;
      continue;
    }
    if (arg === "--quiet" || arg === "-q") continue;
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
  nas container clean
  nas network [pending|approve|deny|review|gc]

Subcommands:
  rebuild   Docker イメージを削除して再ビルドする
  worktree  git worktree の管理
  container sidecar container の管理
  network   network 承認キューと runtime の管理
  hostexec  hostexec 承認キューの管理

Options:
  -h, --help      Show this help
  -V, --version   Show version
  -q, --quiet     Suppress info logs
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

Container options:
  clean           未使用の nas sidecar container/network/volume を削除

Network options:
  pending         保留中の network 承認要求を表示
  approve         承認する
  deny            拒否する
  gc              stale runtime state を掃除する

HostExec options:
  pending         保留中の hostexec 承認要求を表示
  approve         承認する
  deny            拒否する
  test            ルールマッチングをテストする

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
  nas container clean                    # Remove unused nas sidecars
  nas network pending                    # Show pending approvals
  nas network approve <session> <request> --scope host-port
  nas hostexec pending                   # Show pending hostexec approvals
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

async function sendHostExecDecision(
  paths: Awaited<ReturnType<typeof resolveHostExecRuntimePaths>>,
  sessionId: string,
  _requestId: string,
  message:
    | {
      type: "approve";
      requestId: string;
      scope?: import("./config/types.ts").HostExecPromptScope;
    }
    | { type: "deny"; requestId: string },
): Promise<void> {
  const session = await readHostExecSessionRegistry(paths, sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  await sendHostExecBrokerRequest(session.brokerSocket, message);
}

export { applyWorktreeOverride, parseProfileAndWorktreeArgs };

function exitOnCliError(err: unknown): never {
  if (err instanceof InterruptedCommandError) {
    Deno.exit(err.exitCode);
  }
  console.error(`[nas] Error: ${(err as Error).message}`);
  Deno.exit(1);
}

async function sendDecision(
  paths: Awaited<ReturnType<typeof resolveNetworkRuntimePaths>>,
  sessionId: string,
  _requestId: string,
  message: { type: "approve"; requestId: string; scope?: ApprovalScope } | {
    type: "deny";
    requestId: string;
  },
): Promise<void> {
  await gcNetworkRuntime(paths);
  const session = await readSessionRegistry(paths, sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  await sendBrokerRequest(session.brokerSocket, message);
}

function getFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function positionalArgsAfterSubcommand(
  args: string[],
  subcommand: string,
): [string, string] {
  const positional = args.filter((arg, index) => {
    if (arg.startsWith("-")) return false;
    if (arg === subcommand) return false;
    if (
      index > 0 &&
      (args[index - 1] === "--scope" || args[index - 1] === "--runtime-dir")
    ) {
      return false;
    }
    return true;
  });
  if (positional.length < 2) {
    throw new Error(`${subcommand} requires <session-id> <request-id>`);
  }
  return [positional[0], positional[1]];
}
