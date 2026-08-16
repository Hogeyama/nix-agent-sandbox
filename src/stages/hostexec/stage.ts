/**
 * HostExec Stage (EffectStage)
 *
 * ホスト上のコマンド実行を仲介する HostExecBroker を起動し、
 * エージェントコンテナ内からアクセスできるようにする。コンテナ側の入口は
 * コマンド名ごとの wrapper symlink (nas-hostexec-client) と、パス指定の
 * ルール用の LD_PRELOAD ライブラリの二つ。
 */

import * as path from "node:path";
import { Effect, Schedule, type Scope } from "effect";
import {
  DEFAULT_HOSTEXEC_CONFIG,
  type HostExecRule,
} from "../../config/types.ts";
import type { MaskFilterConfig } from "../../hostexec/broker.ts";
import {
  HOSTEXEC_CLIENT_CONTAINER_PATH,
  INTERCEPT_LIB_CONTAINER_PATH,
} from "../../hostexec/intercept_path.ts";
import {
  isBareCommandHostExecArgv0,
  isRelativeHostExecArgv0,
} from "../../hostexec/match.ts";
import {
  type HostExecRuntimePaths,
  hostExecBrokerSocketPath,
  hostExecExecSocketDir,
  hostExecExecSocketPath,
  hostExecInternalSocketPath,
  hostExecSessionBrokerDir,
} from "../../hostexec/registry.ts";
import { resolveNotifyBackend } from "../../lib/notify_utils.ts";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type {
  ContainerPlan,
  HostExecState,
  MountSpec,
  PipelineState,
  WorkspaceState,
} from "../../pipeline/state.ts";
import type { HostEnv, StageInput, StageResult } from "../../pipeline/types.ts";
import { resolveMaskFilterBinPath } from "../maskfs/mask_filter_path.ts";
import {
  type HostExecBrokerHandle,
  HostExecBrokerService,
} from "./broker_service.ts";
import { HostExecSetupService } from "./setup_service.ts";

const WRAPPER_DIR = "/opt/nas/hostexec/bin";
const SESSION_TMP_ROOT = "/tmp/nas-hostexec";
const HOSTEXEC_CLOSE_MAX_RETRIES = 2;

function releaseHostExecBroker(
  handle: HostExecBrokerHandle,
): Effect.Effect<void> {
  return handle.close().pipe(
    Effect.retry(Schedule.recurs(HOSTEXEC_CLOSE_MAX_RETRIES)),
    Effect.catchAllCause((cause) =>
      handle.reportTeardown(cause).pipe(Effect.asVoid),
    ),
  );
}

/**
 * 絶対パス argv0 の入力健全性を検証する。フォールバック bind-mount 経路を
 * 廃止したため、コンテナ側 system パスを shadow する経路は存在しない。ホスト側
 * exec の差し替えは integrity 検証（ブローカー）が守るので、ここではファイルパス
 * として異常なもの（`/` 単体・末尾スラッシュ・`.`/`..` セグメント）だけを弾く。
 *
 * Exported for tests.
 */
export function validateAbsoluteArgv0(ruleId: string, argv0: string): void {
  if (argv0 === "/" || argv0.endsWith("/")) {
    throw new Error(
      `hostexec rule ${JSON.stringify(ruleId)}: argv0 ${JSON.stringify(argv0)} is not a file path.`,
    );
  }
  const segments = argv0.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    throw new Error(
      `hostexec rule ${JSON.stringify(ruleId)}: argv0 ${JSON.stringify(argv0)} must not contain '.' or '..' segments.`,
    );
  }
}

// ---------------------------------------------------------------------------
// HostExecPlan
// ---------------------------------------------------------------------------

