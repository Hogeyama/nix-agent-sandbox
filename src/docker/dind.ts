/**
 * DinD (Docker-in-Docker) side-effect functions.
 *
 * Extracted from stages/dind.ts so that stage logic and side-effectful
 * runtime helpers live in separate modules.
 */

import { logInfo, logWarn } from "../log.ts";
import {
  dockerContainerIp,
  dockerExec,
  dockerIsRunning,
  dockerLogs,
  dockerNetworkConnect,
  dockerNetworkDisconnect,
  dockerRm,
  dockerRunDetached,
  dockerStop,
  dockerVolumeCreate,
  dockerVolumeRemove,
} from "./client.ts";
import {
  NAS_KIND_DIND,
  NAS_KIND_DIND_TMP,
  NAS_KIND_LABEL,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
  NAS_SHARED_LABEL,
} from "./nas_resources.ts";

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

/**
 * Start the DinD sidecar.
 * Tries with cache volume first; on failure retries without cache.
 *
 * `proxyEndpoint` is injected into dockerd's HTTP(S)_PROXY env so that image
 * pulls from inside DinD are forced through the session proxy. It is independent
 * of `DindStageOptions` (which only controls cache/readiness) so that the
 * cache-reset retry paths below re-pass the same proxy config verbatim.
 */
