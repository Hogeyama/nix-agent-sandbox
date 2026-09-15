/**
 * CLI エントリポイント
 */

import { Cause, Effect, Exit } from "effect";
import pkg from "../package.json";
import { validateAcpInvocation } from "./cli/acp.ts";
import {
  ACP_REAPER_SUBCOMMAND,
  runAcpReaperCommand,
  spawnAcpSessionReaper,
} from "./cli/acp_reaper.ts";
import {
  applyWorktreeOverride,
  parseProfileAndWorktreeArgs,
} from "./cli/args.ts";
import { runAuditCommand } from "./cli/audit.ts";
import { runConfigCommand } from "./cli/config.ts";
import { runContainerCommand } from "./cli/container.ts";
import { extractControlOptions } from "./cli/control_options.ts";
import { runDevcontainerCommand } from "./cli/devcontainer.ts";
import { parseDevcontainerSupervisorArgs } from "./cli/devcontainer_args.ts";
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
import { writeSessionIdFile } from "./cli/write_session_id.ts";
import { loadConfig, resolveProfile } from "./config/load.ts";
import { runDevcontainerSupervisorEntry } from "./devcontainer/runtime.ts";
import { AcpConnection } from "./docker/acp_connection.ts";
import { ProtocolCommandError } from "./docker/protocol_command.ts";
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
import { withPreparationCommands } from "./lib/preparation_commands.ts";
import {
  diagnosticLogger,
  formatElapsed,
  logDebug,
  logWarn,
  openDiagnosticLog,
  setDiagnosticStderr,
  setLogLevel,
} from "./log.ts";
import { createCliPipelineBuilder } from "./pipeline/cli_builder.ts";
import { buildHostEnv, resolveProbes } from "./pipeline/host_env.ts";
import { createPipelineLiveLayer } from "./pipeline/live.ts";
import { addRecentDir } from "./sessions/recent_dirs.ts";
import { resolveBuildProbes } from "./stages/docker_build.ts";
import { resolveMountProbes } from "./stages/mount.ts";
import { ensureUiDaemon } from "./ui/daemon.ts";

const GIT_REVISION: string = process.env.NAS_GIT_REVISION ?? "dev";
const VERSION: string = `${pkg.version}+${GIT_REVISION}`;

export async function main(args: string[], entryMs?: number): Promise<void> {
  let closeLog: (() => void) | undefined;
  try {
    const parsed = extractControlOptions(args);
    if (parsed.logFile) closeLog = openDiagnosticLog(parsed.logFile);
    await runMain(parsed.args, entryMs, args, parsed.writeSessionId);
  } catch (error) {
    exitOnCliError(error);
  } finally {
    closeLog?.();
  }
}

