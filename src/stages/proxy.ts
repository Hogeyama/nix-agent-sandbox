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
import { logInfo, logWarn } from "../log.ts";
import { SessionBroker } from "../network/broker.ts";
import { ensureAuthRouterDaemon } from "../network/envoy_auth_router.ts";
import {
  generateSessionToken as defaultGenerateToken,
  hashToken,
} from "../network/protocol.ts";
import type { NetworkRuntimePaths } from "../network/registry.ts";
import {
  gcNetworkRuntime,
  removePendingDir,
  removeSessionRegistry,
  writeSessionRegistry,
} from "../network/registry.ts";
import {
  createProxySessionNetworkHandle,
  ensureSharedEnvoy,
  renderEnvoyConfig,
} from "../pipeline/effects/proxy.ts";
import type {
  EffectStage,
  EffectStageResult,
  HostEnv,
  StageInput,
} from "../pipeline/types.ts";
import type { DockerService } from "../services/docker.ts";
import type { FsService } from "../services/fs.ts";

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
  const token = input.prior.networkPromptToken ?? generateSessionToken();
  const sessionNetworkName = `nas-session-net-${input.sessionId}`;

  const dindContainerName = parseDindContainerName(input.prior.envVars);

  const proxyUrl = `http://${input.sessionId}:${token}@${ENVOY_ALIAS}:${ENVOY_PROXY_PORT}`;
  const localProxyUrl = `http://127.0.0.1:${LOCAL_PROXY_PORT}`;
  const noProxyEntries = ["localhost", "127.0.0.1"];
  if (dindContainerName) {
    noProxyEntries.push(dindContainerName);
  }

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
    envVars: {
      NAS_UPSTREAM_PROXY: proxyUrl,
      http_proxy: localProxyUrl,
      https_proxy: localProxyUrl,
      HTTP_PROXY: localProxyUrl,
      HTTPS_PROXY: localProxyUrl,
      no_proxy: noProxyEntries.join(","),
      NO_PROXY: noProxyEntries.join(","),
    },
    outputOverrides: {
      dockerArgs: replaceNetwork(
        [...input.prior.dockerArgs],
        sessionNetworkName,
      ),
      networkRuntimeDir: runtimePaths.runtimeDir,
      networkPromptToken: token,
      networkPromptEnabled: prompt.enable,
      networkBrokerSocket: brokerSocket,
      networkProxyEndpoint: proxyUrl,
    },
  };
}

// ---------------------------------------------------------------------------
// EffectStage
// ---------------------------------------------------------------------------

export function createProxyStage(
  options: ProxyStageOptions = {},
): EffectStage<FsService | DockerService> {
  return {
    kind: "effect",
    name: "ProxyStage",

    run(
      input: StageInput,
    ): Effect.Effect<
      EffectStageResult,
      unknown,
      Scope.Scope | FsService | DockerService
    > {
      const plan = planProxy(input, options);
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
  EffectStageResult,
  unknown,
  Scope.Scope | FsService | DockerService
> {
  return Effect.gen(function* () {
    // 1. GC stale sessions + render envoy config (via FsService)
    yield* Effect.tryPromise({
      try: () => gcNetworkRuntime(plan.runtimePaths),
      catch: (e) =>
        new Error(
          `GC network runtime failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
    });
    yield* Effect.tryPromise({
      try: () => renderEnvoyConfig(plan.runtimePaths),
      catch: (e) =>
        new Error(
          `Render envoy config failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
    });

    // 2. Session broker + registry (acquireRelease)
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const broker = new SessionBroker({
            paths: plan.runtimePaths,
            sessionId: plan.sessionId,
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
          });
          await broker.start(plan.brokerSocket);
          try {
            await writeSessionRegistry(plan.runtimePaths, {
              version: 1,
              sessionId: plan.sessionId,
              tokenHash: await hashToken(plan.token),
              brokerSocket: plan.brokerSocket,
              profileName: plan.profileName,
              allowlist: plan.allowlist,
              createdAt: new Date().toISOString(),
              pid: process.pid,
              promptEnabled: plan.promptEnabled,
              agent: plan.agent,
            });
          } catch (error) {
            try {
              await broker.close();
            } catch (closeErr) {
              logWarn(
                `[nas] Proxy: failed to close broker after registry write failure: ${closeErr}`,
              );
            }
            throw error;
          }
          return broker;
        },
        catch: (e) => e,
      }),
      (broker) =>
        Effect.tryPromise({
          try: async () => {
            await broker.close();
            await removeSessionRegistry(
              plan.runtimePaths,
              plan.sessionId,
            ).catch((e) =>
              logInfo(
                `[nas] Proxy teardown: failed to remove session registry: ${e}`,
              ),
            );
            await removePendingDir(plan.runtimePaths, plan.sessionId).catch(
              (e) =>
                logInfo(
                  `[nas] Proxy teardown: failed to remove pending dir: ${e}`,
                ),
            );
          },
          catch: (e) => e,
        }).pipe(Effect.ignoreLogged),
    );

    // 3. Auth-router daemon (acquireRelease)
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => ensureAuthRouterDaemon(plan.runtimePaths),
        catch: (e) =>
          new Error(
            `Auth-router daemon setup failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }),
      (abortController) =>
        Effect.sync(() => {
          if (abortController) {
            abortController.abort();
          }
        }),
    );

    // 4. Shared envoy container (acquireRelease — no teardown since it's shared)
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          ensureSharedEnvoy(
            plan.runtimePaths,
            plan.envoyContainerName,
            plan.envoyImage,
            plan.envoyReadyTimeoutMs,
          ),
        catch: (e) =>
          new Error(
            `Shared envoy setup failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }),
      () => Effect.void,
    );

    // 5. Session network + envoy/dind connect (acquireRelease)
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          createProxySessionNetworkHandle({
            sessionNetworkName: plan.sessionNetworkName,
            envoyContainerName: plan.envoyContainerName,
            envoyAlias: plan.envoyAlias,
            dindContainerName: plan.dindContainerName,
          }),
        catch: (e) =>
          new Error(
            `Session network setup failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (e) => e,
        }).pipe(Effect.ignoreLogged),
    );

    return {
      ...plan.outputOverrides,
      envVars: plan.envVars,
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
