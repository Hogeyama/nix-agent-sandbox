import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import {
  dockerContainerExists,
  dockerIsRunning,
  dockerLogs,
  dockerNetworkConnect,
  dockerNetworkCreateWithLabels,
  dockerNetworkDisconnect,
  dockerNetworkRemove,
  dockerRm,
  dockerRunDetached,
} from "../docker/client.ts";
import {
  NAS_KIND_ENVOY,
  NAS_KIND_LABEL,
  NAS_KIND_SESSION_NETWORK,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "../docker/nas_resources.ts";
import { SessionBroker } from "../network/broker.ts";
import { ensureAuthRouterDaemon } from "../network/envoy_auth_router.ts";
import {
  brokerSocketPath,
  gcNetworkRuntime,
  type NetworkRuntimePaths,
  removePendingDir,
  removeSessionRegistry,
  resolveNetworkRuntimePaths,
  writeSessionRegistry,
} from "../network/registry.ts";
import { generateSessionToken } from "../network/protocol.ts";
import { logInfo } from "../log.ts";

const ENVOY_IMAGE = "envoyproxy/envoy:v1.37.1";
const ENVOY_CONTAINER_NAME = "nas-envoy-shared";
const ENVOY_ALIAS = "nas-envoy";
const ENVOY_PROXY_PORT = 15001;
const ENVOY_READY_TIMEOUT_MS = 15_000;

interface ProxyStageOptions {
  envoyContainerName?: string;
}

export class ProxyStage implements Stage {
  name = "ProxyStage";

  private runtimePaths: NetworkRuntimePaths | null = null;
  private networkName: string | null = null;
  private dindContainerName: string | null = null;
  private broker: SessionBroker | null = null;
  private authRouterAbort: AbortController | null = null;
  private readonly envoyContainerName: string;

  constructor(options: ProxyStageOptions = {}) {
    this.envoyContainerName = options.envoyContainerName ??
      ENVOY_CONTAINER_NAME;
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    if (!isProxyEnabled(ctx)) {
      logInfo("[nas] Proxy: skipped (allowlist/prompt disabled)");
      return ctx;
    }

    const runtimePaths = await resolveNetworkRuntimePaths();
    this.runtimePaths = runtimePaths;
    await gcNetworkRuntime(runtimePaths);
    await renderEnvoyConfig(runtimePaths);

    const brokerSocket = brokerSocketPath(runtimePaths, ctx.sessionId);
    const prompt = ctx.profile.network.prompt;
    const broker = new SessionBroker({
      paths: runtimePaths,
      sessionId: ctx.sessionId,
      allowlist: ctx.profile.network.allowlist,
      denylist: prompt.denylist,
      promptEnabled: prompt.enable,
      timeoutSeconds: prompt.timeoutSeconds,
      defaultScope: prompt.defaultScope,
      notify: prompt.notify,
    });
    await broker.start(brokerSocket);
    this.broker = broker;

    const token = ctx.networkPromptToken ?? generateSessionToken();
    await writeSessionRegistry(runtimePaths, {
      version: 1,
      sessionId: ctx.sessionId,
      tokenHash: await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token),
      )
        .then((digest) =>
          "sha256:" + Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")
        ),
      brokerSocket,
      profileName: ctx.profileName,
      allowlist: ctx.profile.network.allowlist,
      createdAt: new Date().toISOString(),
      pid: Deno.pid,
      promptEnabled: prompt.enable,
      agent: ctx.profile.agent,
    });

    this.authRouterAbort = await ensureAuthRouterDaemon(runtimePaths);
    await ensureSharedEnvoy(runtimePaths, this.envoyContainerName);

    this.networkName = `nas-session-net-${ctx.sessionId}`;
    await ensureSessionNetwork(this.networkName);
    await dockerNetworkConnect(this.networkName, this.envoyContainerName, {
      aliases: [ENVOY_ALIAS],
    }).catch((e) =>
      logInfo(`[nas] Proxy: failed to connect envoy to network: ${e}`)
    );

    this.dindContainerName = parseDindContainerName(ctx.envVars);
    if (this.dindContainerName) {
      await dockerNetworkConnect(this.networkName, this.dindContainerName)
        .catch((e) =>
          logInfo(`[nas] Proxy: failed to connect dind to network: ${e}`)
        );
    }

    const proxyUrl =
      `http://${ctx.sessionId}:${token}@${ENVOY_ALIAS}:${ENVOY_PROXY_PORT}`;
    const noProxyEntries = ["localhost", "127.0.0.1"];
    if (this.dindContainerName) {
      noProxyEntries.push(this.dindContainerName);
    }

    return {
      ...ctx,
      dockerArgs: replaceNetwork(ctx.dockerArgs, this.networkName),
      envVars: {
        ...ctx.envVars,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        no_proxy: noProxyEntries.join(","),
        NO_PROXY: noProxyEntries.join(","),
      },
      networkRuntimeDir: runtimePaths.runtimeDir,
      networkPromptToken: token,
      networkPromptEnabled: prompt.enable,
      networkBrokerSocket: brokerSocket,
      networkProxyEndpoint: proxyUrl,
    };
  }

  async teardown(ctx: ExecutionContext): Promise<void> {
    if (!this.runtimePaths) return;

    if (this.authRouterAbort) {
      this.authRouterAbort.abort();
      this.authRouterAbort = null;
    }

    if (this.broker) {
      await this.broker.close();
      this.broker = null;
    }

    await removeSessionRegistry(this.runtimePaths, ctx.sessionId);
    await removePendingDir(this.runtimePaths, ctx.sessionId);

    if (this.networkName) {
      await dockerNetworkDisconnect(this.networkName, this.envoyContainerName)
        .catch((e) =>
          logInfo(
            `[nas] Proxy teardown: failed to disconnect envoy from network: ${e}`,
          )
        );
      if (this.dindContainerName) {
        await dockerNetworkDisconnect(this.networkName, this.dindContainerName)
          .catch((e) =>
            logInfo(
              `[nas] Proxy teardown: failed to disconnect dind from network: ${e}`,
            )
          );
      }
      await dockerNetworkRemove(this.networkName).catch((e) =>
        logInfo(`[nas] Proxy teardown: failed to remove network: ${e}`)
      );
    }
  }
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
  envVars: Record<string, string>,
): string | null {
  const explicitName = envVars["NAS_DIND_CONTAINER_NAME"];
  if (explicitName && explicitName.trim() !== "") {
    return explicitName;
  }
  const dockerHost = envVars["DOCKER_HOST"];
  if (!dockerHost) return null;
  const match = dockerHost.match(/^tcp:\/\/([^:]+):\d+$/);
  return match ? match[1] : null;
}

