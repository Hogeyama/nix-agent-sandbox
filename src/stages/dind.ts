/**
 * DinD (Docker-in-Docker) Rootless サイドカーステージ
 *
 * docker:dind-rootless コンテナをサイドカーとして起動し、
 * エージェントコンテナから隔離された Docker デーモンを利用可能にする。
 *
 * 動作モード:
 * - shared=false (デフォルト): セッションごとに専用サイドカーを起動・破棄
 * - shared=true: 固定名 "nas-dind-shared" のサイドカーを使い回し、teardown で削除しない
 *
 * 起動手順:
 * 1. dind-rootless をデフォルト bridge で起動（rootlesskit が vpnkit + copy-up で
 *    ネットワーク名前空間をセットアップするため、カスタムネットワーク上では起動に失敗する）
 * 2. TCP 経由で daemon の readiness を確認
 * 3. docker network connect でカスタムネットワークに接続
 * 4. エージェントコンテナをカスタムネットワーク上で起動し、DNS でサイドカーに接続
 */

import type { PlanStage, StageInput, StagePlan } from "../pipeline/types.ts";
import {
  dockerContainerIp,
  dockerExec,
  dockerIsRunning,
  dockerLogs,
  dockerNetworkConnect,
  dockerNetworkCreateWithLabels,
  dockerRm,
  dockerRunDetached,
  dockerStop,
  dockerVolumeCreate,
  dockerVolumeRemove,
} from "../docker/client.ts";
import {
  NAS_KIND_DIND,
  NAS_KIND_DIND_NETWORK,
  NAS_KIND_DIND_TMP,
  NAS_KIND_LABEL,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
  NAS_SHARED_LABEL,
} from "../docker/nas_resources.ts";
import { logInfo, logWarn } from "../log.ts";

const DIND_IMAGE = "docker:dind-rootless";
const DIND_INTERNAL_PORT = 2375;
const DIND_CACHE_VOLUME = "nas-docker-cache";
const DIND_DATA_DIR = "/home/rootless/.local/share/docker";
const SHARED_CONTAINER_NAME = "nas-dind-shared";
const SHARED_NETWORK_NAME = "nas-dind-shared";
const SHARED_TMP_VOLUME = "nas-dind-shared-tmp";
// rootless DinD の inner daemon から見える bind mount 元は sidecar 自身の
// ファイルシステムだけなので、nas コンテナと共有する中継地点が必要になる。
// この volume を sidecar と nas コンテナの両方に /tmp/nas-shared としてマウントし、
// nas 側で作ったテスト用ディレクトリを inner docker run の bind mount 元にする。
const SHARED_TMP_MOUNT_PATH = "/tmp/nas-shared";
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_INTERVAL_MS = 500;

export interface DindStageOptions {
  disableCache?: boolean;
  readinessTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// PlanStage
// ---------------------------------------------------------------------------

export function createDindStage(
  options: DindStageOptions = {},
): PlanStage {
  const disableCache = options.disableCache ?? false;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;

  return {
    kind: "plan",
    name: "DindStage",

    plan(input: StageInput): StagePlan | null {
      if (!input.profile.docker.enable) {
        logInfo("[nas] DinD: skipped (not enabled)");
        return null;
      }

      const shared = input.profile.docker.shared;

      let networkName: string;
      let containerName: string;
      let sharedTmpVolume: string;

      if (shared) {
        networkName = SHARED_NETWORK_NAME;
        containerName = SHARED_CONTAINER_NAME;
        sharedTmpVolume = SHARED_TMP_VOLUME;
      } else {
        const sessionId = input.sessionId.slice(0, 8);
        networkName = `nas-dind-${sessionId}`;
        containerName = `nas-dind-${sessionId}`;
        sharedTmpVolume = `nas-dind-tmp-${sessionId}`;
      }

      return {
        effects: [
          {
            kind: "dind-sidecar",
            containerName,
            sharedTmpVolume,
            networkName,
            shared,
            disableCache,
            readinessTimeoutMs,
          },
        ],
        dockerArgs: [
          "--network",
          networkName,
          "-v",
          `${sharedTmpVolume}:${SHARED_TMP_MOUNT_PATH}`,
        ],
        envVars: {
          DOCKER_HOST: `tcp://${containerName}:${DIND_INTERNAL_PORT}`,
          NAS_DIND_CONTAINER_NAME: containerName,
          NAS_DIND_SHARED_TMP: SHARED_TMP_MOUNT_PATH,
        },
        outputOverrides: {
          dindContainerName: containerName,
          networkName,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Exported helper functions (called by effect executor)
// ---------------------------------------------------------------------------

export async function ensureSharedTmpWritable(
  containerName: string,
): Promise<void> {
  const result = await dockerExec(containerName, [
    "chmod",
    "1777",
    SHARED_TMP_MOUNT_PATH,
  ], { user: "0" });
  if (result.code !== 0) {
    throw new Error(
      `Failed to make shared tmp writable: ${SHARED_TMP_MOUNT_PATH}`,
    );
  }
}

/** ネットワークを作成（既存ならスキップ）し、コンテナを接続 */
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
 * DinD サイドカーを起動する。
 * キャッシュボリュームありで試み、起動に失敗したらキャッシュなしでリトライする。
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
    logInfo(`[nas] DinD: failed to create shared tmp volume: ${e}`)
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
      logInfo(`[nas] DinD: failed to stop container for cache reset: ${e}`)
    );
    await dockerRm(containerName).catch((e) =>
      logInfo(`[nas] DinD: failed to remove container for cache reset: ${e}`)
    );
    await dockerVolumeRemove(DIND_CACHE_VOLUME).catch((e) =>
      logInfo(`[nas] DinD: failed to remove cache volume: ${e}`)
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
        logInfo(`[nas] DinD: failed to stop container for no-cache retry: ${e}`)
      );
      await dockerRm(containerName).catch((e) =>
        logInfo(
          `[nas] DinD: failed to remove container for no-cache retry: ${e}`,
        )
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
 * DinD サイドカーの readiness を TCP 経由でポーリングする。
 *
 * docker exec は ENTRYPOINT をバイパスするため DOCKER_HOST 環境変数が設定されない。
 * また rootlesskit の --copy-up=/run により unix ソケットは rootlesskit の
 * マウント名前空間内にあり docker exec からはアクセスできない。
 * 一方、rootlesskit の --port-driver=builtin が TCP ポートをコンテナ名前空間に
 * フォワードするため、tcp://127.0.0.1:2375 で接続できる。
 */
async function waitForDindReady(
  containerName: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let containerIp: string | null = null;
  while (Date.now() - start < timeoutMs) {
    // コンテナが生きているか確認（起動失敗で即座にエラーを返す）
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

    // まず bridge IP への TCP 接続で daemon の listen 開始を検知し、
    // 開いてから 1 回だけ docker info で実利用可能か確認する。
    if (
      containerIp &&
      await canConnectTcp(containerIp, DIND_INTERNAL_PORT)
    ) {
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

  // タイムアウト時はログを出力して原因調査を助ける
  const logs = await dockerLogs(containerName, { tail: 50 });
  throw new Error(
    `DinD rootless failed to become ready within ${
      timeoutMs / 1000
    }s\n--- container logs ---\n${logs}`,
  );
}

async function canConnectTcp(
  hostname: string,
  port: number,
): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname, port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}
