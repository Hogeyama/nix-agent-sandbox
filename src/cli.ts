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
import { runConfigCommand } from "./cli/config.ts";
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
import { createCliInitialState } from "./cli/pipeline_state.ts";
import { runRebuild } from "./cli/rebuild.ts";
import { runSessionCommand } from "./cli/session.ts";
import { runUiCommand } from "./cli/ui.ts";
import { printUsage } from "./cli/usage.ts";
import { runWorktreeCommand } from "./cli/worktree.ts";
import { loadConfig, resolveProfile } from "./config/load.ts";
import {
  dtachAttach,
  dtachIsAvailable,
  dtachNewSession,
  gcDtachRuntime,
  shellEscape,
  socketPathFor,
} from "./dtach/client.ts";
import {
  recordInvocationEnd,
  recordInvocationStart,
  shouldRecordInvocation,
} from "./history/cli_lifecycle.ts";
import { checkNotifySend, resolveNotifyBackend } from "./lib/notify_utils.ts";
import { formatElapsed, logDebug, setLogLevel } from "./log.ts";
import { buildHostEnv, resolveProbes } from "./pipeline/host_env.ts";
import { createPipelineBuilder } from "./pipeline/stage_builder.ts";
import type { PipelineState } from "./pipeline/state.ts";
import type { StageInput } from "./pipeline/types.ts";
import { DockerServiceLive } from "./services/docker.ts";
import { FsServiceLive } from "./services/fs.ts";
import { ProcessServiceLive } from "./services/process.ts";
import { addRecentDir } from "./sessions/recent_dirs.ts";
import {
  createDbusProxyStage,
  DbusProxyServiceLive,
} from "./stages/dbus_proxy.ts";
import { createDindStage, DindServiceLive } from "./stages/dind.ts";
import { createDisplayStage, DisplayServiceLive } from "./stages/display.ts";
import {
  type BuildProbes,
  createDockerBuildStage,
  DockerBuildServiceLive,
  resolveBuildProbes,
} from "./stages/docker_build.ts";
import {
  createHostExecStage,
  HostExecBrokerServiceLive,
  HostExecSetupServiceLive,
} from "./stages/hostexec.ts";
import {
  ContainerLaunchServiceLive,
  createLaunchStage,
} from "./stages/launch.ts";
import {
  createMaskFilterStage,
  createMaskFsStage,
  MaskFilterServiceLive,
  MaskFsServiceLive,
} from "./stages/maskfs.ts";
import {
  createMountStage,
  type MountProbes,
  MountSetupServiceLive,
  resolveMountProbes,
} from "./stages/mount.ts";
import { createNixDetectStage } from "./stages/nix_detect.ts";
import {
  createObservabilityStage,
  OtlpReceiverServiceLive,
} from "./stages/observability.ts";
import {
  CaServiceLive,
  createProxyStage,
  ForwardPortRelayServiceLive,
  NetworkRuntimeServiceLive,
  ProxyServiceLive,
  SessionBrokerServiceLive,
} from "./stages/proxy.ts";
import {
  createSessionStoreStage,
  SessionStoreServiceLive,
} from "./stages/session_store.ts";
import {
  createWorktreeStage,
  GitWorktreeServiceLive,
  PromptServiceLive,
} from "./stages/worktree.ts";
import { ensureUiDaemon } from "./ui/daemon.ts";

const VERSION: string = pkg.version;

