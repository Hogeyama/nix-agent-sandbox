/**
 * ProxyStage (EffectStage)
 *
 * 共有 Envoy コンテナ + auth-router + session network + session broker を
 * セットアップし、エージェントコンテナのネットワークトラフィックを
 * allowlist/prompt ベースで制御する。
 *
 * plan() は skip 判定と設定の計算のみ行い、run() は Effect.acquireRelease を
 * チェーンして各サブリソースのライフサイクルを管理する。
 */

import * as path from "node:path";
import { Effect, type Scope } from "effect";
import { resolveNotifyBackend } from "../lib/notify_utils.ts";
import { logInfo } from "../log.ts";
import {
  generateSessionToken as defaultGenerateToken,
  hashToken,
} from "../network/protocol.ts";
import {
  emptyContainerPlan,
  mergeContainerPlan,
} from "../pipeline/container_plan.ts";
import { encodeDynamicEnvOps } from "../pipeline/env_ops.ts";
import type {
  ContainerPlan,
  NetworkState,
  PromptState,
  ProxyState,
} from "../pipeline/state.ts";
import type { NetworkRuntimePaths } from "../network/registry.ts";
import type {
  EffectStage,
  EffectStageResult,
  HostEnv,
  StageInput,
} from "../pipeline/types.ts";
import {
  type AuthRouterHandle,
  AuthRouterService,
} from "../services/auth_router.ts";
import { EnvoyService } from "../services/envoy.ts";
import { NetworkRuntimeService } from "../services/network_runtime.ts";
import {
  type SessionBrokerHandle,
  SessionBrokerService,
} from "../services/session_broker.ts";

const ENVOY_IMAGE = "envoyproxy/envoy:v1.37.1";
const ENVOY_CONTAINER_NAME = "nas-envoy-shared";
const ENVOY_ALIAS = "nas-envoy";
const ENVOY_PROXY_PORT = 15001;
const ENVOY_READY_TIMEOUT_MS = 15_000;
export const LOCAL_PROXY_PORT = 18080;

// ---------------------------------------------------------------------------
// ProxyPlan
// ---------------------------------------------------------------------------

export interface ProxyPlan {
  readonly envoyContainerName: string;
  readonly envoyImage: string;
  readonly envoyAlias: string;
  readonly envoyProxyPort: number;
  readonly envoyReadyTimeoutMs: number;
  readonly sessionId: string;
  readonly sessionNetworkName: string;
  readonly profileName: string;
  readonly agent: StageInput["profile"]["agent"];
  readonly runtimePaths: NetworkRuntimePaths;
  readonly brokerSocket: string;
  readonly token: string;
  readonly allowlist: string[];
  readonly denylist: string[];
  readonly promptEnabled: boolean;
  readonly timeoutSeconds: number;
  readonly defaultScope: import("../network/protocol.ts").ApprovalScope;
  readonly notify: import("../lib/notify_utils.ts").ResolvedNotifyBackend;
  readonly uiEnabled: boolean;
  readonly uiPort: number;
  readonly uiIdleTimeout: number;
  readonly auditDir: string;
  readonly dindContainerName: string | null;
  readonly outputOverrides: EffectStageResult;
  readonly envVars: Record<string, string>;
  readonly container: ContainerPlan;
}

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

export interface ProxyStageOptions {
  envoyContainerName?: string;
  generateSessionToken?: () => string;
}