export interface HostExecPlan {
  readonly directories: ReadonlyArray<{ path: string; mode: number }>;
  readonly symlinks: ReadonlyArray<{ target: string; path: string }>;
  readonly mounts: readonly MountSpec[];
  readonly dockerArgs: string[];
  readonly envVars: Record<string, string>;
  readonly outputOverrides: Pick<StageResult, "hostexec">;
  /**
   * Intent to enable stdout/stderr mask filtering, carried as pure data.
   * Resolution of the filter binary happens in the Effect runner
   * (`runHostExec`), not here. The secrets themselves are resolved and
   * written to `secretsFramePath` by `MaskFilterStage`, which runs earlier
   * in the pipeline and owns that file; HostExecStage only reuses the path
   * so the host-side filter subprocess can read it.
   */
  readonly maskFilterIntent?: {
    readonly secretsFramePath: string;
  };
  readonly broker: {
    readonly execSocketPath: string;
    readonly internalSocketPath: string;
    readonly controlSocketPath: string;
    readonly gatewayBinaryPath: string;
    readonly paths: HostExecRuntimePaths;
    readonly sessionId: string;
    readonly profileName: string;
    readonly workspaceRoot: string;
    readonly sessionTmpDir: string;
    readonly hostexec: StageInput["profile"]["hostexec"];
    readonly notify: ReturnType<typeof resolveNotifyBackend>;
    readonly uiEnabled: boolean;
    readonly uiPort: number;
    readonly uiIdleTimeout: number;
    readonly auditDir: string | undefined;
    readonly agent: StageInput["profile"]["agent"];
    readonly integrityTargets: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// EffectStage
// ---------------------------------------------------------------------------

type HostExecStageState = Pick<PipelineState, "workspace" | "container">;
type HostExecStageInput = StageInput & HostExecStageState;

/**
 * Options for {@link createHostExecStage}, primarily to allow tests to
 * inject fakes for I/O-touching resolvers (mirrors
 * `MaskFilterStageOptions.resolveBinPath`).
 */
export interface HostExecStageOptions {
  readonly resolveMaskFilterBinPath?: () => Promise<string | null>;
}

export function createHostExecStage(
  shared: StageInput,
  options: HostExecStageOptions = {},
): Stage<
  "workspace" | "container",
  Pick<StageResult, "container" | "hostexec">,
  HostExecSetupService | HostExecBrokerService,
  unknown
> {
  return {
    name: "HostExecStage",
    needs: ["workspace", "container"],

    run(
      input,
    ): Effect.Effect<
      Pick<StageResult, "container" | "hostexec">,
      unknown,
      Scope.Scope | HostExecSetupService | HostExecBrokerService
    > {
      const stageInput: HostExecStageInput = {
        ...shared,
        ...input,
      };
      return Effect.gen(function* () {
        // Convert actionable planner errors (for example, a missing build
        // artifact) into stage failures instead of unhandled defects.
        const plan = yield* Effect.try({
          try: () => planHostExec(stageInput),
          catch: (e) => e,
        });
        if (plan === null) {
          return {};
        }
        return yield* runHostExec(plan, stageInput, options);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

/** Internal rule: route `nas hook` to the host via HostExec. */
const NAS_HOOK_RULE: HostExecRule = {
  id: "__nas_hook",
  match: { argv0: "nas", argRegex: "^hook\\b" },
  cwd: { mode: "any", allow: [] },
  env: {},
  inheritEnv: {
    mode: "minimal",
    keys: ["NAS_SESSION_ID", "NAS_SESSION_STORE_DIR", "XDG_RUNTIME_DIR"],
  },
  approval: "allow",
  fallback: "container",
};

export function planHostExec(input: HostExecStageInput): HostExecPlan | null {
  // Both container-side clients are build artifacts whose host paths can only
  // be learned by looking at the filesystem. That lookup is a probe resolved
  // once at pipeline startup (`resolveProbes`), so the planner stays pure and
  // tests fabricate the paths instead of needing the artifacts on disk.
  const {
    hostexecInterceptLibPath: interceptLibPath,
    hostexecClientPath: clientBinPath,
    hostexecGatewayPath: gatewayBinaryPath,
  } = input.probes;
  if (!gatewayBinaryPath) {
    throw new Error(
      "[nas] hostexec: nas-hostexec-gateway is missing. Build with `cd src/hostexec/intercept && zig build` or reinstall nas before starting a hostexec session.",
    );
  }
  const config =
    input.profile.hostexec ?? structuredClone(DEFAULT_HOSTEXEC_CONFIG);
  config.rules = [...config.rules, NAS_HOOK_RULE];
  // validateAbsoluteArgv0 はパスの健全性のみを検証する。具体的には `/` 単独、
  // 末尾スラッシュ、`.`/`..` セグメントを拒否する。ホストexecの差し替え防止は
  // ブローカーのintegrity検証がランタイムで担当する。フォールバックの
  // bind-mountパスは削除済みのため、コンテナ側からのシャドーイングはもう
  // 発生しない。
  for (const rule of config.rules) {
    if (path.isAbsolute(rule.match.argv0)) {
      validateAbsoluteArgv0(rule.id, rule.match.argv0);
    }
  }
  const workspace = resolveWorkspace(input);

  const runtimePaths = resolveHostExecRuntimePathsPure(input.host);
  const sessionBrokerDirPath = hostExecSessionBrokerDir(
    runtimePaths,
    input.sessionId,
  );
  // Two-socket split: the control socket (host CLI/UI only, approve/deny/
  // list_pending) stays in the session broker dir and is never mounted into
  // the container. The exec socket (execute/fallback only) lives in the
  // `exec/` subdir, which is the only part mounted into the container.
  const controlSocketPath = hostExecBrokerSocketPath(
    runtimePaths,
    input.sessionId,
  );
  const internalSocketPath = hostExecInternalSocketPath(
    runtimePaths,
    input.sessionId,
  );
  const execSocketPath = hostExecExecSocketPath(runtimePaths, input.sessionId);
  const execSocketDir = hostExecExecSocketDir(runtimePaths, input.sessionId);
  const wrapperRoot = path.join(runtimePaths.wrappersDir, input.sessionId);
  const wrapperBinDir = path.join(wrapperRoot, "bin");
  const sessionTmpDir = path.join(wrapperRoot, "tmp");
  const containerSessionTmp = path.join(SESSION_TMP_ROOT, input.sessionId);

  const directories: HostExecPlan["directories"] = [
    { path: runtimePaths.runtimeDir, mode: 0o755 },
    { path: runtimePaths.sessionsDir, mode: 0o700 },
    { path: runtimePaths.pendingDir, mode: 0o700 },
    { path: runtimePaths.brokersDir, mode: 0o700 },
    { path: sessionBrokerDirPath, mode: 0o700 },
    { path: execSocketDir, mode: 0o700 },
    { path: runtimePaths.wrappersDir, mode: 0o700 },
    { path: wrapperBinDir, mode: 0o755 },
    { path: sessionTmpDir, mode: 0o700 },
  ];

  // One symlink per bare-command argv0, all pointing at the standalone client.
  // The target is a container path, so these links dangle on the host -- they
  // are only ever resolved from inside the container, where the binary is
  // bind-mounted at that location.
  const symlinks: Array<{ target: string; path: string }> = [];
  const argv0Names = new Set(
    config.rules
      .map((rule) => rule.match.argv0)
      .filter(isBareCommandHostExecArgv0),
  );
  for (const argv0 of argv0Names) {
    symlinks.push({
      target: HOSTEXEC_CLIENT_CONTAINER_PATH,
      path: path.join(wrapperBinDir, argv0),
    });
  }

  const relativeArgv0s = [
    ...new Set(
      config.rules
        .map((rule) => rule.match.argv0)
        .filter(isRelativeHostExecArgv0),
    ),
  ];

  const absoluteArgv0s = [
    ...new Set(
      config.rules
        .map((rule) => rule.match.argv0)
        .filter((argv0) => path.isAbsolute(argv0)),
    ),
  ];

  const workDir = workspace.workDir;
  const workspaceRoot = workspace.mountDir ?? workspace.workDir;
  const interceptPaths = [
    ...relativeArgv0s.map((a) => path.resolve(workDir, a)),
    ...absoluteArgv0s,
  ];

  const mounts: MountSpec[] = [];
  const dockerArgs = [
    "-v",
    addMount(mounts, wrapperBinDir, WRAPPER_DIR, true),
    "-v",
    addMount(mounts, execSocketDir, execSocketDir),
    "-v",
    addMount(mounts, sessionTmpDir, containerSessionTmp),
  ];

  const envVars: Record<string, string> = {
    NAS_HOSTEXEC_SOCKET: execSocketPath,
    NAS_HOSTEXEC_WRAPPER_DIR: WRAPPER_DIR,
    NAS_HOSTEXEC_SESSION_ID: input.sessionId,
  };

  if (symlinks.length > 0) {
    if (!clientBinPath) {
      throw new Error(
        "[nas] hostexec: コマンド名 argv0 のルールには hostexec クライアント " +
          "(nas-hostexec-client) が必要ですが、見つかりませんでした。" +
          "nix ビルド（または `cd src/hostexec/intercept && zig build`）で生成するか、nas を再インストールしてください。",
      );
    }
    dockerArgs.push(
      "-v",
      addMount(mounts, clientBinPath, HOSTEXEC_CLIENT_CONTAINER_PATH, true),
    );
  }

  if (interceptPaths.length > 0) {
    if (!interceptLibPath) {
      throw new Error(
        "[nas] hostexec: 相対・絶対パス argv0 のルールには intercept ライブラリ " +
          "(hostexec_intercept.so) が必要ですが、見つかりませんでした。" +
          "nix ビルド（または `cd src/hostexec/intercept && zig build`）で生成するか、nas を再インストールしてください。",
      );
    }
    const existingLdPreload = envVars.LD_PRELOAD;
    envVars.LD_PRELOAD = existingLdPreload
      ? `${INTERCEPT_LIB_CONTAINER_PATH}:${existingLdPreload}`
      : INTERCEPT_LIB_CONTAINER_PATH;
    envVars.NAS_HOSTEXEC_INTERCEPT_PATHS = interceptPaths.join("\n");
    dockerArgs.push(
      "-v",
      addMount(mounts, interceptLibPath, INTERCEPT_LIB_CONTAINER_PATH, true),
    );
  }

  // Pure intent only: whether to enable mask filtering. The secrets frame
  // path must match the one MaskFilterStage computes and writes to (see
  // mask_filter_stage.ts) -- HostExecStage reuses that file instead of
  // resolving the same secrets a second time. Resolving the filter binary
  // (I/O) is deferred to the Effect runner.
  const mask = input.profile.mask;
  const maskFilterIntent: HostExecPlan["maskFilterIntent"] =
    mask?.filter && mask.values.length > 0
      ? {
          secretsFramePath: `${resolveRuntimeSubdir(input.host, "mask-filter")}/${input.sessionId}/mask-secrets`,
        }
      : undefined;

  return {
    directories,
    symlinks,
    mounts,
    dockerArgs,
    envVars,
    outputOverrides: {
      hostexec: {
        runtimeDir: runtimePaths.runtimeDir,
        brokerSocket: controlSocketPath,
        sessionTmpDir: containerSessionTmp,
      } satisfies HostExecState,
    },
    maskFilterIntent,
    broker: {
      execSocketPath,
      internalSocketPath,
      controlSocketPath,
      gatewayBinaryPath,
      paths: runtimePaths,
      sessionId: input.sessionId,
      profileName: input.profileName,
      workspaceRoot,
      sessionTmpDir,
      hostexec: config,
      notify: resolveNotifyBackend(config.prompt.notify),
      uiEnabled: input.config.ui.enable,
      uiPort: input.config.ui.port,
      uiIdleTimeout: input.config.ui.idleTimeout,
      auditDir: input.probes.auditDir,
      agent: input.profile.agent,
      integrityTargets: interceptPaths,
    },
  };
}

// ---------------------------------------------------------------------------
// Effect runner
// ---------------------------------------------------------------------------

function runHostExec(
  plan: HostExecPlan,
  input: HostExecStageInput,
  options: HostExecStageOptions = {},
): Effect.Effect<
  Pick<StageResult, "container" | "hostexec">,
  unknown,
  Scope.Scope | HostExecSetupService | HostExecBrokerService
> {
  const resolveBinPath =
    options.resolveMaskFilterBinPath ?? resolveMaskFilterBinPath;
  return Effect.gen(function* () {
    const setupService = yield* HostExecSetupService;
    const brokerService = yield* HostExecBrokerService;
    const container = buildContainerState(input, plan);

    yield* setupService.prepareWorkspace({
      directories: plan.directories,
      symlinks: plan.symlinks,
    });

    let maskFilter: MaskFilterConfig | undefined;
    const intent = plan.maskFilterIntent;
    if (intent) {
      const binaryPath = yield* Effect.tryPromise({
        try: () => resolveBinPath(),
        catch: (e) => e,
      });
      if (!binaryPath) {
        return yield* Effect.fail(
          new Error(
            "[nas] hostexec: nas-mask-filter binary not found. Build with `cd src/mask-filter && zig build` (dev) or reinstall nas (nix).",
          ),
        );
      }
      // The secrets frame itself is resolved, written, and owned by
      // MaskFilterStage (see mask_filter_stage.ts), which runs earlier in
      // the pipeline. HostExecStage only needs the binary path and reuses
      // the same frame file path -- resolving the secrets a second time
      // here would be redundant I/O and a second copy of the secret
      // material on disk.
      maskFilter = { binaryPath, secretsFramePath: intent.secretsFramePath };
    }

    const spec = plan.broker;

    yield* Effect.acquireRelease(
      brokerService.start({
        paths: spec.paths,
        sessionId: spec.sessionId,
        execSocketPath: spec.execSocketPath,
        internalSocketPath: spec.internalSocketPath,
        controlSocketPath: spec.controlSocketPath,
        gatewayBinaryPath: spec.gatewayBinaryPath,
        profileName: spec.profileName,
        workspaceRoot: spec.workspaceRoot,
        sessionTmpDir: spec.sessionTmpDir,
        hostexec: spec.hostexec,
        notify: spec.notify,
        uiEnabled: spec.uiEnabled,
        uiPort: spec.uiPort,
        uiIdleTimeout: spec.uiIdleTimeout,
        auditDir: spec.auditDir,
        agent: spec.agent,
        integrityTargets: spec.integrityTargets,
        maskFilter,
      }),
      (handle) => releaseHostExecBroker(handle),
    );

    return {
      ...plan.outputOverrides,
      container,
    };
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function resolveHostExecRuntimePathsPure(
  host: HostEnv,
): HostExecRuntimePaths {
  const xdg = host.env.get("XDG_RUNTIME_DIR");
  let runtimeDir: string;
  if (xdg && xdg.trim().length > 0) {
    runtimeDir = path.join(xdg, "nas", "hostexec");
  } else {
    const uid = host.uid ?? "unknown";
    runtimeDir = path.join("/tmp", `nas-${uid}`, "hostexec");
  }
  return {
    runtimeDir,
    sessionsDir: path.join(runtimeDir, "sessions"),
    pendingDir: path.join(runtimeDir, "pending"),
    brokersDir: path.join(runtimeDir, "brokers"),
    wrappersDir: path.join(runtimeDir, "wrappers"),
  };
}

function resolveWorkspace(input: {
  workspace: WorkspaceState;
}): WorkspaceState {
  return input.workspace;
}

function buildContainerState(
  input: { workspace: WorkspaceState; container: ContainerPlan },
  plan: HostExecPlan,
): ContainerPlan {
  const workspace = resolveWorkspace(input);
  return mergeContainerPlan(resolveContainerBase(input, workspace), {
    mounts: plan.mounts,
    env: { static: plan.envVars },
  });
}

function resolveContainerBase(
  input: { container: ContainerPlan },
  _workspace: WorkspaceState,
): ContainerPlan {
  return input.container;
}

function addMount(
  mounts: MountSpec[],
  source: string,
  target: string,
  readOnly = false,
): string {
  mounts.push(
    readOnly ? { source, target, readOnly: true } : { source, target },
  );
  return `${source}:${target}${readOnly ? ":ro" : ""}`;
}