export async function main(args: string[], entryMs?: number): Promise<void> {
  const mainStart = performance.now();
  // `--` 以降は常にエージェントに渡す引数。profile 名の後ろも同様に agent 引数として扱う。
  const dashDashIdx = args.indexOf("--");
  const argsBeforeDashDash =
    dashDashIdx >= 0 ? args.slice(0, dashDashIdx) : args;
  const explicitAgentArgs = dashDashIdx >= 0 ? args.slice(dashDashIdx + 1) : [];
  const logLevel = parseLogLevel(argsBeforeDashDash);
  setLogLevel(logLevel);

  if (entryMs !== undefined) {
    logDebug(`[nas] Module import (${Math.round(mainStart - entryMs)}ms)`);
  }
  logDebug(`[nas] Bun startup → main() entry (${Math.round(mainStart)}ms)`);

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
    subcommand === "hook" ||
    subcommand === "config"
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

  if (subcommand === "config") {
    try {
      await runConfigCommand(
        removeFirstOccurrence(argsBeforeDashDash, "config"),
      );
    } catch (err) {
      exitOnCliError(err);
    }
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
    let phaseStart = performance.now();
    const config = await loadConfig();
    logDebug(`[nas] loadConfig done (${formatElapsed(phaseStart)})`);
    const { name, profile } = resolveProfile(config, profileName);
    const effectiveProfile = applyWorktreeOverride(profile, worktreeOverride);
    const sessionId = process.env.NAS_SESSION_ID || `sess_${randomHex(6)}`;

    // session.multiplex かつ dtach 内でなければ、nas 自体を dtach でラップして再実行
    if (effectiveProfile.session.multiplex && !process.env.NAS_INSIDE_DTACH) {
      await runInsideDtach(sessionId, effectiveProfile.session.detachKey, args);
      logDebug(`[nas] main() total (${formatElapsed(mainStart)})`);
      return;
    }

    // 起動 cwd を UI の "Recent directories" 用に記録（best-effort）
    try {
      await addRecentDir(process.cwd());
    } catch {}

    const imageName = "nas-sandbox";

    // HostEnv 構築と probe 解決
    // NOTE: Probe failures (e.g. PermissionDenied on /nix stat) will
    // propagate and abort the pipeline. This matches legacy stage behavior
    // where the same I/O happens inside each stage's execute().
    // NOTE: Probes are passed to StageInput and consumed by stages.
    phaseStart = performance.now();
    const hostEnv = buildHostEnv();
    const probes = await resolveProbes(hostEnv);
    logDebug(`[nas] resolveProbes done (${formatElapsed(phaseStart)})`);

    // notify-send の存在チェック（必要な場合のみ）
    {
      const networkNotify = resolveNotifyBackend(
        effectiveProfile.network.pendingNotify,
      );
      const hostexecNotify = resolveNotifyBackend(
        effectiveProfile.hostexec?.prompt.notify ?? "auto",
      );
      if (networkNotify === "desktop" || hostexecNotify === "desktop") {
        checkNotifySend();
      }
    }

    if (config.ui.enable) {
      phaseStart = performance.now();
      await ensureUiDaemon({
        port: config.ui.port,
        idleTimeout: config.ui.idleTimeout,
      });
      logDebug(`[nas] ensureUiDaemon done (${formatElapsed(phaseStart)})`);
    }

    // MountProbes を事前解決
    phaseStart = performance.now();
    const mountProbes = await resolveMountProbes(
      hostEnv,
      effectiveProfile,
      process.cwd(),
      probes.gpgAgentSocket,
    );
    logDebug(`[nas] resolveMountProbes done (${formatElapsed(phaseStart)})`);

    // BuildProbes を事前解決
    phaseStart = performance.now();
    const buildProbes = await resolveBuildProbes(imageName);
    logDebug(`[nas] resolveBuildProbes done (${formatElapsed(phaseStart)})`);

    const primitiveLayer = Layer.mergeAll(FsServiceLive, ProcessServiceLive);
    const dockerLayer = DockerServiceLive;
    const liveLayer = Layer.mergeAll(
      ContainerLaunchServiceLive.pipe(Layer.provide(dockerLayer)),
      DbusProxyServiceLive.pipe(Layer.provide(primitiveLayer)),
      DindServiceLive,
      DisplayServiceLive.pipe(Layer.provide(primitiveLayer)),
      DockerBuildServiceLive.pipe(
        Layer.provide(Layer.merge(FsServiceLive, dockerLayer)),
      ),
      CaServiceLive.pipe(
        Layer.provide(Layer.merge(FsServiceLive, dockerLayer)),
      ),
      ProxyServiceLive.pipe(Layer.provide(dockerLayer)),
      ForwardPortRelayServiceLive,
      FsServiceLive,
      GitWorktreeServiceLive.pipe(Layer.provide(primitiveLayer)),
      HostExecBrokerServiceLive,
      HostExecSetupServiceLive.pipe(Layer.provide(FsServiceLive)),
      MaskFilterServiceLive.pipe(Layer.provide(primitiveLayer)),
      MaskFsServiceLive.pipe(Layer.provide(primitiveLayer)),
      MountSetupServiceLive.pipe(Layer.provide(FsServiceLive)),
      NetworkRuntimeServiceLive.pipe(Layer.provide(primitiveLayer)),
      OtlpReceiverServiceLive,
      ProcessServiceLive,
      DockerServiceLive,
      PromptServiceLive,
      SessionBrokerServiceLive,
      SessionStoreServiceLive,
    );

    // HostExec broker が nas hook を実行する際に参照する
    process.env.NAS_SESSION_ID = sessionId;

    // history.db: invocation 行を materialize。telemetry は agent をブロック
    // しない原則のため、open/upsert 失敗は warn のみで CLI 続行 (db=null)。
    // Gap: SIGINT / SIGTERM / uncaughtException はこの try/catch を経由せず
    // プロセスを終了させるため、それらの経路では recordInvocationEnd が呼ばれず
    // ended_at は NULL のまま残る。signal handler を足さない trade-off。
    const historyDb = shouldRecordInvocation(effectiveProfile, process.env)
      ? recordInvocationStart({
          sessionId,
          profileName: name,
          agent: effectiveProfile.agent,
          worktreePath: process.cwd(),
          retentionSeconds: config.observability.retention,
        })
      : null;

    try {
      const initialState = createCliInitialState(process.cwd(), imageName, {
        NAS_LOG_LEVEL: logLevel,
        NAS_SESSION_ID: sessionId,
      });
      const builder = createCliPipelineBuilder({
        input: {
          config,
          profile: effectiveProfile,
          profileName: name,
          sessionId,
          sessionName,
          host: hostEnv,
          probes,
        },
        buildProbes,
        mountProbes,
        agentExtraArgs,
      });

      const exit = await Effect.runPromiseExit(
        builder
          .run(initialState)
          .pipe(Effect.scoped, Effect.provide(liveLayer)),
      );

      if (Exit.isFailure(exit)) {
        recordInvocationEnd(historyDb, { sessionId, exitReason: "error" });
        const error = Cause.squash(exit.cause);
        exitOnCliError(error);
      }
      recordInvocationEnd(historyDb, { sessionId, exitReason: "ok" });
      logDebug(`[nas] main() total (${formatElapsed(mainStart)})`);
    } catch (err) {
      recordInvocationEnd(historyDb, { sessionId, exitReason: "error" });
      throw err;
    }
  } catch (err) {
    exitOnCliError(err);
  }
}

