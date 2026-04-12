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
import {
  NAS_KIND_ENVOY,
  NAS_KIND_LABEL,
  NAS_KIND_SESSION_NETWORK,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "../docker/nas_resources.ts";
import { resolveAsset } from "../lib/asset.ts";
import { resolveNotifyBackend } from "../lib/notify_utils.ts";
import { logInfo } from "../log.ts";
import {
  generateSessionToken as defaultGenerateToken,
  hashToken,
} from "../network/protocol.ts";
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
import { DockerService } from "../services/docker.ts";
import { FsService } from "../services/fs.ts";
import { ProcessService } from "../services/process.ts";
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
      networkName: sessionNetworkName,
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
): EffectStage<
  | FsService
  | ProcessService
  | DockerService
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
      | FsService
      | ProcessService
      | DockerService
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
  | FsService
  | ProcessService
  | DockerService
  | SessionBrokerService
  | AuthRouterService
> {
  return Effect.gen(function* () {
    const fs = yield* FsService;
    const proc = yield* ProcessService;
    const docker = yield* DockerService;
    const sessionBrokerService = yield* SessionBrokerService;
    const authRouterService = yield* AuthRouterService;

    // 1. GC stale sessions (read PID file, check alive, remove stale files)
    yield* gcNetworkRuntimeEffect(fs, proc, plan.runtimePaths);

    // 2. Render envoy config (read template + write config)
    yield* renderEnvoyConfigEffect(fs, plan.runtimePaths);

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
      ensureSharedEnvoyEffect(docker, plan),
      () => Effect.void,
    );

    // 6. Session network + envoy/dind connect (acquireRelease)
    yield* Effect.acquireRelease(
      createSessionNetworkEffect(docker, plan),
      (teardown: () => Effect.Effect<void>) => teardown(),
    );

    return {
      ...plan.outputOverrides,
      dockerArgs: replaceNetwork(
        [...input.prior.dockerArgs],
        plan.sessionNetworkName,
      ),
      envVars: { ...input.prior.envVars, ...plan.envVars },
    };
  });
}

// ---------------------------------------------------------------------------
// Service-based helpers (replacing direct I/O)
// ---------------------------------------------------------------------------

function gcNetworkRuntimeEffect(
  fs: Effect.Effect.Success<typeof FsService>,
  proc: Effect.Effect.Success<typeof ProcessService>,
  paths: NetworkRuntimePaths,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const pidFileExists = yield* fs.exists(paths.authRouterPidFile);
    if (!pidFileExists) return;

    const pidStr = yield* fs.readFile(paths.authRouterPidFile);
    const pid = Number.parseInt(pidStr.trim(), 10);
    if (Number.isNaN(pid)) {
      yield* fs.rm(paths.authRouterPidFile, { force: true });
      yield* fs
        .rm(paths.authRouterSocket, { force: true })
        .pipe(Effect.catchAll(() => Effect.void));
      return;
    }

    const alive = yield* proc.exec(["kill", "-0", pid.toString()]).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    );

    if (!alive) {
      yield* fs
        .rm(paths.authRouterSocket, { force: true })
        .pipe(Effect.catchAll(() => Effect.void));
      yield* fs
        .rm(paths.authRouterPidFile, { force: true })
        .pipe(Effect.catchAll(() => Effect.void));
    }
  });
}

function renderEnvoyConfigEffect(
  fs: Effect.Effect.Success<typeof FsService>,
  paths: NetworkRuntimePaths,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const envoyTemplatePath = resolveAsset(
      "docker/envoy/envoy.template.yaml",
      import.meta.url,
      "../docker/envoy/envoy.template.yaml",
    );
    const source = yield* fs.readFile(envoyTemplatePath);
    yield* fs.writeFile(paths.envoyConfigFile, source, { mode: 0o644 });
  });
}

function ensureSharedEnvoyEffect(
  docker: Effect.Effect.Success<typeof DockerService>,
  plan: ProxyPlan,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const running = yield* docker.isRunning(plan.envoyContainerName);
    if (running) return;

    const exists = yield* docker.containerExists(plan.envoyContainerName);
    if (exists) {
      yield* docker
        .rm(plan.envoyContainerName)
        .pipe(
          Effect.catchAll((e) =>
            Effect.sync(() =>
              logInfo(
                `[nas] Proxy: failed to remove stale envoy container: ${e}`,
              ),
            ),
          ),
        );
    }

    yield* docker.runDetached({
      name: plan.envoyContainerName,
      image: plan.envoyImage,
      args: ["--add-host=host.docker.internal:host-gateway"],
      envVars: {},
      mounts: [
        {
          source: plan.runtimePaths.runtimeDir,
          target: "/nas-network",
          mode: "rw",
        },
      ],
      labels: {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_ENVOY,
      },
      command: ["-c", "/nas-network/envoy.yaml", "--log-level", "info"],
    });

    yield* waitForEnvoyReadyEffect(docker, plan);
  });
}

function waitForEnvoyReadyEffect(
  docker: Effect.Effect.Success<typeof DockerService>,
  plan: ProxyPlan,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const started = Date.now();
    while (Date.now() - started < plan.envoyReadyTimeoutMs) {
      const running = yield* docker.isRunning(plan.envoyContainerName);
      if (running) return;
      yield* Effect.sleep("200 millis");
    }
    const logs = yield* docker.logs(plan.envoyContainerName);
    yield* Effect.fail(new Error(`Envoy sidecar failed to start:\n${logs}`));
  });
}

function createSessionNetworkEffect(
  docker: Effect.Effect.Success<typeof DockerService>,
  plan: ProxyPlan,
): Effect.Effect<() => Effect.Effect<void>> {
  return Effect.gen(function* () {
    let envoyConnected = false;
    let dindConnected = false;

    yield* docker.networkCreate(plan.sessionNetworkName, {
      internal: true,
      labels: {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_SESSION_NETWORK,
      },
    });

    yield* docker.networkConnect(
      plan.sessionNetworkName,
      plan.envoyContainerName,
      { aliases: [plan.envoyAlias] },
    );
    envoyConnected = true;

    if (plan.dindContainerName) {
      yield* docker.networkConnect(
        plan.sessionNetworkName,
        plan.dindContainerName,
      );
      dindConnected = true;
    }

    const teardown = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (dindConnected && plan.dindContainerName) {
          yield* docker
            .networkDisconnect(plan.sessionNetworkName, plan.dindContainerName)
            .pipe(
              Effect.catchAll((e) =>
                Effect.sync(() =>
                  logInfo(
                    `[nas] Proxy teardown: failed to disconnect dind from network: ${e}`,
                  ),
                ),
              ),
            );
        }
        if (envoyConnected) {
          yield* docker
            .networkDisconnect(plan.sessionNetworkName, plan.envoyContainerName)
            .pipe(
              Effect.catchAll((e) =>
                Effect.sync(() =>
                  logInfo(
                    `[nas] Proxy teardown: failed to disconnect envoy from network: ${e}`,
                  ),
                ),
              ),
            );
        }
        yield* docker
          .networkRemove(plan.sessionNetworkName)
          .pipe(
            Effect.catchAll((e) =>
              Effect.sync(() =>
                logInfo(`[nas] Proxy teardown: failed to remove network: ${e}`),
              ),
            ),
          );
      });

    return teardown;
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
