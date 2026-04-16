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
import type { NetworkRuntimePaths } from "../network/registry.ts";
import { mergeContainerPlan } from "../pipeline/container_plan.ts";
import type { Stage } from "../pipeline/stage_builder.ts";
import type {
  ContainerPlan,
  NetworkState,
  PipelineState,
  PromptState,
  ProxyState,
} from "../pipeline/state.ts";
import type { HostEnv, StageInput, StageResult } from "../pipeline/types.ts";
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
  readonly outputOverrides: Pick<
    StageResult,
    "network" | "prompt" | "proxy" | "container"
  >;
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
  input: StageInput & Pick<PipelineState, "container">,
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
  const token = generateSessionToken();
  const sessionNetworkName = `nas-session-net-${input.sessionId}`;

  const dindContainerName =
    input.container.env.static.NAS_DIND_CONTAINER_NAME ?? null;

  const forwardPorts = input.profile.network.proxy.forwardPorts;
  const forwardPortEntries = forwardPorts.map(
    (p) => `host.docker.internal:${p}`,
  );

  const proxyUrl = `http://${input.sessionId}:${token}@${ENVOY_ALIAS}:${ENVOY_PROXY_PORT}`;
  const localProxyUrl = `http://127.0.0.1:${LOCAL_PROXY_PORT}`;
  const noProxyEntries = ["localhost", "127.0.0.1"];
  if (dindContainerName) {
    noProxyEntries.push(dindContainerName);
  }

  const envVars: Record<string, string> = {
    NAS_UPSTREAM_PROXY: proxyUrl,
    http_proxy: localProxyUrl,
    https_proxy: localProxyUrl,
    HTTP_PROXY: localProxyUrl,
    HTTPS_PROXY: localProxyUrl,
    no_proxy: noProxyEntries.join(","),
    NO_PROXY: noProxyEntries.join(","),
  };
  if (forwardPorts.length > 0) {
    envVars.NAS_FORWARD_PORTS = forwardPorts.join(",");
  }

  const container = buildContainerState(input, {
    sessionNetworkName,
    envVars,
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
    allowlist: [...input.profile.network.allowlist, ...forwardPortEntries],
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
  shared: StageInput,
): Stage<
  "container",
  Partial<Pick<StageResult, "network" | "prompt" | "proxy" | "container">>,
  | NetworkRuntimeService
  | EnvoyService
  | SessionBrokerService
  | AuthRouterService,
  unknown
> {
  return createProxyStageWithOptions(shared);
}

export function createProxyStageWithOptions(
  shared: StageInput,
  options: ProxyStageOptions = {},
): Stage<
  "container",
  Partial<Pick<StageResult, "network" | "prompt" | "proxy" | "container">>,
  | NetworkRuntimeService
  | EnvoyService
  | SessionBrokerService
  | AuthRouterService,
  unknown
> {
  return {
    name: "ProxyStage",
    needs: ["container"],

    run(
      input,
    ): Effect.Effect<
      Partial<Pick<StageResult, "network" | "prompt" | "proxy" | "container">>,
      unknown,
      | Scope.Scope
      | NetworkRuntimeService
      | EnvoyService
      | SessionBrokerService
      | AuthRouterService
    > {
      const stageInput = {
        ...shared,
        ...input,
      };
      const plan = planProxy(stageInput, options);
      if (plan === null) {
        return Effect.succeed({});
      }
      return runProxy(plan);
    },
  };
}

// ---------------------------------------------------------------------------
// Effect runner
// ---------------------------------------------------------------------------

function runProxy(
  plan: ProxyPlan,
): Effect.Effect<
  Partial<Pick<StageResult, "network" | "prompt" | "proxy" | "container">>,
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

    return {
      ...plan.outputOverrides,
    };
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isProxyEnabled(input: StageInput): boolean {
  return (
    input.profile.network.allowlist.length > 0 ||
    input.profile.network.prompt.enable ||
    input.profile.network.proxy.forwardPorts.length > 0
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
  input: Pick<PipelineState, "container">,
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

function resolveContainerBase(
  input: Pick<PipelineState, "container">,
): ContainerPlan {
  return input.container;
}