export { applyWorktreeOverride, parseProfileAndWorktreeArgs };

export function createCliPipelineBuilder({
  input,
  buildProbes,
  mountProbes,
  agentExtraArgs,
}: {
  readonly input: StageInput;
  readonly buildProbes: BuildProbes;
  readonly mountProbes: MountProbes;
  readonly agentExtraArgs: string[];
}) {
  return (
    createPipelineBuilder<Pick<PipelineState, "workspace" | "container">>()
      .add(createWorktreeStage(input))
      .add(createSessionStoreStage(input))
      .add(createDockerBuildStage(buildProbes))
      .add(createNixDetectStage(input))
      .add(createDbusProxyStage(input))
      .add(createDisplayStage(input, mountProbes))
      // MaskFsStage は MountStage が読む workspace.maskedRoot を確定させるため
      // 必ず MountStage の直前に置く。
      .add(createMaskFsStage(input, mountProbes))
      .add(createMountStage(input, mountProbes))
      .add(createMaskFilterStage(input))
      .add(createHostExecStage(input))
      // ObservabilityStage materializes the observability slice and, when
      // enabled, acquires the per-session OTLP receiver and injects the OTLP
      // envs into the container slice. ProxyStage downstream picks up the
      // receiverPort and merges it into forwardPorts.
      .add(
        createObservabilityStage({
          config: input.config,
          profile: input.profile,
          profileName: input.profileName,
          sessionId: input.sessionId,
        }),
      )
      .add(createProxyStage(input))
      .add(createDindStage(input))
      .add(createLaunchStage(input, agentExtraArgs))
  );
}

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(data).toString("hex");
}

/**
 * nas プロセス全体を dtach 内で再実行する。
 *
 * master と attacher を分離する構成:
 *   1. `dtach -n` で独立 master プロセスを spawn（内部で nas を PTY 起動）
 *   2. `dtach -a` でユーザーのターミナルを attacher として接続
 *
 * `dtach -c` は master 兼 attacher で単一プロセスになり、ユーザの attacher を
 * 安全に kick する手段が無い（kill するとセッションごと死ぬ）。`-n` + `-a`
 * に分けることで、nas UI から `-a` attacher だけを SIGTERM できるようになる。
 */
async function runInsideDtach(
  sessionId: string,
  detachKey: string,
  originalArgs: string[],
): Promise<void> {
  if (!(await dtachIsAvailable())) {
    throw new Error(
      "dtach is required for session.multiplex but was not found. Install dtach or disable session.multiplex.",
    );
  }

  let start = performance.now();
  await gcDtachRuntime();
  logDebug(`[nas] gcDtachRuntime done (${formatElapsed(start)})`);

  const socketPath = socketPathFor(sessionId);

  // process.execPath で実際のバイナリパスを使う（Bun コンパイル済みだと
  // process.argv[0] が仮想パス /$bunfs/... になるため）。
  // originalArgs は main() に渡されたユーザー引数のみ。
  const nasCommand = shellEscape([process.execPath, ...originalArgs]);

  console.log(
    `[nas] Starting dtach session: ${sessionId} (detach: ${detachKey})`,
  );

  // 1. master を -n で起動（即座に detach 状態になる）
  start = performance.now();
  await dtachNewSession(socketPath, nasCommand, {
    env: {
      ...process.env,
      NAS_INSIDE_DTACH: "1",
      NAS_SESSION_ID: sessionId,
    },
  });
  logDebug(`[nas] dtachNewSession done (${formatElapsed(start)})`);

  // 2. ユーザーのターミナルを -a で attach
  start = performance.now();
  await dtachAttach(socketPath, detachKey);
  logDebug(`[nas] dtachAttach done (${formatElapsed(start)})`);

  console.log(`[nas] Detached. Reattach with: nas session attach ${sessionId}`);
}
