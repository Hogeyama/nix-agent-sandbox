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
} from "./nas_resources.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DIND_IMAGE = "docker:dind-rootless";
/**
 * Where the sidecar sees the proxy's CA certificate.
 *
 * SSL_CERT_DIR makes Go read every file in this directory, so it must hold
 * nothing else. A path the image does not otherwise use satisfies that.
 */
export const DIND_CA_MOUNT_PATH = "/etc/nas-ca";
/**
 * Where `docker:dind-rootless` puts its Unix socket.
 *
 * Testcontainers' Ryuk reaper bind-mounts /var/run/docker.sock from the
 * daemon's filesystem, and that path does not exist inside the sidecar, so
 * Docker creates an empty directory there and Ryuk cannot connect. This path
 * is a property of DIND_IMAGE, which is why it lives here.
 */
export const DIND_ROOTLESS_SOCKET_PATH = "/run/user/1000/docker.sock";
export const DIND_INTERNAL_PORT = 2375;
export const DIND_CACHE_VOLUME = "nas-docker-cache";
export const DIND_DATA_DIR = "/home/rootless/.local/share/docker";
export const SHARED_TMP_MOUNT_PATH = "/tmp/nas-shared";
export const READINESS_TIMEOUT_MS = 30_000;
export const READINESS_POLL_INTERVAL_MS = 500;

/**
 * Bind the proxy's CA certificate into the sidecar.
 *
 * `--mount` rather than `-v` on purpose: given a source that does not exist,
 * `-v` creates a directory there instead of failing, which would leave the
 * daemon silently untrusting and leave a directory named
 * `mitmproxy-ca-cert.pem` behind — enough for the CA service's existence check
 * to treat the certificate as present forever.
 */
export function buildDindSidecarMounts(caCertPath: string): Array<{
  source: string;
  target: string;
  mode: "ro";
  type: "bind";
}> {
  return [
    {
      source: caCertPath,
      target: `${DIND_CA_MOUNT_PATH}/nas-proxy.crt`,
      mode: "ro",
      type: "bind",
    },
  ];
}

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
 * The proxy endpoint is injected into dockerd's HTTP(S)_PROXY env and its CA
 * certificate is mounted for Go's trust search. This is independent of
 * `DindStageOptions` (which only controls cache/readiness) so cache-reset
 * retry paths below re-pass the same proxy config verbatim.
 */
