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
import { resolveNotifyBackend } from "../../lib/notify_utils.ts";
import { forwardPortSocketPath } from "../../network/forward_port_relay.ts";
import {
  generateSessionToken as defaultGenerateToken,
  hashToken,
} from "../../network/protocol.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { brokerSocketPath } from "../../network/registry.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type {
  ContainerPlan,
  MountSpec,
  NetworkState,
  PipelineState,
  PromptState,
  ProxyState,
} from "../../pipeline/state.ts";
import type { HostEnv, StageInput, StageResult } from "../../pipeline/types.ts";
import {
  type AuthRouterHandle,
  AuthRouterService,
} from "./auth_router_service.ts";
import { EnvoyService } from "./envoy_service.ts";
import {
  type ForwardPortRelayHandle,
  ForwardPortRelayService,
} from "./forward_port_relay_service.ts";
import { NetworkRuntimeService } from "./network_runtime_service.ts";
import {
  type SessionBrokerHandle,
  SessionBrokerService,
} from "./session_broker_service.ts";

const ENVOY_IMAGE = "envoyproxy/envoy:v1.37.1";
const ENVOY_CONTAINER_NAME = "nas-envoy-shared";
const ENVOY_ALIAS = "nas-envoy";
const ENVOY_PROXY_PORT = 15001;
const ENVOY_READY_TIMEOUT_MS = 15_000;
export const LOCAL_PROXY_PORT = 18080;

/**
 * Mount target directory inside the agent container where per-port forward-port
 * UDS sockets are bind-mounted. The local-proxy resolves connect attempts to
 * `<FORWARD_PORT_SOCKET_DIR_IN_CONTAINER>/<port>.sock`. The value is exposed
 * to the container via `NAS_FORWARD_PORT_SOCKET_DIR` and MUST match the mount
 * targets we generate for each port — drift would cause socket lookup failure.
 */
const FORWARD_PORT_SOCKET_DIR_IN_CONTAINER = "/run/nas-fp";

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
  readonly defaultScope: import("../../network/protocol.ts").ApprovalScope;
  readonly notify: import("../../lib/notify_utils.ts").ResolvedNotifyBackend;
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
  readonly forwardPorts: ReadonlyArray<number>;
}

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

export interface ProxyStageOptions {
  envoyContainerName?: string;
  generateSessionToken?: () => string;
}