async function runMain(
  args: string[],
  entryMs?: number,
  originalArgs = args,
  writeSessionId?: string,
): Promise<void> {
  const mainStart = performance.now();
  const nonInteractive = !process.stdin.isTTY || !process.stdout.isTTY;
  setDiagnosticStderr(nonInteractive);
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
    subcommand === "config" ||
    subcommand === "devcontainer"
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

  if (subcommand === ACP_REAPER_SUBCOMMAND) {
    await runAcpReaperCommand(
      removeFirstOccurrence(argsBeforeDashDash, ACP_REAPER_SUBCOMMAND),
    );
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

  if (subcommand === "devcontainer") {
    const devcontainerArgs = removeFirstOccurrence(args, "devcontainer").filter(
      (arg) => !["-q", "--quiet", "-v", "--verbose"].includes(arg),
    );
    try {
      if (devcontainerArgs[0] === "_supervise") {
        const internal = parseDevcontainerSupervisorArgs(devcontainerArgs);
        await runDevcontainerSupervisorEntry(
          internal.workspace,
          internal.sessionId,
          internal.deadlineAt,
        );
      } else {
        await runDevcontainerCommand(devcontainerArgs);
      }
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
    // The profile mode is unknown until the config loads, so pipe state alone
    // must not suppress auto-init for terminal runs such as `nas | tee`.
    // ACP already cannot reach the stdin prompts: both require a TTY stdin.
    const config = await loadConfig();
    logDebug(`[nas] loadConfig done (${formatElapsed(phaseStart)})`);
    const { name, profile } = resolveProfile(config, profileName);
    const effectiveProfile = applyWorktreeOverride(profile, worktreeOverride);
    validateAcpInvocation(
      effectiveProfile,
      agentExtraArgs,
      process.env,
      !!process.stdin.isTTY,
    );
    const acp = effectiveProfile.mode === "acp";
    setDiagnosticStderr(acp);
    const sessionId = process.env.NAS_SESSION_ID || `sess_${randomHex(6)}`;
    // 起動した側がセッションを名指しできるようにする。`nas <domain> watch
    // --session` や `approve` に渡す値で、stdout がプロトコル専用になる ACP
    // ではこれが唯一の入手経路になる。
    if (writeSessionId) await writeSessionIdFile(writeSessionId, sessionId);

    // session.multiplex かつ dtach 内でなければ、nas 自体を dtach でラップして再実行
    if (
      !acp &&
      effectiveProfile.session.multiplex &&
      !process.env.NAS_INSIDE_DTACH
    ) {
      await runInsideDtach(
        sessionId,
        effectiveProfile.session.detachKey,
        originalArgs,
      );
      logDebug(`[nas] main() total (${formatElapsed(mainStart)})`);
      return;
    }

    // ACP clients may SIGKILL nas, which skips every Scope finalizer.
    if (acp) spawnAcpSessionReaper(sessionId);

    const connection = acp ? new AcpConnection() : undefined;
    const shutdown = connection?.controller ?? new AbortController();
    // Exit with 128 + signal number, as a process killed by that signal would.
    const interruptBySigint = () =>
      connection?.cancel("ACP launch interrupted", 130);
    const interruptBySigterm = () =>
      connection?.cancel("ACP launch terminated", 143);
    const prepare = <T>(operation: () => Promise<T>): Promise<T> =>
      connection ? connection.prepare(operation) : operation();
    if (acp) {
      process.on("SIGINT", interruptBySigint);
      process.on("SIGTERM", interruptBySigterm);
    }
    try {
      const runPrepared = async () => {
        // 起動 cwd を UI の "Recent directories" 用に記録（best-effort）
        try {
          await prepare(() => addRecentDir(process.cwd()));
        } catch {}

        const imageName = "nas-sandbox";

        // HostEnv 構築と probe 解決
        // NOTE: Probe failures (e.g. PermissionDenied on /nix stat) will
        // propagate and abort the pipeline. This matches legacy stage behavior
        // where the same I/O happens inside each stage's execute().
        // NOTE: Probes are passed to StageInput and consumed by stages.
        phaseStart = performance.now();
        const hostEnv = buildHostEnv();
        const probes = await prepare(() => resolveProbes(hostEnv));
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
          const uiDaemonStart = performance.now();
          void ensureUiDaemon({
            port: config.ui.port,
            idleTimeout: config.ui.idleTimeout,
          })
            .then(() => {
              logDebug(
                `[nas] ensureUiDaemon done (${formatElapsed(uiDaemonStart)})`,
              );
            })
            .catch((error) => {
              logWarn(
                `[nas] UI daemon failed to start: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        }

        // MountProbes を事前解決
        phaseStart = performance.now();
        const mountProbes = await prepare(() =>
          resolveMountProbes(
            hostEnv,
            effectiveProfile,
            process.cwd(),
            probes.gpgAgentSocket,
          ),
        );
        logDebug(
          `[nas] resolveMountProbes done (${formatElapsed(phaseStart)})`,
        );

        // BuildProbes を事前解決
        phaseStart = performance.now();
        const buildProbes = await prepare(() => resolveBuildProbes(imageName));
        logDebug(
          `[nas] resolveBuildProbes done (${formatElapsed(phaseStart)})`,
        );

        const liveLayer = createPipelineLiveLayer();

        // HostExec broker が nas hook を実行する際に参照する
        process.env.NAS_SESSION_ID = sessionId;

        // history.db: invocation 行を materialize。telemetry は agent をブロック
        // しない原則のため、open/upsert 失敗は warn のみで CLI 続行 (db=null)。
        // Terminal mode retains its existing signal behavior. ACP cancellation
        // closes the pipeline Scope and records the invocation as an error.
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
              .pipe(
                Effect.scoped,
                Effect.provide(liveLayer),
                Effect.provide(diagnosticLogger),
              ),
            { signal: acp ? shutdown.signal : undefined },
          );

          if (Exit.isFailure(exit)) {
            // The catch below records the error once.
            const error = shutdown.signal.aborted
              ? (shutdown.signal.reason ??
                new ProtocolCommandError("ACP launch interrupted", 130))
              : Cause.squash(exit.cause);
            throw error;
          }
          recordInvocationEnd(historyDb, { sessionId, exitReason: "ok" });
          logDebug(`[nas] main() total (${formatElapsed(mainStart)})`);
        } catch (err) {
          recordInvocationEnd(historyDb, { sessionId, exitReason: "error" });
          throw err;
        }
      };
      if (connection) {
        await connection.run(() =>
          withPreparationCommands(shutdown.signal, runPrepared),
        );
      } else {
        await runPrepared();
      }
    } finally {
      connection?.dispose();
      if (acp) {
        process.off("SIGINT", interruptBySigint);
        process.off("SIGTERM", interruptBySigterm);
      }
    }
  } catch (err) {
    exitOnCliError(err);
  }
}

export { createCliPipelineBuilder } from "./pipeline/cli_builder.ts";
export { applyWorktreeOverride, parseProfileAndWorktreeArgs };

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
