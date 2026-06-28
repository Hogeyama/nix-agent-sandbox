/**
 * ProxyStage (EffectStage)
 *
 * 共有 Proxy コンテナ + session network + session broker を
 * セットアップし、エージェントコンテナのネットワークトラフィックを
 * reviewRules ベースで制御する。
 *
 * plan() は skip 判定と設定の計算のみ行い、run() は Effect.acquireRelease を
 * チェーンして各サブリソースのライフサイクルを管理する。
 */

import * as path from "node:path";
import { Effect, type Scope } from "effect";
import type { ReviewRule } from "../../config/types.ts";
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
import { CaService } from "./ca_service.ts";
import {
  type ForwardPortRelayHandle,
  ForwardPortRelayService,
} from "./forward_port_relay_service.ts";
import { NetworkRuntimeService } from "./network_runtime_service.ts";
import { ProxyService } from "./proxy_service.ts";
import {
  type SessionBrokerHandle,
  SessionBrokerService,
} from "./session_broker_service.ts";

const PROXY_IMAGE = "mitmproxy/mitmproxy:11";
const PROXY_CONTAINER_NAME = "nas-proxy-shared";
const PROXY_ALIAS = "nas-proxy";
const PROXY_PORT = 8080;
const PROXY_READY_TIMEOUT_MS = 15_000;
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
  readonly proxyContainerName: string;
  readonly proxyImage: string;
  readonly proxyAlias: string;
  readonly proxyPort: number;
  readonly proxyReadyTimeoutMs: number;
  readonly sessionId: string;
  readonly sessionNetworkName: string;
  readonly profileName: string;
  readonly agent: StageInput["profile"]["agent"];
  readonly runtimePaths: NetworkRuntimePaths;
  readonly brokerSocket: string;
  readonly token: string;
  readonly reviewRules: ReviewRule[];
  readonly pendingTimeoutSeconds: number;
  readonly pendingDefaultScope: import("../../network/protocol.ts").ApprovalScope;
  readonly pendingNotify: import("../../lib/notify_utils.ts").ResolvedNotifyBackend;
  readonly uiEnabled: boolean;
  readonly uiPort: number;
  readonly uiIdleTimeout: number;
  readonly auditDir: string;
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
  proxyContainerName?: string;
  generateSessionToken?: () => string;
}

