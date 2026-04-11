/**
 * DinD (Docker-in-Docker) side-effect functions.
 *
 * Extracted from stages/dind.ts so that PlanStage (pure) and side-effectful
 * runtime helpers live in separate modules.
 */

import {
  dockerContainerIp,
  dockerExec,
  dockerIsRunning,
  dockerLogs,
  dockerNetworkConnect,
  dockerNetworkCreateWithLabels,
  dockerNetworkRemove,
  dockerRm,
  dockerRunDetached,
  dockerStop,
  dockerVolumeCreate,
  dockerVolumeRemove,
} from "./client.ts";
import {
  NAS_KIND_DIND,
  NAS_KIND_DIND_NETWORK,
  NAS_KIND_DIND_TMP,
  NAS_KIND_LABEL,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
  NAS_SHARED_LABEL,
} from "./nas_resources.ts";
import { logInfo, logWarn } from "../log.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DIND_IMAGE = "docker:dind-rootless";
export const DIND_INTERNAL_PORT = 2375;
export const DIND_CACHE_VOLUME = "nas-docker-cache";
export const DIND_DATA_DIR = "/home/rootless/.local/share/docker";
export const SHARED_CONTAINER_NAME = "nas-dind-shared";
export const SHARED_TMP_MOUNT_PATH = "/tmp/nas-shared";
export const READINESS_TIMEOUT_MS = 30_000;
export const READINESS_POLL_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Exported helper functions (called by effect executor)
// ---------------------------------------------------------------------------

export interface DindStageOptions {
  disableCache?: boolean;
  readinessTimeoutMs?: number;
}

export async function ensureSharedTmpWritable(
  containerName: string,
): Promise<void> {
  const result = await dockerExec(
    containerName,
    ["chmod", "1777", SHARED_TMP_MOUNT_PATH],
    { user: "0" },
  );
  if (result.code !== 0) {
    throw new Error(
      `Failed to make shared tmp writable: ${SHARED_TMP_MOUNT_PATH}`,
    );
  }
}

/** Create network (skip if exists) and connect container */
export async function ensureNetwork(
  networkName: string,
  containerName: string,
): Promise<void> {
  try {
    await dockerNetworkCreateWithLabels(networkName, {
      labels: {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_DIND_NETWORK,
      },
    });
    logInfo(`[nas] DinD: created network ${networkName}`);
  } catch {
    // Network may already exist; dax $`.quiet()` does not expose
    // Docker's stderr in the error object, so we cannot distinguish
    // "already exists" from other failures here. This matches the
    // original implementation which ignored all creation errors.
  }
  try {
    await dockerNetworkConnect(networkName, containerName);
  } catch {
    // Container may already be connected to this network.
    // Same limitation as above: dax error lacks Docker stderr.
  }
}

/**
 * Start the DinD sidecar.
 * Tries with cache volume first; on failure retries without cache.
 */
