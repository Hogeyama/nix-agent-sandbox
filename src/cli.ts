/**
 * CLI エントリポイント
 */

import { loadConfig, resolveProfile } from "./config/load.ts";
import { createContext } from "./pipeline/context.ts";
import { runPipelineV2 } from "./pipeline/pipeline.ts";
import { adaptLegacyStage } from "./pipeline/adapt.ts";
import { buildHostEnv, resolveProbes } from "./pipeline/host_env.ts";
import type { PriorStageOutputs } from "./pipeline/types.ts";
import { WorktreeStage } from "./stages/worktree.ts";
import { NixDetectStage } from "./stages/nix_detect.ts";
import { DbusProxyStage } from "./stages/dbus_proxy.ts";
import { MountStage } from "./stages/mount.ts";
import { HostExecStage } from "./stages/hostexec.ts";
import { DindStage } from "./stages/dind.ts";
import { ProxyStage } from "./stages/proxy.ts";
import { DockerBuildStage, LaunchStage } from "./stages/launch.ts";
import { setLogLevel } from "./log.ts";
import { checkNotifySend, resolveNotifyBackend } from "./lib/notify_utils.ts";
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
import { runAuditCommand } from "./cli/audit.ts";
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
    subcommand === "hostexec" || subcommand === "ui" ||
    subcommand === "audit"
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

  if (subcommand === "audit") {
    await runAuditCommand(
      removeFirstOccurrence(argsBeforeDashDash, "audit"),
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

    // HostEnv 構築と probe 解決
    // NOTE: Probe failures (e.g. PermissionDenied on /nix stat) will
    // propagate and abort the pipeline. This matches legacy stage behavior
    // where the same I/O happens inside each stage's execute().
    // NOTE: During migration, probes are passed to StageInput but legacy
    // stages (via adaptLegacyStage) ignore them. The probes will be consumed
    // once stages are migrated to PlanStage.
    const hostEnv = buildHostEnv();
    const probes = await resolveProbes(hostEnv);

    // notify-send の存在チェック（必要な場合のみ）
    {
      const networkNotify = resolveNotifyBackend(
        effectiveProfile.network.prompt.notify,
        hostEnv.isWSL,
      );
      const hostexecNotify = resolveNotifyBackend(
        effectiveProfile.hostexec?.prompt.notify ?? "auto",
        hostEnv.isWSL,
      );
      if (
        networkNotify === "desktop" ||
        hostexecNotify === "desktop"
      ) {
        checkNotifySend();
      }
    }

    if (config.ui.enable) {
      await ensureUiDaemon({
        port: config.ui.port,
        idleTimeout: config.ui.idleTimeout,
      });
    }

    const legacyStages = [
      new WorktreeStage(),
      new DockerBuildStage(),
      // NixDetectStage is a PlanStage — added directly below
      new DbusProxyStage(),
      new MountStage(),
      new HostExecStage(),
      new DindStage(),
      new ProxyStage(),
      new LaunchStage(agentExtraArgs),
    ];

    // Legacy stage を adaptLegacyStage でラップし、PlanStage を直接挿入
    const adapted = legacyStages.map((s) => adaptLegacyStage(s, ctx));
    // NixDetectStage を DockerBuildStage の後に挿入 (index 2)
    const stages = [
      ...adapted.slice(0, 2),
      NixDetectStage,
      ...adapted.slice(2),
    ];

    // 初期 PriorStageOutputs を構築
    const initialPrior: PriorStageOutputs = {
      dockerArgs: ctx.dockerArgs,
      envVars: ctx.envVars,
      workDir: ctx.workDir,
      mountDir: ctx.mountDir,
      nixEnabled: ctx.nixEnabled,
      imageName: ctx.imageName,
      agentCommand: ctx.agentCommand,
      networkPromptToken: ctx.networkPromptToken,
      networkPromptEnabled: ctx.networkPromptEnabled,
      dbusProxyEnabled: ctx.dbusProxyEnabled,
    };

    await runPipelineV2(stages, {
      config,
      profile: effectiveProfile,
      profileName: name,
      sessionId: ctx.sessionId,
      host: hostEnv,
      probes,
      prior: initialPrior,
    });
  } catch (err) {
    exitOnCliError(err);
  }
}

export { applyWorktreeOverride, parseProfileAndWorktreeArgs };