export function planProxy(
  input: StageInput,
  options: ProxyStageOptions = {},
): ProxyPlan | null {
  if (!isProxyEnabled(input)) {
    logInfo("[nas] Proxy: skipped (allowlist/prompt disabled)");
    return null;
  }

  const envoyContainerName = options.envoyContainerName ?? ENVOY_CONTAINER_NAME;
  const generateSessionToken =
    options.generateSessionToken ?? defaultGenerateToken;

  const runtimePaths = buildNetworkRuntimePaths(input.host);
  const brokerSocket = path.join(
    runtimePaths.brokersDir,
    `${input.sessionId}.sock`,
  );
  const prompt = input.profile.network.prompt;
  const token =
    input.prior.prompt?.promptToken ??
    input.prior.networkPromptToken ??
    generateSessionToken();
  const sessionNetworkName = `nas-session-net-${input.sessionId}`;

  const dindContainerName =
    input.prior.dind?.containerName ?? parseDindContainerName(input.prior.envVars);

  const proxyUrl = `http://${input.sessionId}:${token}@${ENVOY_ALIAS}:${ENVOY_PROXY_PORT}`;
  const localProxyUrl = `http://127.0.0.1:${LOCAL_PROXY_PORT}`;
  const noProxyEntries = ["localhost", "127.0.0.1"];
  if (dindContainerName) {
    noProxyEntries.push(dindContainerName);
  }

  const container = buildContainerState(input, {
    sessionNetworkName,
    envVars: {
      NAS_UPSTREAM_PROXY: proxyUrl,
      http_proxy: localProxyUrl,
      https_proxy: localProxyUrl,
      HTTP_PROXY: localProxyUrl,
      HTTPS_PROXY: localProxyUrl,
      no_proxy: noProxyEntries.join(","),
      NO_PROXY: noProxyEntries.join(","),
    },
  });

  const network: NetworkState = {
    networkName: sessionNetworkName,
    runtimeDir: runtimePaths.runtimeDir,
  };
  const promptState: PromptState = {
    promptToken: token,
    promptEnabled: prompt.enable,
  };
  const proxy: ProxyState = {
    brokerSocket,
    proxyEndpoint: proxyUrl,
  };

  return {
    envoyContainerName,
    envoyImage: ENVOY_IMAGE,
    envoyAlias: ENVOY_ALIAS,
    envoyProxyPort: ENVOY_PROXY_PORT,
    envoyReadyTimeoutMs: ENVOY_READY_TIMEOUT_MS,
    sessionId: input.sessionId,
    sessionNetworkName,
    profileName: input.profileName,
    agent: input.profile.agent,
    runtimePaths,
    brokerSocket,
    token,
    allowlist: input.profile.network.allowlist,
    denylist: prompt.denylist,
    promptEnabled: prompt.enable,
    timeoutSeconds: prompt.timeoutSeconds,
    defaultScope: prompt.defaultScope,
    notify: resolveNotifyBackend(prompt.notify),
    uiEnabled: input.config.ui.enable,
    uiPort: input.config.ui.port,
    uiIdleTimeout: input.config.ui.idleTimeout,
    auditDir: input.probes.auditDir,
    dindContainerName,
    envVars: container.env.static,
    container,
    outputOverrides: {
      networkName: sessionNetworkName,
      networkRuntimeDir: runtimePaths.runtimeDir,
      networkPromptToken: token,
      networkPromptEnabled: prompt.enable,
      networkBrokerSocket: brokerSocket,
      networkProxyEndpoint: proxyUrl,
      network,
      prompt: promptState,
      proxy,
      container,
    },
  };
}

// ---------------------------------------------------------------------------
// EffectStage
// ---------------------------------------------------------------------------

export function createProxyStage(
  options: ProxyStageOptions = {},
): EffectStage<
  | NetworkRuntimeService
  | EnvoyService
  | SessionBrokerService
  | AuthRouterService
> {
  return {
    kind: "effect",
    name: "ProxyStage",

    run(
      input: StageInput,
    ): Effect.Effect<
      EffectStageResult,
      unknown,
      | Scope.Scope
      | NetworkRuntimeService
      | EnvoyService
      | SessionBrokerService
      | AuthRouterService
    > {
      const plan = planProxy(input, options);
      if (plan === null) {
        return Effect.succeed({});
      }
      return runProxy(plan, input);
    },
  };
}

// ---------------------------------------------------------------------------
// Effect runner
// ---------------------------------------------------------------------------

function runProxy(
  plan: ProxyPlan,
  input: StageInput,
): Effect.Effect<
  EffectStageResult,
  unknown,
  | Scope.Scope
  | NetworkRuntimeService
  | EnvoyService
  | SessionBrokerService
  | AuthRouterService
