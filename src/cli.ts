/**
 * CLI エントリポイント
 */

import { loadConfig, resolveProfile } from "./config/load.ts";
import { createContext } from "./pipeline/context.ts";
import { runPipeline } from "./pipeline/pipeline.ts";
import { WorktreeStage } from "./stages/worktree.ts";
import { NixDetectStage } from "./stages/nix_detect.ts";
import { DbusProxyStage } from "./stages/dbus_proxy.ts";
import { MountStage } from "./stages/mount.ts";
import { HostExecStage } from "./stages/hostexec.ts";
import { DindStage } from "./stages/dind.ts";
import { ProxyStage } from "./stages/proxy.ts";
import { DockerBuildStage, LaunchStage } from "./stages/launch.ts";
import { setLogLevel } from "./log.ts";
import {
  applyWorktreeOverride,
  parseProfileAndWorktreeArgs,
} from "./cli/args.ts";
import {
  exitOnCliError,
  findFirstNonFlagArg,
  parseLogLevel,
  removeFirstOccurrence,
} from "./cli/helpers.ts";
import { printUsage } from "./cli/usage.ts";
import { runRebuild } from "./cli/rebuild.ts";
import { runWorktreeCommand } from "./cli/worktree.ts";
import { runContainerCommand } from "./cli/container.ts";
import { runNetworkCommand } from "./cli/network.ts";
import { runHostExecCommand } from "./cli/hostexec.ts";
import { runUiCommand } from "./cli/ui.ts";
import { ensureUiDaemon } from "./ui/daemon.ts";

const VERSION = "0.1.0";

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
    subcommand === "hostexec" || subcommand === "ui"
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

  if (subcommand === "ui") {
    await runUiCommand(
      removeFirstOccurrence(argsBeforeDashDash, "ui"),
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

    if (config.ui.enable) {
      await ensureUiDaemon({
        port: config.ui.port,
        idleTimeout: config.ui.idleTimeout,
      });
    }

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

export { applyWorktreeOverride, parseProfileAndWorktreeArgs };