export async function startDindSidecar(
  containerName: string,
  sharedTmpVolume: string,
  options: DindStageOptions = {},
): Promise<void> {
  logInfo(`[nas] DinD: starting sidecar (${DIND_IMAGE})`);
  await dockerVolumeCreate(sharedTmpVolume, {
    [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
    [NAS_KIND_LABEL]: NAS_KIND_DIND_TMP,
  }).catch((e) =>
    logInfo(`[nas] DinD: failed to create shared tmp volume: ${e}`),
  );

  await runDindSidecar(containerName, sharedTmpVolume, options);
  logInfo("[nas] DinD: waiting for daemon to be ready...");
  try {
    await waitForDindReady(
      containerName,
      options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
    );
    logInfo("[nas] DinD: daemon is ready");
  } catch (e) {
    if (options.disableCache) {
      throw e;
    }
    logWarn(
      `[nas] DinD: failed to start with cache volume (${DIND_CACHE_VOLUME}), resetting cache and retrying...`,
    );
    // rootless DinD の状態ディレクトリが壊れていると起動できないため、
    // まずキャッシュ volume を作り直してから再試行する。
    await dockerStop(containerName, { timeoutSeconds: 0 }).catch((e) =>
      logInfo(`[nas] DinD: failed to stop container for cache reset: ${e}`),
    );
    await dockerRm(containerName).catch((e) =>
      logInfo(`[nas] DinD: failed to remove container for cache reset: ${e}`),
    );
    await dockerVolumeRemove(DIND_CACHE_VOLUME).catch((e) =>
      logInfo(`[nas] DinD: failed to remove cache volume: ${e}`),
    );

    await runDindSidecar(containerName, sharedTmpVolume, options);
    logInfo("[nas] DinD: waiting for daemon to be ready (fresh cache)...");
    try {
      await waitForDindReady(
        containerName,
        options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
      );
      logInfo("[nas] DinD: daemon is ready (fresh cache)");
      return;
    } catch (e) {
      logWarn(
        `[nas] DinD: fresh cache retry also failed (${
          e instanceof Error ? e.message : String(e)
        }), retrying without cache...`,
      );
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch((e) =>
        logInfo(
          `[nas] DinD: failed to stop container for no-cache retry: ${e}`,
        ),
      );
      await dockerRm(containerName).catch((e) =>
        logInfo(
          `[nas] DinD: failed to remove container for no-cache retry: ${e}`,
        ),
      );
    }

    await runDindSidecar(containerName, sharedTmpVolume, {
      ...options,
      disableCache: true,
    });
    logInfo("[nas] DinD: waiting for daemon to be ready (no cache)...");
    await waitForDindReady(
      containerName,
      options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
    );
    logInfo("[nas] DinD: daemon is ready (without cache)");

    void e;
  }
}

// ---------------------------------------------------------------------------
// Orchestration: ensureDindSidecar / teardownDindSidecar
// ---------------------------------------------------------------------------

/** Parameters for ensureDindSidecar (decoupled from effect types). */
export interface EnsureDindSidecarParams {
  containerName: string;
  sharedTmpVolume: string;
  networkName: string;
  shared: boolean;
  disableCache?: boolean;
  readinessTimeoutMs?: number;
}

/** Result of ensureDindSidecar. */
export interface EnsureDindSidecarResult {
  /** Whether a new sidecar was started (false when reusing shared). */
  sidecarStarted: boolean;
}

/**
 * Ensure a DinD sidecar is running: reuse shared if applicable,
 * start new if needed, configure shared tmp and network.
 * On error during post-start setup, cleans up the started sidecar.
 */
export async function ensureDindSidecar(
  params: EnsureDindSidecarParams,
): Promise<EnsureDindSidecarResult> {
  const {
    containerName,
    sharedTmpVolume,
    networkName,
    shared,
    disableCache,
    readinessTimeoutMs,
  } = params;

  const isReusingSharedSidecar =
    shared && (await dockerIsRunning(containerName));

  // 共有モード: 既に起動中ならサイドカー作成をスキップ
  let sidecarStarted = false;
  if (isReusingSharedSidecar) {
    logInfo(`[nas] DinD: reusing shared sidecar (${containerName})`);
  } else {
    // 共有モードで停止済みコンテナが残っている場合は削除して再作成
    if (shared) {
      await dockerRm(containerName).catch((e: unknown) =>
        logInfo(`[nas] DinD: failed to remove stale shared container: ${e}`),
      );
    }

    // DinD rootless サイドカーをデフォルト bridge で起動
    await startDindSidecar(containerName, sharedTmpVolume, {
      disableCache,
      readinessTimeoutMs,
    });
    sidecarStarted = true;
  }

  try {
    // 共有 tmp を全ユーザーから書き込み可能にする
    await ensureSharedTmpWritable(containerName);

    // カスタムネットワーク作成（既存ならスキップ）& サイドカー接続
    await ensureNetwork(networkName, containerName);
  } catch (error) {
    // 途中で失敗した場合、起動済みサイドカーをクリーンアップしてから再 throw
    if (sidecarStarted && !shared) {
      try {
        await dockerStop(containerName, { timeoutSeconds: 0 });
      } catch (cleanupErr) {
        logWarn(
          `[nas] DinD: cleanup failed (stop): ${
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr)
          }`,
        );
      }
      try {
        await dockerRm(containerName);
      } catch (cleanupErr) {
        logWarn(
          `[nas] DinD: cleanup failed (rm): ${
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr)
          }`,
        );
      }
    }
    throw error;
  }

  return { sidecarStarted };
}

/** Parameters for teardownDindSidecar (decoupled from effect types). */
export interface TeardownDindSidecarParams {
  containerName: string;
  networkName: string;
  sharedTmpVolume: string;
  shared: boolean;
}

/**
 * Tear down a DinD sidecar: stop/rm container, remove network and volume.
 * Shared sidecars are kept alive.
 */
export async function teardownDindSidecar(
  params: TeardownDindSidecarParams,
): Promise<void> {
  const { containerName, networkName, sharedTmpVolume, shared } = params;

  if (shared) {
    logInfo(`[nas] DinD: keeping shared sidecar (${containerName})`);
    return;
  }

  try {
    logInfo(`[nas] DinD: stopping sidecar ${containerName}`);
    await dockerStop(containerName, { timeoutSeconds: 0 });
  } catch (e: unknown) {
    logWarn(
      `[nas] DinD teardown: failed to stop container: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  try {
    await dockerRm(containerName);
  } catch (e: unknown) {
    logWarn(
      `[nas] DinD teardown: failed to remove container: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  try {
    logInfo(`[nas] DinD: removing network ${networkName}`);
    await dockerNetworkRemove(networkName);
  } catch (e: unknown) {
    logWarn(
      `[nas] DinD teardown: failed to remove network: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  try {
    logInfo(`[nas] DinD: removing volume ${sharedTmpVolume}`);
    await dockerVolumeRemove(sharedTmpVolume);
  } catch (e: unknown) {
    logWarn(
      `[nas] DinD teardown: failed to remove volume: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function runDindSidecar(
  containerName: string,
  sharedTmpVolume: string,
  options: DindStageOptions,
): Promise<void> {
  await dockerRunDetached({
    name: containerName,
    image: DIND_IMAGE,
    args: buildDindSidecarArgs(sharedTmpVolume, options),
    envVars: {
      DOCKER_TLS_CERTDIR: "",
    },
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_DIND,
      [NAS_SHARED_LABEL]: String(containerName === SHARED_CONTAINER_NAME),
    },
  });
}

/**
 * Build docker run arguments for the DinD sidecar container.
 */
export function buildDindSidecarArgs(
  sharedTmpVolume: string,
  options: DindStageOptions = {},
): string[] {
  const args = ["--privileged"];
  if (!options.disableCache) {
    args.push("-v", `${DIND_CACHE_VOLUME}:${DIND_DATA_DIR}`);
  }
  args.push("-v", `${sharedTmpVolume}:${SHARED_TMP_MOUNT_PATH}`);
  return args;
}

/**
 * Poll DinD sidecar readiness via TCP.
 *
 * docker exec bypasses ENTRYPOINT so DOCKER_HOST is not set.
 * rootlesskit's --copy-up=/run puts the unix socket in rootlesskit's
 * mount namespace, inaccessible from docker exec. However,
 * rootlesskit's --port-driver=builtin forwards the TCP port to the
 * container namespace, so tcp://127.0.0.1:2375 works.
 */
async function waitForDindReady(
  containerName: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let containerIp: string | null = null;
  while (Date.now() - start < timeoutMs) {
    // Check container is alive (fail fast on startup failure)
    const running = await dockerIsRunning(containerName);
    if (!running) {
      const logs = await dockerLogs(containerName, { tail: 50 });
      throw new Error(
        `DinD rootless container exited unexpectedly.\n--- container logs ---\n${logs}`,
      );
    }

    if (!containerIp) {
      containerIp = await dockerContainerIp(containerName);
    }

    // Detect daemon listen via TCP on bridge IP, then verify with docker info
    if (containerIp && (await canConnectTcp(containerIp, DIND_INTERNAL_PORT))) {
      const result = await dockerExec(containerName, [
        "docker",
        "-H",
        `tcp://127.0.0.1:${DIND_INTERNAL_PORT}`,
        "info",
      ]);
      if (result.code === 0) return;
    }

    await new Promise((r) => setTimeout(r, READINESS_POLL_INTERVAL_MS));
  }

  // On timeout, dump logs to help diagnose
  const logs = await dockerLogs(containerName, { tail: 50 });
  throw new Error(
    `DinD rootless failed to become ready within ${
      timeoutMs / 1000
    }s\n--- container logs ---\n${logs}`,
  );
}

async function canConnectTcp(hostname: string, port: number): Promise<boolean> {
  const { createConnection } = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: hostname, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