export async function startDindSidecar(
  containerName: string,
  sharedTmpVolume: string,
  proxy: { proxyEndpoint: string; caCertPath: string },
  extraHosts: readonly { readonly host: string; readonly ip: string }[],
  options: DindStageOptions = {},
): Promise<void> {
  logInfo(`[nas] DinD: starting sidecar (${DIND_IMAGE})`);
  await dockerVolumeCreate(sharedTmpVolume, {
    [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
    [NAS_KIND_LABEL]: NAS_KIND_DIND_TMP,
  }).catch((e) =>
    logInfo(`[nas] DinD: failed to create shared tmp volume: ${e}`),
  );

  await runDindSidecar(
    containerName,
    sharedTmpVolume,
    proxy,
    extraHosts,
    options,
  );
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
      proxy,
      extraHosts,
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

    await runDindSidecar(containerName, sharedTmpVolume, proxy, extraHosts, {
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
  /** Path to the proxy CA certificate generated for this session. */
  caCertPath: string;
  /**
   * Host-to-IP mappings to add to the sidecar's /etc/hosts (e.g. the proxy
   * alias). The agent joins this container's network namespace and so cannot
   * carry its own --add-host; Docker shares the owner's /etc/hosts with the
   * joiner, so these entries must land on the sidecar instead.
   */
  extraHosts: readonly { readonly host: string; readonly ip: string }[];
  disableCache?: boolean;
  readinessTimeoutMs?: number;
}

/**
 * Ensure a DinD sidecar is running: start it and configure shared tmp.
 * On error during post-start setup, cleans up the started sidecar.
 */
export async function ensureDindSidecar(
  params: EnsureDindSidecarParams,
): Promise<void> {
  const {
    containerName,
    sharedTmpVolume,
    sessionNetworkName,
    proxyEndpoint,
    caCertPath,
    extraHosts,
    disableCache,
    readinessTimeoutMs,
  } = params;

  // DinD rootless サイドカーをデフォルト bridge で起動
  await startDindSidecar(
    containerName,
    sharedTmpVolume,
    { proxyEndpoint, caCertPath },
    extraHosts,
    {
      disableCache,
      readinessTimeoutMs,
    },
  );

  // Post-start setup. Any failure here cleans up the sidecar we just started
  // before re-throwing, so a half-wired sidecar — e.g. one still attached to
  // the default bridge after a failed disconnect — is never left running as
  // an egress hole.
  try {
    // 共有 tmp を全ユーザーから書き込み可能にする
    await ensureSharedTmpWritable(containerName);

    // Attach the sidecar to the internal session network and only then sever
    // the default bridge. Order matters: connecting first guarantees the
    // sidecar always has at least one reachable network (so the agent's
    // DOCKER_HOST DNS resolution never breaks), and severing the bridge
    // afterwards is what actually confines the sidecar's egress to the proxy.
    await dockerNetworkConnect(sessionNetworkName, containerName);

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
  } catch (error) {
    // 途中で失敗した場合、この呼び出しで起動したサイドカーをクリーンアップ
    // してから再 throw する。
    try {
      await dockerStop(containerName, { timeoutSeconds: 0 });
    } catch (cleanupErr) {
      logWarn(
        `[nas] DinD: cleanup failed (stop): ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`,
      );
    }
    try {
      await dockerRm(containerName);
    } catch (cleanupErr) {
      logWarn(
        `[nas] DinD: cleanup failed (rm): ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`,
      );
    }
    throw error;
  }
}

/** Parameters for teardownDindSidecar (decoupled from effect types). */
export interface TeardownDindSidecarParams {
  containerName: string;
  sharedTmpVolume: string;
  /**
   * Name of the agent container that joined this sidecar's network
   * namespace (`--network container:<containerName>`). If it is still
   * running, removing the sidecar would strip its namespace owner and
   * take its networking with it, so teardown skips removal entirely.
   */
  joinerContainerName: string;
}

/** Injectable Docker primitives, defaulted to the real client in production. */
export interface TeardownDindDeps {
  isRunning?: (name: string) => Promise<boolean>;
  stop?: (name: string, opts?: { timeoutSeconds?: number }) => Promise<void>;
  rm?: (name: string) => Promise<void>;
  volumeRemove?: (name: string) => Promise<void>;
}

/**
 * Tear down a DinD sidecar: stop/rm container, remove volume.
 * Kept alive while the joining agent container is still running.
 */
export async function teardownDindSidecar(
  params: TeardownDindSidecarParams,
  deps: TeardownDindDeps = {},
): Promise<void> {
  const isRunning = deps.isRunning ?? dockerIsRunning;
  const stop = deps.stop ?? dockerStop;
  const rm = deps.rm ?? dockerRm;
  const volumeRemove = deps.volumeRemove ?? dockerVolumeRemove;
  const { containerName, sharedTmpVolume, joinerContainerName } = params;

  // The agent joined this container's network namespace. If it outlived the
  // nas process -- SIGTERM kills only the docker client -- removing the
  // sidecar would strip its namespace owner out from under a running
  // container, leaving it unable to reach anything at all, not even
  // loopback. Skipping only defers that removal; it does not preserve the
  // agent's networking otherwise, since the rest of this scope's finalizers
  // (proxy disconnect, forward-port relays, session broker, authz document)
  // still run. The sidecar, its tmp volume and the session network stay
  // allocated until `nas container clean` collects them once the agent
  // exits, and until then it recognizes the joiner as a user of this sidecar.
  if (await isRunning(joinerContainerName)) {
    logInfo(
      `[nas] DinD: ${joinerContainerName} still shares this namespace; skipping teardown`,
    );
    return;
  }

  try {
    logInfo(`[nas] DinD: stopping sidecar ${containerName}`);
    await stop(containerName, { timeoutSeconds: 0 });
  } catch (e: unknown) {
    logWarn(
      `[nas] DinD teardown: failed to stop container: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  try {
    await rm(containerName);
  } catch (e: unknown) {
    logWarn(
      `[nas] DinD teardown: failed to remove container: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  try {
    logInfo(`[nas] DinD: removing volume ${sharedTmpVolume}`);
    await volumeRemove(sharedTmpVolume);
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
  proxy: { proxyEndpoint: string; caCertPath: string },
  extraHosts: readonly { readonly host: string; readonly ip: string }[],
  options: DindStageOptions,
): Promise<void> {
  await dockerRunDetached({
    name: containerName,
    image: DIND_IMAGE,
    args: buildDindSidecarArgs(sharedTmpVolume, extraHosts, options),
    envVars: buildDindSidecarEnv(proxy),
    mounts: buildDindSidecarMounts(proxy.caCertPath),
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_DIND,
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
export function buildDindSidecarEnv(proxy: {
  proxyEndpoint: string;
  caCertPath: string;
}): Record<string, string> {
  return {
    DOCKER_TLS_CERTDIR: "",
    HTTP_PROXY: proxy.proxyEndpoint,
    HTTPS_PROXY: proxy.proxyEndpoint,
    NO_PROXY: "localhost,127.0.0.1",
    SSL_CERT_DIR: DIND_CA_MOUNT_PATH,
    http_proxy: proxy.proxyEndpoint,
    https_proxy: proxy.proxyEndpoint,
    no_proxy: "localhost,127.0.0.1",
  };
}

/**
 * Build docker run arguments for the DinD sidecar container.
 */
export function buildDindSidecarArgs(
  sharedTmpVolume: string,
  extraHosts: readonly { readonly host: string; readonly ip: string }[],
  options: DindStageOptions = {},
): string[] {
  const args = ["--privileged"];
  if (!options.disableCache) {
    args.push("-v", `${DIND_CACHE_VOLUME}:${DIND_DATA_DIR}`);
  }
  args.push("-v", `${sharedTmpVolume}:${SHARED_TMP_MOUNT_PATH}`);
  // The agent joins this container's network namespace and so cannot carry
  // --add-host itself; Docker shares the owner's /etc/hosts with the joiner.
  for (const entry of extraHosts) {
    args.push(`--add-host=${entry.host}:${entry.ip}`);
  }
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
