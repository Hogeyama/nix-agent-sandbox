/**
 * Proxy session effect.
 */

import { chmod, readFile, writeFile } from "node:fs/promises";
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
} from "../../docker/client.ts";
import {
  NAS_KIND_ENVOY,
  NAS_KIND_LABEL,
  NAS_KIND_SESSION_NETWORK,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "../../docker/nas_resources.ts";
import { resolveAsset } from "../../lib/asset.ts";
import { logInfo, logWarn } from "../../log.ts";
import { SessionBroker } from "../../network/broker.ts";
import { ensureAuthRouterDaemon } from "../../network/envoy_auth_router.ts";
import { generateSessionToken, hashToken } from "../../network/protocol.ts";
import {
  gcNetworkRuntime,
  removePendingDir,
  removeSessionRegistry,
  writeSessionRegistry,
} from "../../network/registry.ts";
import type { ProxySessionEffect } from "../types.ts";
import type { ResourceHandle } from "./types.ts";

interface ProxySessionNetworkHandle {
  close(): Promise<void>;
}

interface ProxySessionNetworkDeps {
  createSessionNetwork?: (networkName: string) => Promise<void>;
  connectNetwork?: (
    networkName: string,
    containerName: string,
    options?: { aliases?: string[] },
  ) => Promise<void>;
  disconnectNetwork?: (
    networkName: string,
    containerName: string,
  ) => Promise<void>;
  removeNetwork?: (networkName: string) => Promise<void>;
}

export async function executeProxySession(
  effect: ProxySessionEffect,
): Promise<ResourceHandle> {
  const {
    envoyContainerName,
    envoyImage,
    envoyReadyTimeoutMs,
    sessionId,
    sessionNetworkName,
    runtimePaths,
    brokerSocket,
    dindContainerName,
  } = effect;

  // GC stale sessions and render envoy config
  await gcNetworkRuntime(runtimePaths);
  await renderEnvoyConfig(runtimePaths);

  // Start session broker
  const broker = new SessionBroker({
    paths: runtimePaths,
    sessionId,
    allowlist: effect.allowlist,
    denylist: effect.denylist,
    promptEnabled: effect.promptEnabled,
    timeoutSeconds: effect.timeoutSeconds,
    defaultScope: effect.defaultScope,
    notify: effect.notify,
    uiEnabled: effect.uiEnabled,
    uiPort: effect.uiPort,
    uiIdleTimeout: effect.uiIdleTimeout,
    auditDir: effect.auditDir,
  });
  await broker.start(brokerSocket);

  // Generate token in executor (keeps plan() pure / free of CSPRNG calls)
  const token = effect.token ?? generateSessionToken();

  // Write session registry. If this fails, close broker to avoid leak.
  try {
    await writeSessionRegistry(runtimePaths, {
      version: 1,
      sessionId,
      tokenHash: await hashToken(token),
      brokerSocket,
      profileName: effect.profileName,
      allowlist: effect.allowlist,
      createdAt: new Date().toISOString(),
      pid: process.pid,
      promptEnabled: effect.promptEnabled,
      agent: effect.agent,
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

  // Remaining setup steps: if any fail, clean up broker + registry + auth-router
  let authRouterAbort: AbortController | null = null;
  let sessionNetworkHandle: ProxySessionNetworkHandle | null = null;
  try {
    // Ensure auth-router daemon
    authRouterAbort = await ensureAuthRouterDaemon(runtimePaths);

    // Ensure shared envoy container
    await ensureSharedEnvoy(
      runtimePaths,
      envoyContainerName,
      envoyImage,
      envoyReadyTimeoutMs,
    );

    sessionNetworkHandle = await createProxySessionNetworkHandle({
      sessionNetworkName,
      envoyContainerName,
      envoyAlias: effect.envoyAlias,
      dindContainerName,
    });
  } catch (error) {
    // Clean up resources that were successfully created
    if (authRouterAbort) {
      try {
        authRouterAbort.abort();
      } catch (cleanupErr) {
        logWarn(
          `[nas] Proxy: failed to abort auth-router during error recovery: ${
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr)
          }`,
        );
      }
    }
    if (sessionNetworkHandle) {
      try {
        await sessionNetworkHandle.close();
      } catch (cleanupErr) {
        logWarn(
          `[nas] Proxy: failed to tear down session network during error recovery: ${
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr)
          }`,
        );
      }
    }
    try {
      await removeSessionRegistry(runtimePaths, sessionId);
    } catch (cleanupErr) {
      logWarn(
        `[nas] Proxy: failed to remove session registry during error recovery: ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`,
      );
    }
    try {
      await broker.close();
    } catch (cleanupErr) {
      logWarn(
        `[nas] Proxy: failed to close broker during error recovery: ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`,
      );
    }
    throw error;
  }

  return {
    kind: "proxy-session",
    close: async () => {
      // Abort auth-router
      if (authRouterAbort) {
        authRouterAbort.abort();
      }

      // Close session broker
      await broker.close();

      // Remove session registry and pending dir
      await removeSessionRegistry(runtimePaths, sessionId).catch((e) =>
        logInfo(
          `[nas] Proxy teardown: failed to remove session registry: ${e}`,
        ),
      );
      await removePendingDir(runtimePaths, sessionId).catch((e) =>
        logInfo(`[nas] Proxy teardown: failed to remove pending dir: ${e}`),
      );

      if (sessionNetworkHandle) {
        await sessionNetworkHandle
          .close()
          .catch((e) =>
            logInfo(
              `[nas] Proxy teardown: failed to tear down session network: ${e}`,
            ),
          );
      }
    },
  };
}

export async function renderEnvoyConfig(
  paths: import("../../network/registry.ts").NetworkRuntimePaths,
): Promise<void> {
  const envoyTemplatePath = resolveAsset(
    "docker/envoy/envoy.template.yaml",
    import.meta.url,
    "../../docker/envoy/envoy.template.yaml",
  );
  const source = await readFile(envoyTemplatePath, "utf8");
  await writeFile(paths.envoyConfigFile, source, {
    mode: 0o644,
  });
  await chmod(paths.envoyConfigFile, 0o644).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOTSUP") {
      throw error;
    }
  });
}

async function ensureSessionNetwork(networkName: string): Promise<void> {
  await dockerNetworkCreateWithLabels(networkName, {
    internal: true,
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_SESSION_NETWORK,
    },
  });
}