function isProxyEnabled(ctx: ExecutionContext): boolean {
  return ctx.profile.network.allowlist.length > 0 ||
    ctx.profile.network.prompt.enable;
}

async function renderEnvoyConfig(paths: NetworkRuntimePaths): Promise<void> {
  const source = await Deno.readTextFile(
    new URL("../docker/envoy/envoy.template.yaml", import.meta.url),
  );
  // Envoy runs as a non-owner user in the image, so the bind-mounted config
  // must be world-readable even when an older file already exists.
  await Deno.writeTextFile(paths.envoyConfigFile, source, {
    create: true,
    mode: 0o644,
  });
  await Deno.chmod(paths.envoyConfigFile, 0o644).catch((error) => {
    if (!(error instanceof Deno.errors.NotSupported)) {
      throw error;
    }
  });
}

async function ensureSessionNetwork(networkName: string): Promise<void> {
  try {
    await dockerNetworkCreateWithLabels(networkName, {
      internal: true,
      labels: {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_SESSION_NETWORK,
      },
    });
  } catch {
    // Already exists.
  }
}

async function ensureSharedEnvoy(
  paths: NetworkRuntimePaths,
  envoyContainerName: string,
): Promise<void> {
  if (await dockerIsRunning(envoyContainerName)) {
    return;
  }
  if (await dockerContainerExists(envoyContainerName)) {
    await dockerRm(envoyContainerName).catch((e) =>
      logInfo(`[nas] Proxy: failed to remove stale envoy container: ${e}`)
    );
  }
  await dockerRunDetached({
    name: envoyContainerName,
    image: ENVOY_IMAGE,
    args: [],
    envVars: {},
    mounts: [
      {
        source: paths.runtimeDir,
        target: "/nas-network",
        mode: "rw",
      },
    ],
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_ENVOY,
    },
    command: [
      "-c",
      "/nas-network/envoy.yaml",
      "--log-level",
      "warning",
    ],
  });
  await waitForEnvoyReady(envoyContainerName);
}

async function waitForEnvoyReady(envoyContainerName: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ENVOY_READY_TIMEOUT_MS) {
    if (await dockerIsRunning(envoyContainerName)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Envoy sidecar failed to start:\n${await dockerLogs(envoyContainerName)}`,
  );
}
