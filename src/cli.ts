/**
 * CLI エントリポイント
 */

import { Cause, Effect, Exit, Layer } from "effect";
import pkg from "../package.json";
import {
  applyWorktreeOverride,
  parseProfileAndWorktreeArgs,
} from "./cli/args.ts";
import { runAuditCommand } from "./cli/audit.ts";
import { runContainerCommand } from "./cli/container.ts";
import {
  exitOnCliError,
  findFirstNonFlagArg,
  parseLogLevel,
  removeFirstOccurrence,
} from "./cli/helpers.ts";
import { runHookCommand } from "./cli/hook.ts";
import { runHostExecCommand } from "./cli/hostexec.ts";
import { runNetworkCommand } from "./cli/network.ts";
import { runRebuild } from "./cli/rebuild.ts";
import { runSessionCommand } from "./cli/session.ts";
import { runUiCommand } from "./cli/ui.ts";
import { printUsage } from "./cli/usage.ts";
import { runWorktreeCommand } from "./cli/worktree.ts";
import { loadConfig, resolveProfile } from "./config/load.ts";
import {
  dtachIsAvailable,
  gcDtachRuntime,
  socketPathFor,
} from "./dtach/client.ts";
import { checkNotifySend, resolveNotifyBackend } from "./lib/notify_utils.ts";
import { setLogLevel } from "./log.ts";
import { buildHostEnv, resolveProbes } from "./pipeline/host_env.ts";
import { runPipelineEffect } from "./pipeline/pipeline.ts";
import type { PriorStageOutputs } from "./pipeline/types.ts";
import { AuthRouterServiceLive } from "./services/auth_router.ts";
import { DindServiceLive } from "./services/dind.ts";
import { DockerServiceLive } from "./services/docker.ts";
import { EnvoyServiceLive } from "./services/envoy.ts";
import { FsServiceLive } from "./services/fs.ts";
import { GitWorktreeServiceLive } from "./services/git_worktree.ts";
import { HostExecBrokerServiceLive } from "./services/hostexec_broker.ts";
import { NetworkRuntimeServiceLive } from "./services/network_runtime.ts";
import { ProcessServiceLive } from "./services/process.ts";
import { SessionBrokerServiceLive } from "./services/session_broker.ts";
import { SessionStoreServiceLive } from "./services/session_store_service.ts";
import { createDbusProxyStage } from "./stages/dbus_proxy.ts";
import { createDindStage } from "./stages/dind.ts";
import {
  createDockerBuildStage,
  resolveBuildProbes,
} from "./stages/docker_build.ts";
import { createHostExecStage } from "./stages/hostexec.ts";
import { createLaunchStage } from "./stages/launch.ts";
import { createMountStage, resolveMountProbes } from "./stages/mount.ts";
import { NixDetectStage } from "./stages/nix_detect.ts";
import { createProxyStage } from "./stages/proxy.ts";
import { createSessionStoreStage } from "./stages/session_store.ts";
import { PromptServiceLive } from "./stages/worktree/prompt_service.ts";
import { createWorktreeStage } from "./stages/worktree.ts";
import { ensureUiDaemon } from "./ui/daemon.ts";

const VERSION: string = pkg.version;