> {
  return Effect.gen(function* () {
    const networkRuntime = yield* NetworkRuntimeService;
    const envoy = yield* EnvoyService;
    const sessionBrokerService = yield* SessionBrokerService;
    const authRouterService = yield* AuthRouterService;

    // 1. GC stale sessions (read PID file, check alive, remove stale files)
    yield* networkRuntime.gcStaleRuntime(plan.runtimePaths);

    // 2. Render envoy config (read template + write config)
    yield* networkRuntime.renderEnvoyConfig(plan.runtimePaths);

    // 3. Session broker + registry (acquireRelease)
    const tokenHash = yield* Effect.tryPromise({
      try: () => hashToken(plan.token),
      catch: (e) =>
        new Error(
          `hashToken failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
    });
    yield* Effect.acquireRelease(
      sessionBrokerService.start({
        paths: plan.runtimePaths,
        sessionId: plan.sessionId,
        socketPath: plan.brokerSocket,
        profileName: plan.profileName,
        agent: plan.agent,
        allowlist: plan.allowlist,
        denylist: plan.denylist,
        promptEnabled: plan.promptEnabled,
        timeoutSeconds: plan.timeoutSeconds,
        defaultScope: plan.defaultScope,
        notify: plan.notify,
        uiEnabled: plan.uiEnabled,
        uiPort: plan.uiPort,
        uiIdleTimeout: plan.uiIdleTimeout,
        auditDir: plan.auditDir,
        tokenHash,
      }),
      (handle: SessionBrokerHandle) => handle.close(),
    );

    // 4. Auth-router daemon (acquireRelease)
    yield* Effect.acquireRelease(
      authRouterService.ensureDaemon(plan.runtimePaths),
      (handle: AuthRouterHandle) => handle.abort(),
    );

    // 5. Shared envoy container (acquireRelease — no teardown since it's shared)
    yield* Effect.acquireRelease(
      envoy.ensureSharedEnvoy(plan),
      () => Effect.void,
    );

    // 6. Session network + envoy/dind connect (acquireRelease)
    yield* Effect.acquireRelease(
      envoy.createSessionNetwork(plan),
      (teardown: () => Effect.Effect<void>) => teardown(),
    );

    const legacy = renderLegacyContainerState(plan.container);

    return {
      ...plan.outputOverrides,
      dockerArgs: legacy.dockerArgs,
      envVars: legacy.envVars,
    };
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isProxyEnabled(input: StageInput): boolean {
  return (
    input.profile.network.allowlist.length > 0 ||
    input.profile.network.prompt.enable
  );
}

export function buildNetworkRuntimePaths(host: HostEnv): NetworkRuntimePaths {
  const xdg = host.env.get("XDG_RUNTIME_DIR");
  let runtimeDir: string;
  if (xdg && xdg.trim().length > 0) {
    runtimeDir = path.join(xdg, "nas", "network");
  } else {
    const uid = host.uid ?? "unknown";
    runtimeDir = path.join("/tmp", `nas-${uid}`, "network");
  }
  return {
    runtimeDir,
    sessionsDir: path.join(runtimeDir, "sessions"),
    pendingDir: path.join(runtimeDir, "pending"),
    brokersDir: path.join(runtimeDir, "brokers"),
    authRouterSocket: path.join(runtimeDir, "auth-router.sock"),
    authRouterPidFile: path.join(runtimeDir, "auth-router.pid"),
    envoyConfigFile: path.join(runtimeDir, "envoy.yaml"),
  };
}

export function replaceNetwork(
  dockerArgs: string[],
  newNetwork: string,
): string[] {
  const args = [...dockerArgs];
  const idx = args.indexOf("--network");
  if (idx !== -1 && idx + 1 < args.length) {
    args[idx + 1] = newNetwork;
  } else {
    args.push("--network", newNetwork);
  }
  return args;
}

function buildContainerState(
  input: StageInput,
  config: {
    readonly sessionNetworkName: string;
    readonly envVars: Readonly<Record<string, string>>;
  },
): ContainerPlan {
  return mergeContainerPlan(resolveContainerBase(input), {
    env: { static: config.envVars },
    network: { name: config.sessionNetworkName },
  });
}

function resolveContainerBase(input: StageInput): ContainerPlan {
  if (input.prior.container) {
    return input.prior.container;
  }

  const { mounts, workDir, network, extraRunArgs } = parseLegacyDockerArgs(
    input.prior.dockerArgs,
    resolveWorkDir(input),
  );

  return mergeContainerPlan(emptyContainerPlan(resolveImageName(input), workDir), {
    mounts,
    env: { static: { ...input.prior.envVars } },
    ...(network ? { network } : {}),
    extraRunArgs,
    command: {
      agentCommand: [...input.prior.agentCommand],
      extraArgs: [],
    },
  });
}

function resolveImageName(input: StageInput): string {
  return input.prior.workspace?.imageName ?? input.prior.imageName;
}

function resolveWorkDir(input: StageInput): string {
  return input.prior.workspace?.workDir ?? input.prior.workDir;
}

function parseLegacyDockerArgs(
  dockerArgs: readonly string[],
  defaultWorkDir: string,
): {
  readonly mounts: ContainerPlan["mounts"];
  readonly workDir: string;
  readonly network?: { name: string; alias?: string };
  readonly extraRunArgs: string[];
} {
  const mounts: Array<ContainerPlan["mounts"][number]> = [];
  const extraRunArgs: string[] = [];
  let workDir = defaultWorkDir;
  let networkName: string | undefined;
  let networkAlias: string | undefined;

  for (let i = 0; i < dockerArgs.length; i += 1) {
    const arg = dockerArgs[i];
    if (arg === "-v" && i + 1 < dockerArgs.length) {
      const mountArg = dockerArgs[i + 1];
      if (mountArg !== undefined) {
        mounts.push(parseMountSpec(mountArg));
      }
      i += 1;
      continue;
    }
    if (arg === "-w" && i + 1 < dockerArgs.length) {
      const workDirArg = dockerArgs[i + 1];
      if (workDirArg !== undefined) {
        workDir = workDirArg;
      }
      i += 1;
      continue;
    }
    if (arg === "--network" && i + 1 < dockerArgs.length) {
      const networkArg = dockerArgs[i + 1];
      if (networkArg !== undefined) {
        networkName = networkArg;
      }
      i += 1;
      continue;
    }
    if (arg === "--network-alias" && i + 1 < dockerArgs.length) {
      const aliasArg = dockerArgs[i + 1];
      if (aliasArg !== undefined) {
        networkAlias = aliasArg;
      }
      i += 1;
      continue;
    }
    extraRunArgs.push(arg);
  }

  return {
    mounts,
    workDir,
    ...(networkName ? { network: { name: networkName, alias: networkAlias } } : {}),
    extraRunArgs,
  };
}

function parseMountSpec(rawMount: string): {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: true;
} {
  const readOnly = rawMount.endsWith(":ro");
  const mountValue = readOnly ? rawMount.slice(0, -3) : rawMount;
  const separatorIndex = mountValue.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`[nas] Invalid mount arg: ${rawMount}`);
  }
  const source = mountValue.slice(0, separatorIndex);
  const target = mountValue.slice(separatorIndex + 1);
  return readOnly ? { source, target, readOnly: true } : { source, target };
}

function renderLegacyContainerState(container: ContainerPlan): {
  readonly dockerArgs: readonly string[];
  readonly envVars: Readonly<Record<string, string>>;
} {
  const dockerArgs = [
    ...container.mounts.flatMap((mount) => [
      "-v",
      `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`,
    ]),
    "-w",
    container.workDir,
    ...(container.network
      ? [
          "--network",
          container.network.name,
          ...(container.network.alias
            ? ["--network-alias", container.network.alias]
            : []),
        ]
      : []),
    ...container.extraRunArgs,
  ];

  const envVars: Record<string, string> = { ...container.env.static };
  if (container.env.dynamicOps.length > 0) {
    envVars.NAS_ENV_OPS = encodeDynamicEnvOps(container.env.dynamicOps);
  }

  return { dockerArgs, envVars };
}

export function parseDindContainerName(
  envVars: Readonly<Record<string, string>>,
): string | null {
  const explicitName = envVars.NAS_DIND_CONTAINER_NAME;
  if (explicitName && explicitName.trim() !== "") {
    return explicitName;
  }
  const dockerHost = envVars.DOCKER_HOST;
  if (!dockerHost) return null;
  const match = dockerHost.match(/^tcp:\/\/([^:]+):\d+$/);
  return match ? match[1] : null;
}