export async function startDindSidecar(
  containerName: string,
  sharedTmpVolume: string,
  proxyEndpoint: string,
  options: DindStageOptions = {},
): Promise<void> {
  logInfo(`[nas] DinD: starting sidecar (${DIND_IMAGE})`);
  await dockerVolumeCreate(sharedTmpVolume, {
    [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
    [NAS_KIND_LABEL]: NAS_KIND_DIND_TMP,
  }).catch((e) =>
    logInfo(`[nas] DinD: failed to create shared tmp volume: ${e}`),
  );

  await runDindSidecar(containerName, sharedTmpVolume, proxyEndpoint, options);
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

    await runDindSidecar(
      containerName,
      sharedTmpVolume,
      proxyEndpoint,
      options,
    );
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

    await runDindSidecar(containerName, sharedTmpVolume, proxyEndpoint, {
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
  /**
   * Name of the (internal) session network the sidecar is attached to. After
   * the sidecar boots on the default bridge, it is connected to this network
   * and the bridge is then severed so all sidecar egress is funnelled through
   * the proxy (reachable via the session network's embedded DNS).
   */
  sessionNetworkName: string;
  /** dockerd HTTP(S)_PROXY endpoint (token-bearing proxy URL). */
  proxyEndpoint: string;
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
 * start new if needed, configure shared tmp.
 * On error during post-start setup, cleans up the started sidecar.
 */
export async function ensureDindSidecar(
  params: EnsureDindSidecarParams,
): Promise<EnsureDindSidecarResult> {
  const {
    containerName,
    sharedTmpVolume,
    sessionNetworkName,
    proxyEndpoint,
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
    await startDindSidecar(containerName, sharedTmpVolume, proxyEndpoint, {
      disableCache,
      readinessTimeoutMs,
    });
    sidecarStarted = true;
  }

  // Post-start setup. Any failure here cleans up the sidecar we just started
  // (whether shared or non-shared) before re-throwing, so a half-wired sidecar
  // — e.g. one still attached to the default bridge after a failed disconnect —
  // is never left running as an egress hole. A reused shared sidecar
  // (sidecarStarted=false) is left untouched.
  try {
    // 共有 tmp を全ユーザーから書き込み可能にする
    await ensureSharedTmpWritable(containerName);

    // Attach the sidecar to the internal session network and only then sever
    // the default bridge. Order matters: connecting first guarantees the
    // sidecar always has at least one reachable network (so the agent's
    // DOCKER_HOST DNS resolution never breaks), and severing the bridge
    // afterwards is what actually confines the sidecar's egress to the proxy.
    //
    // Reusing a shared sidecar still needs the connect (each session gets a
    // fresh session-network name); the bridge was already severed when the
    // shared sidecar first booted, so we only connect here.
    //
    // `docker network connect` is NOT idempotent: connecting a container that is
    // already attached to the network fails with "endpoint already exists" /
    // "already attached". For a freshly-started sidecar this can only mean a
    // genuine wiring failure, so we let it propagate (and the catch below tears
    // the sidecar down). For a reused shared sidecar a residual attachment from
    // a prior, not-fully-torn-down session can legitimately collide on the same
    // session-network name, so we tolerate an already-attached error there only
    // — every other connect failure is still fatal.
    if (isReusingSharedSidecar) {
      try {
        await dockerNetworkConnect(sessionNetworkName, containerName);
      } catch (connectErr) {
        if (isAlreadyAttachedError(connectErr)) {
          logInfo(
            `[nas] DinD: shared sidecar already attached to session network (${sessionNetworkName}), continuing`,
          );
        } else {
          throw connectErr;
        }
      }
    } else {
      await dockerNetworkConnect(sessionNetworkName, containerName);
    }

    if (sidecarStarted) {
      // Bridge severance only applies to a sidecar we just booted on the
      // bridge. A reused shared sidecar has no bridge attachment left.
      try {
        await dockerNetworkDisconnect("bridge", containerName);
      } catch (bridgeErr) {
        // SECURITY: a residual bridge attachment would let the sidecar (and
        // therefore the inner containers it runs) reach the host network
        // directly, bypassing proxy egress control entirely. We refuse to
        // proceed with a sidecar that still has the bridge — fail hard so the
        // cleanup path below tears it down rather than silently leaving an
        // egress hole.
        throw new Error(
          `Failed to disconnect DinD sidecar from default bridge (egress bypass risk): ${
            bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr)
          }`,
        );
      }
    }
  } catch (error) {
    // 途中で失敗した場合、この呼び出しで新規起動したサイドカーをクリーンアップ
    // してから再 throw する。再利用した shared サイドカー（sidecarStarted=false）は
    // 対象外なので誤って tear down することはない。
    if (sidecarStarted) {
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
  sharedTmpVolume: string;
  /**
   * Session network the sidecar was attached to. Only used for shared
   * sidecars, which are kept alive: we must detach them from the session
   * network here so ProxyStage's subsequent `network rm` does not fail with
   * "network in use". Non-shared sidecars are removed outright, which
   * auto-detaches from every network.
   */
  sessionNetworkName: string;
  shared: boolean;
}

/**
 * Tear down a DinD sidecar: stop/rm container, remove volume.
 * Shared sidecars are kept alive.
 */
export async function teardownDindSidecar(
  params: TeardownDindSidecarParams,
): Promise<void> {
  const { containerName, sharedTmpVolume, sessionNetworkName, shared } = params;

  if (shared) {
    logInfo(`[nas] DinD: keeping shared sidecar (${containerName})`);
    // Detach from the session network so ProxyStage can remove it. Best-effort:
    // a stale/missing attachment must not abort teardown.
    try {
      await dockerNetworkDisconnect(sessionNetworkName, containerName);
    } catch (e: unknown) {
      logWarn(
        `[nas] DinD teardown: failed to disconnect shared sidecar from session network: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
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

/**
 * Detect a `docker network connect` failure caused by the container already
 * being attached to the target network ("endpoint already exists in network" /
 * "already attached to network ..."). Used to tolerate a redundant connect when
 * reusing a shared sidecar.
 *
 * Bun's `$` throws a ShellError whose `stderr` is a Buffer; `.quiet()` only
 * suppresses live output, the captured stderr is still present. We inspect both
 * the error message and that stderr buffer so the match works regardless of how
 * the failure surfaces.
 */
function isAlreadyAttachedError(err: unknown): boolean {
  const parts: string[] = [];
  if (err instanceof Error && err.message) {
    parts.push(err.message);
  }
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === "string") {
    parts.push(stderr);
  } else if (stderr instanceof Uint8Array) {
    parts.push(Buffer.from(stderr).toString());
  }
  const haystack = parts.join("\n").toLowerCase();
  return (
    haystack.includes("already exists in network") ||
    haystack.includes("already attached to network") ||
    haystack.includes("endpoint with name") // "endpoint with name <c> already exists in network <n>"
  );
}

async function runDindSidecar(
  containerName: string,
  sharedTmpVolume: string,
  proxyEndpoint: string,
  options: DindStageOptions,
): Promise<void> {
  await dockerRunDetached({
    name: containerName,
    image: DIND_IMAGE,
    args: buildDindSidecarArgs(sharedTmpVolume, options),
    envVars: buildDindSidecarEnv(proxyEndpoint),
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_DIND,
      [NAS_SHARED_LABEL]: String(containerName === SHARED_CONTAINER_NAME),
    },
  });
}

/**
 * Build the dockerd environment for the DinD sidecar.
 *
 * Forces dockerd's outbound image pulls through the session proxy: dockerd reads the
 * upper-case HTTP(S)_PROXY forms, and we set both cases so any tooling inside
 * the sidecar sees a consistent proxy config. NO_PROXY keeps loopback (the 2375
 * listener / local socket) direct. DOCKER_TLS_CERTDIR is cleared so dockerd
 * listens on plain TCP 2375.
 */
export function buildDindSidecarEnv(
  proxyEndpoint: string,
): Record<string, string> {
  return {
    DOCKER_TLS_CERTDIR: "",
    HTTP_PROXY: proxyEndpoint,
    HTTPS_PROXY: proxyEndpoint,
    NO_PROXY: "localhost,127.0.0.1",
    http_proxy: proxyEndpoint,
    https_proxy: proxyEndpoint,
    no_proxy: "localhost,127.0.0.1",
  };
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