export async function main(args: string[]): Promise<void> {
  // `--` 以降は常にエージェントに渡す引数。profile 名の後ろも同様に agent 引数として扱う。
  const dashDashIdx = args.indexOf("--");
  const argsBeforeDashDash =
    dashDashIdx >= 0 ? args.slice(0, dashDashIdx) : args;
  const explicitAgentArgs = dashDashIdx >= 0 ? args.slice(dashDashIdx + 1) : [];
  const logLevel = parseLogLevel(argsBeforeDashDash);
  setLogLevel(logLevel);

  // サブコマンド処理
  const subcommand = findFirstNonFlagArg(argsBeforeDashDash);

  if (
    subcommand === "rebuild" ||
    subcommand === "worktree" ||
    subcommand === "container" ||
    subcommand === "session" ||
    subcommand === "network" ||
    subcommand === "hostexec" ||
    subcommand === "ui" ||
    subcommand === "audit" ||
    subcommand === "hook"
  ) {
    if (
      argsBeforeDashDash.includes("--help") ||
      argsBeforeDashDash.includes("-h")
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

  if (subcommand === "session") {
    await runSessionCommand(
      removeFirstOccurrence(argsBeforeDashDash, "session"),
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
    await runHostExecCommand(removeFirstOccurrence(args, "hostexec"));
    return;
  }

  if (subcommand === "ui") {
    await runUiCommand(removeFirstOccurrence(argsBeforeDashDash, "ui"));
    return;
  }

  if (subcommand === "audit") {
    await runAuditCommand(removeFirstOccurrence(argsBeforeDashDash, "audit"));
    return;
  }

  if (subcommand === "hook") {
    await runHookCommand(removeFirstOccurrence(argsBeforeDashDash, "hook"));
    return;
  }

  const {
    profileName,
    profileIndex,
    sessionName,
    worktreeOverride,
    agentArgs,
  } = parseProfileAndWorktreeArgs(argsBeforeDashDash);
  const nasControlArgs =
    profileIndex === undefined
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
    const sessionId = process.env.NAS_SESSION_ID || `sess_${randomHex(6)}`;

    // session.enable かつ dtach 内でなければ、nas 自体を dtach でラップして再実行
    if (effectiveProfile.session.enable && !process.env.NAS_INSIDE_DTACH) {
      await runInsideDtach(sessionId, effectiveProfile.session.detachKey, args);
      return;
    }

    const imageName = "nas-sandbox";
    const proxyEnabled =
      effectiveProfile.network.allowlist.length > 0 ||
      effectiveProfile.network.prompt.enable;

    // HostEnv 構築と probe 解決
    // NOTE: Probe failures (e.g. PermissionDenied on /nix stat) will
    // propagate and abort the pipeline. This matches legacy stage behavior
    // where the same I/O happens inside each stage's execute().
    // NOTE: Probes are passed to StageInput and consumed by stages.
    const hostEnv = buildHostEnv();
    const probes = await resolveProbes(hostEnv);

    // notify-send の存在チェック（必要な場合のみ）
    {
      const networkNotify = resolveNotifyBackend(
        effectiveProfile.network.prompt.notify,
      );
      const hostexecNotify = resolveNotifyBackend(
        effectiveProfile.hostexec?.prompt.notify ?? "auto",
      );
      if (networkNotify === "desktop" || hostexecNotify === "desktop") {
        checkNotifySend();
      }
    }

    if (config.ui.enable) {
      await ensureUiDaemon({
        port: config.ui.port,
        idleTimeout: config.ui.idleTimeout,
      });
    }

    // MountProbes を事前解決
    const mountProbes = await resolveMountProbes(
      hostEnv,
      effectiveProfile,
      process.cwd(),
      probes.gpgAgentSocket,
    );

    // BuildProbes を事前解決
    const buildProbes = await resolveBuildProbes(imageName);

    const primitiveLayer = Layer.mergeAll(FsServiceLive, ProcessServiceLive);
    const dockerLayer = DockerServiceLive;
    const liveLayer = Layer.mergeAll(
      AuthRouterServiceLive,
      DindServiceLive,
      EnvoyServiceLive.pipe(Layer.provide(dockerLayer)),
      FsServiceLive,
      GitWorktreeServiceLive.pipe(Layer.provide(primitiveLayer)),
      HostExecBrokerServiceLive,
      NetworkRuntimeServiceLive.pipe(Layer.provide(primitiveLayer)),
      ProcessServiceLive,
      DockerServiceLive,
      PromptServiceLive,
      SessionBrokerServiceLive,
      SessionStoreServiceLive,
    );

    const stages = [
      createWorktreeStage(),
      createSessionStoreStage(),
      createDockerBuildStage(buildProbes),
      NixDetectStage,
      createDbusProxyStage(),
      createMountStage(mountProbes),
      createHostExecStage(),
      createDindStage(),
      createProxyStage(),
      createLaunchStage(agentExtraArgs),
    ] as const;

    // HostExec broker が nas hook を実行する際に参照する
    process.env.NAS_SESSION_ID = sessionId;

    // 初期 PriorStageOutputs ���構築
    const initialPrior: PriorStageOutputs = {
      dockerArgs: [],
      envVars: {
        NAS_LOG_LEVEL: logLevel,
        NAS_SESSION_ID: sessionId,
      },
      workDir: process.cwd(),
      nixEnabled: false,
      imageName,
      agentCommand: [],
      networkPromptToken: proxyEnabled ? randomHex(32) : undefined,
      networkPromptEnabled: effectiveProfile.network.prompt.enable,
      dbusProxyEnabled: effectiveProfile.dbus.session.enable,
    };

    const exit = await Effect.runPromiseExit(
      runPipelineEffect(stages, {
        config,
        profile: effectiveProfile,
        profileName: name,
        sessionId,
        sessionName,
        host: hostEnv,
        probes,
        prior: initialPrior,
      }).pipe(Effect.scoped, Effect.provide(liveLayer)),
    );

    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      exitOnCliError(error);
    }
  } catch (err) {
    exitOnCliError(err);
  }
}

export { applyWorktreeOverride, parseProfileAndWorktreeArgs };

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(data).toString("hex");
}

/**
 * nas プロセス全体を dtach 内で再実行する。
 * dtach -c でソケットを作成し、中で NAS_INSIDE_DTACH=1 付きで nas を起動。
 * デタッチすると dtach -c が戻り、この関数も戻る（中の nas は生き続ける）。
 */
async function runInsideDtach(
  sessionId: string,
  detachKey: string,
  originalArgs: string[],
): Promise<void> {
  if (!(await dtachIsAvailable())) {
    throw new Error(
      "dtach is required for session.enable but was not found. Install dtach or disable session.enable.",
    );
  }

  await gcDtachRuntime();
  const socketPath = socketPathFor(sessionId);

  // ソケットディレクトリを作成
  const dir = await import("node:path").then((p) => p.dirname(socketPath));
  await Bun.spawn(["mkdir", "-p", dir], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;

  // dtach -c <socket> -e <key> -z <nas ...>
  // NAS_INSIDE_DTACH=1 を渡して再帰を防止
  // process.execPath で実際のバイナリパスを使う（Bun コンパイル済みだと
  // process.argv[0] が仮想パス /$bunfs/... になるため）。
  // originalArgs は main() に渡されたユーザー引数のみ。
  const nasCommand = [process.execPath, ...originalArgs];
  const dtachArgs = ["-c", socketPath, "-e", detachKey, "-z", ...nasCommand];

  console.log(
    `[nas] Starting dtach session: ${sessionId} (detach: ${detachKey})`,
  );

  const proc = Bun.spawn(["dtach", ...dtachArgs], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      NAS_INSIDE_DTACH: "1",
      NAS_SESSION_ID: sessionId,
    },
  });
  await proc.exited;

  console.log(`[nas] Detached. Reattach with: nas session attach ${sessionId}`);
}