export async function createProxySessionNetworkHandle(
  options: {
    sessionNetworkName: string;
    envoyContainerName: string;
    envoyAlias: string;
    dindContainerName?: string | null;
  },
  deps: ProxySessionNetworkDeps = {},
): Promise<ProxySessionNetworkHandle> {
  const createSessionNetwork =
    deps.createSessionNetwork ?? ensureSessionNetwork;
  const connectNetwork = deps.connectNetwork ?? dockerNetworkConnect;
  const disconnectNetwork = deps.disconnectNetwork ?? dockerNetworkDisconnect;
  const removeNetwork = deps.removeNetwork ?? dockerNetworkRemove;
  let sessionNetworkCreated = false;
  let envoyConnected = false;
  let dindConnected = false;

  try {
    try {
      await createSessionNetwork(options.sessionNetworkName);
      sessionNetworkCreated = true;
    } catch (error) {
      throw new Error(
        `[nas] Proxy: failed to create session network ${options.sessionNetworkName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      await connectNetwork(
        options.sessionNetworkName,
        options.envoyContainerName,
        {
          aliases: [options.envoyAlias],
        },
      );
      envoyConnected = true;
    } catch (error) {
      throw new Error(
        `[nas] Proxy: failed to connect envoy to session network ${options.sessionNetworkName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (options.dindContainerName) {
      try {
        await connectNetwork(
          options.sessionNetworkName,
          options.dindContainerName,
        );
        dindConnected = true;
      } catch (error) {
        throw new Error(
          `[nas] Proxy: failed to connect dind to session network ${options.sessionNetworkName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } catch (error) {
    await rollbackProxySessionNetwork({
      sessionNetworkName: options.sessionNetworkName,
      envoyContainerName: options.envoyContainerName,
      dindContainerName: options.dindContainerName ?? null,
      sessionNetworkCreated,
      envoyConnected,
      dindConnected,
      disconnectNetwork,
      removeNetwork,
    });
    throw error;
  }

  return {
    close: async () => {
      await teardownProxySessionNetwork({
        sessionNetworkName: options.sessionNetworkName,
        envoyContainerName: options.envoyContainerName,
        dindContainerName: options.dindContainerName ?? null,
        sessionNetworkCreated,
        envoyConnected,
        dindConnected,
        disconnectNetwork,
        removeNetwork,
      });
    },
  };
}

async function rollbackProxySessionNetwork(options: {
  sessionNetworkName: string;
  envoyContainerName: string;
  dindContainerName: string | null;
  sessionNetworkCreated: boolean;
  envoyConnected: boolean;
  dindConnected: boolean;
  disconnectNetwork: (
    networkName: string,
    containerName: string,
  ) => Promise<void>;
  removeNetwork: (networkName: string) => Promise<void>;
}): Promise<void> {
  if (options.dindConnected && options.dindContainerName) {
    await options
      .disconnectNetwork(options.sessionNetworkName, options.dindContainerName)
      .catch((error) =>
        logWarn(
          `[nas] Proxy: failed to disconnect dind during rollback: ${error}`,
        ),
      );
  }
  if (options.envoyConnected) {
    await options
      .disconnectNetwork(options.sessionNetworkName, options.envoyContainerName)
      .catch((error) =>
        logWarn(
          `[nas] Proxy: failed to disconnect envoy during rollback: ${error}`,
        ),
      );
  }
  if (options.sessionNetworkCreated) {
    await options
      .removeNetwork(options.sessionNetworkName)
      .catch((error) =>
        logWarn(
          `[nas] Proxy: failed to remove session network during rollback: ${error}`,
        ),
      );
  }
}

async function teardownProxySessionNetwork(options: {
  sessionNetworkName: string;
  envoyContainerName: string;
  dindContainerName: string | null;
  sessionNetworkCreated: boolean;
  envoyConnected: boolean;
  dindConnected: boolean;
  disconnectNetwork: (
    networkName: string,
    containerName: string,
  ) => Promise<void>;
  removeNetwork: (networkName: string) => Promise<void>;
}): Promise<void> {
  if (options.dindConnected && options.dindContainerName) {
    await options
      .disconnectNetwork(options.sessionNetworkName, options.dindContainerName)
      .catch((error) =>
        logInfo(
          `[nas] Proxy teardown: failed to disconnect dind from network: ${error}`,
        ),
      );
  }
  if (options.envoyConnected) {
    await options
      .disconnectNetwork(options.sessionNetworkName, options.envoyContainerName)
      .catch((error) =>
        logInfo(
          `[nas] Proxy teardown: failed to disconnect envoy from network: ${error}`,
        ),
      );
  }
  if (options.sessionNetworkCreated) {
    await options
      .removeNetwork(options.sessionNetworkName)
      .catch((error) =>
        logInfo(`[nas] Proxy teardown: failed to remove network: ${error}`),
      );
  }
}

export async function ensureSharedEnvoy(
  paths: import("../../network/registry.ts").NetworkRuntimePaths,
  envoyContainerName: string,
  envoyImage: string,
  readyTimeoutMs: number,
): Promise<void> {
  if (await dockerIsRunning(envoyContainerName)) {
    return;
  }
  if (await dockerContainerExists(envoyContainerName)) {
    await dockerRm(envoyContainerName).catch((e) =>
      logInfo(`[nas] Proxy: failed to remove stale envoy container: ${e}`),
    );
  }
  await dockerRunDetached({
    name: envoyContainerName,
    image: envoyImage,
    args: ["--add-host=host.docker.internal:host-gateway"],
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
    command: ["-c", "/nas-network/envoy.yaml", "--log-level", "info"],
  });
  await waitForEnvoyReady(envoyContainerName, readyTimeoutMs);
}

async function waitForEnvoyReady(
  envoyContainerName: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await dockerIsRunning(envoyContainerName)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Envoy sidecar failed to start:\n${await dockerLogs(envoyContainerName)}`,
  );
}
