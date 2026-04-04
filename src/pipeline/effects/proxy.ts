/**
 * Proxy session effect.
 */

import type { ProxySessionEffect } from "../types.ts";
import type { ResourceHandle } from "./types.ts";
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
import { SessionBroker } from "../../network/broker.ts";
import { ensureAuthRouterDaemon } from "../../network/envoy_auth_router.ts";
import {
  gcNetworkRuntime,
  removePendingDir,
  removeSessionRegistry,
  writeSessionRegistry,
} from "../../network/registry.ts";
import { generateSessionToken, hashToken } from "../../network/protocol.ts";
import { logInfo, logWarn } from "../../log.ts";

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
      pid: Deno.pid,
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

    // Create session network and connect envoy
    await ensureSessionNetwork(sessionNetworkName);
    await dockerNetworkConnect(sessionNetworkName, envoyContainerName, {
      aliases: [effect.envoyAlias],
    }).catch((e) =>
      logInfo(`[nas] Proxy: failed to connect envoy to network: ${e}`)
    );

    // Connect DinD container if present
    if (dindContainerName) {
      await dockerNetworkConnect(sessionNetworkName, dindContainerName)
        .catch((e) =>
          logInfo(`[nas] Proxy: failed to connect dind to network: ${e}`)
        );
    }
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
        )
      );
      await removePendingDir(runtimePaths, sessionId).catch((e) =>
        logInfo(
          `[nas] Proxy teardown: failed to remove pending dir: ${e}`,
        )
      );

      // Disconnect and remove session network
      await dockerNetworkDisconnect(sessionNetworkName, envoyContainerName)
        .catch((e) =>
          logInfo(
            `[nas] Proxy teardown: failed to disconnect envoy from network: ${e}`,
          )
        );
      if (dindContainerName) {
        await dockerNetworkDisconnect(sessionNetworkName, dindContainerName)
          .catch((e) =>
            logInfo(
              `[nas] Proxy teardown: failed to disconnect dind from network: ${e}`,
            )
          );
      }
      await dockerNetworkRemove(sessionNetworkName).catch((e) =>
        logInfo(`[nas] Proxy teardown: failed to remove network: ${e}`)
      );
    },
  };
}

async function renderEnvoyConfig(
  paths: import("../../network/registry.ts").NetworkRuntimePaths,
): Promise<void> {
  const source = await Deno.readTextFile(
    new URL("../../docker/envoy/envoy.template.yaml", import.meta.url),
  );
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
    // Network may already exist; dax $`.quiet()` does not expose
    // Docker's stderr in the error object, so we cannot distinguish
    // "already exists" from other failures. Matches original behavior.
  }
}

async function ensureSharedEnvoy(
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
      logInfo(`[nas] Proxy: failed to remove stale envoy container: ${e}`)
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
    command: [
      "-c",
      "/nas-network/envoy.yaml",
      "--log-level",
      "info",
    ],
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