export function planProxy(
  input: StageInput & Pick<PipelineState, "container" | "observability">,
  options: ProxyStageOptions = {},
): ProxyPlan {
  const proxyContainerName = options.proxyContainerName ?? PROXY_CONTAINER_NAME;
  const generateSessionToken =
    options.generateSessionToken ?? defaultGenerateToken;

  const runtimePaths = buildNetworkRuntimePaths(input.host);
  const brokerSocket = brokerSocketPath(runtimePaths, input.sessionId);
  const token = generateSessionToken();
  const sessionNetworkName = `nas-session-net-${input.sessionId}`;

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

  const proxyUrl = `http://${input.sessionId}:${token}@${PROXY_ALIAS}:${PROXY_PORT}`;
  const localProxyUrl = `http://127.0.0.1:${LOCAL_PROXY_PORT}`;
  // DinD's hostname is appended to no_proxy later by DindStage (which now runs
  // after ProxyStage); here we only seed the loopback baseline.
  const noProxyEntries = ["localhost", "127.0.0.1"];

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

  // CA cert mount for update-ca-certificates inside the agent container
  const caCertMount: MountSpec = {
    source: `${runtimePaths.caCertDir}/mitmproxy-ca-cert.pem`,
    target: "/usr/local/share/ca-certificates/nas-proxy.crt",
    readOnly: true,
  };

  const container = buildContainerState(input, {
    sessionNetworkName,
    envVars,
    extraMounts: [...forwardPortMounts, caCertMount],
  });

  const network: NetworkState = {
    networkName: sessionNetworkName,
    runtimeDir: runtimePaths.runtimeDir,
  };
  const promptState: PromptState = {
    promptToken: token,
  };
  const proxy: ProxyState = {
    brokerSocket,
    proxyEndpoint: proxyUrl,
  };

  return {
    proxyContainerName,
    proxyImage: PROXY_IMAGE,
    proxyAlias: PROXY_ALIAS,
    proxyPort: PROXY_PORT,
    proxyReadyTimeoutMs: PROXY_READY_TIMEOUT_MS,
    sessionId: input.sessionId,
    sessionNetworkName,
    profileName: input.profileName,
    agent: input.profile.agent,
    runtimePaths,
    brokerSocket,
    token,
    reviewRules: [...input.profile.network.reviewRules],
    pendingTimeoutSeconds: input.profile.network.pendingTimeoutSeconds,
    pendingDefaultScope: input.profile.network.pendingDefaultScope,
    pendingNotify: resolveNotifyBackend(input.profile.network.pendingNotify),
    uiEnabled: input.config.ui.enable,
    uiPort: input.config.ui.port,
    uiIdleTimeout: input.config.ui.idleTimeout,
    auditDir: input.probes.auditDir,
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
  | CaService
  | NetworkRuntimeService
  | ProxyService
  | SessionBrokerService
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
  | CaService
  | NetworkRuntimeService
  | ProxyService
  | SessionBrokerService
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
      | CaService
      | NetworkRuntimeService
      | ProxyService
      | SessionBrokerService
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
  | CaService
  | NetworkRuntimeService
  | ProxyService
  | SessionBrokerService
  | ForwardPortRelayService
> {
  return Effect.gen(function* () {
    const networkRuntime = yield* NetworkRuntimeService;
    const proxy = yield* ProxyService;
    const sessionBrokerService = yield* SessionBrokerService;
    const forwardPortRelayService = yield* ForwardPortRelayService;
    const caService = yield* CaService;

    // 1. Ensure runtime dirs exist (runtimeDir, sessions, pending, brokers,
    //    caCertDir, reviewRulesDir)
    yield* networkRuntime.ensureRuntimeDirs(plan.runtimePaths);

    // 2. GC stale sessions
    yield* networkRuntime.gcStaleRuntime(plan.runtimePaths);

    // 3. Ensure CA cert exists (generates via docker run --rm if missing)
    yield* caService.ensureCaCert(plan.runtimePaths, plan.proxyImage);

    // 4. Copy addon script to runtime dir
    yield* networkRuntime.copyAddonScript(plan.runtimePaths);

    // 5. Write per-session review rules
    yield* networkRuntime.writeReviewRules(
      plan.runtimePaths,
      plan.sessionId,
      plan.reviewRules,
    );

    // 6. Session broker + registry (acquireRelease)
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
        reviewRules: plan.reviewRules,
        pendingTimeoutSeconds: plan.pendingTimeoutSeconds,
        pendingDefaultScope: plan.pendingDefaultScope,
        pendingNotify: plan.pendingNotify,
        uiEnabled: plan.uiEnabled,
        uiPort: plan.uiPort,
        uiIdleTimeout: plan.uiIdleTimeout,
        auditDir: plan.auditDir,
        tokenHash,
      }),
      (handle: SessionBrokerHandle) => handle.close(),
    );

    // 7. Forward-port relays (acquireRelease).
    // Always called regardless of plan.forwardPorts.length: the live impl
    // fast-paths empty ports to a no-op.
    yield* Effect.acquireRelease(
      forwardPortRelayService.ensureRelays({
        runtimeDir: plan.runtimePaths.runtimeDir,
        sessionId: plan.sessionId,
        ports: plan.forwardPorts,
      }),
      (handle: ForwardPortRelayHandle) => handle.close(),
    );

    // 8. Shared proxy container (acquireRelease — no teardown since it's shared)
    yield* Effect.acquireRelease(
      proxy.ensureSharedProxy({
        proxyContainerName: plan.proxyContainerName,
        proxyImage: plan.proxyImage,
        runtimePaths: plan.runtimePaths,
        proxyReadyTimeoutMs: plan.proxyReadyTimeoutMs,
      }),
      () => Effect.void,
    );

    // 9. Session network + proxy connect (acquireRelease)
    yield* Effect.acquireRelease(
      proxy.createSessionNetwork({
        sessionNetworkName: plan.sessionNetworkName,
        proxyContainerName: plan.proxyContainerName,
        proxyAlias: plan.proxyAlias,
      }),
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
    caCertDir: path.join(runtimeDir, "mitmproxy-ca"),
    addonScriptPath: path.join(runtimeDir, "nas_addon.py"),
    reviewRulesDir: path.join(runtimeDir, "review-rules"),
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