export function planProxy(
  input: StageInput & Pick<PipelineState, "container" | "observability">,
  options: ProxyStageOptions = {},
): ProxyPlan {
  const envoyContainerName = options.envoyContainerName ?? ENVOY_CONTAINER_NAME;
  const generateSessionToken =
    options.generateSessionToken ?? defaultGenerateToken;

  const runtimePaths = buildNetworkRuntimePaths(input.host);
  const brokerSocket = brokerSocketPath(runtimePaths, input.sessionId);
  const prompt = input.profile.network.prompt;
  const token = generateSessionToken();
  const sessionNetworkName = `nas-session-net-${input.sessionId}`;

  const dindContainerName =
    input.container.env.static.NAS_DIND_CONTAINER_NAME ?? null;

  // The observability slice contributes its receiver port (when enabled) to
  // the forward-ports set, alongside whatever the profile declares. We dedup
  // before downstream so the relay layer never sees a duplicate entry — its
  // duplicate-port contract throws, which would otherwise break sessions
  // whose profile explicitly listed the same port.
  const baseForwardPorts = input.profile.network.proxy.forwardPorts;
  const observabilityPort = input.observability.enabled
    ? input.observability.receiverPort
    : null;
  const forwardPorts =
    observabilityPort !== null
      ? Array.from(new Set([...baseForwardPorts, observabilityPort]))
      : baseForwardPorts;

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

  // forward-port mounts/env are gated on `forwardPorts.length > 0` so the
  // fast path (no forward-ports declared) adds neither the dir env nor any
  // bind-mounts. The socket source paths are computed via the canonical pure
  // helper exported by forward_port_relay.ts; that same helper drives the
  // actual relay listener path inside ForwardPortRelayService, so plan-time
  // and runtime paths cannot drift.
  const forwardPortMounts: MountSpec[] = [];
  if (forwardPorts.length > 0) {
    envVars.NAS_FORWARD_PORTS = forwardPorts.join(",");
    envVars.NAS_FORWARD_PORT_SOCKET_DIR = FORWARD_PORT_SOCKET_DIR_IN_CONTAINER;
    for (const port of forwardPorts) {
      forwardPortMounts.push({
        source: forwardPortSocketPath(
          runtimePaths.runtimeDir,
          input.sessionId,
          port,
        ),
        target: `${FORWARD_PORT_SOCKET_DIR_IN_CONTAINER}/${port}.sock`,
        // UDS connect requires write permission on the socket file.
        readOnly: false,
      });
    }
  }

  const container = buildContainerState(input, {
    sessionNetworkName,
    envVars,
    extraMounts: forwardPortMounts,
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
    allowlist: [...input.profile.network.allowlist],
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
    forwardPorts,
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
  "container" | "observability",
  Partial<Pick<StageResult, "network" | "prompt" | "proxy" | "container">>,
  | NetworkRuntimeService
  | EnvoyService
  | SessionBrokerService
  | AuthRouterService
  | ForwardPortRelayService,
  unknown
> {
  return createProxyStageWithOptions(shared);
}

export function createProxyStageWithOptions(
  shared: StageInput,
  options: ProxyStageOptions = {},
): Stage<
  "container" | "observability",
  Partial<Pick<StageResult, "network" | "prompt" | "proxy" | "container">>,
  | NetworkRuntimeService
  | EnvoyService
  | SessionBrokerService
  | AuthRouterService
  | ForwardPortRelayService,
  unknown
> {
  return {
    name: "ProxyStage",
    needs: ["container", "observability"],

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
      | ForwardPortRelayService
    > {
      const stageInput = {
        ...shared,
        ...input,
      };
      const plan = planProxy(stageInput, options);
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
  | ForwardPortRelayService
> {
  return Effect.gen(function* () {
    const networkRuntime = yield* NetworkRuntimeService;
    const envoy = yield* EnvoyService;
    const sessionBrokerService = yield* SessionBrokerService;
    const authRouterService = yield* AuthRouterService;
    const forwardPortRelayService = yield* ForwardPortRelayService;

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

    // 5. Forward-port relays (acquireRelease).
    // Always called regardless of plan.forwardPorts.length: the live impl
    // fast-paths empty ports to a no-op.
    //
    // Placement between auth-router and shared-envoy is intentional. LIFO
    // release closes shared-envoy first, which stops the agent container
    // from sending new traffic; the relays are then idle and safe to close.
    // Closing relays before envoy would instead kill in-flight forward-port
    // connections while other envoy-routed traffic is still live.
    //
    // Relays do not depend on the auth-router daemon's UDS, but they do
    // depend on `runtimeDir` existing on disk. Releasing relays before the
    // auth-router release keeps relays clear of any runtimeDir cleanup the
    // auth-router teardown may perform.
    yield* Effect.acquireRelease(
      forwardPortRelayService.ensureRelays({
        runtimeDir: plan.runtimePaths.runtimeDir,
        sessionId: plan.sessionId,
        ports: plan.forwardPorts,
      }),
      (handle: ForwardPortRelayHandle) => handle.close(),
    );

    // 6. Shared envoy container (acquireRelease — no teardown since it's shared)
    yield* Effect.acquireRelease(
      envoy.ensureSharedEnvoy(plan),
      () => Effect.void,
    );

    // 7. Session network + envoy/dind connect (acquireRelease)
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
    readonly extraMounts?: ReadonlyArray<MountSpec>;
  },
): ContainerPlan {
  return mergeContainerPlan(resolveContainerBase(input), {
    env: { static: config.envVars },
    network: { name: config.sessionNetworkName },
    // Skip the mounts patch entirely when there's nothing to add; passing an
    // empty array still triggers mergeContainerPlan's append branch (a no-op
    // here), but keeping the patch keyless makes intent clearer.
    ...(config.extraMounts && config.extraMounts.length > 0
      ? { mounts: config.extraMounts }
      : {}),
  });
}

function resolveContainerBase(
  input: Pick<PipelineState, "container">,
): ContainerPlan {
  return input.container;
}
