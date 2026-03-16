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

import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import {
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

interface DindStageOptions {
  disableCache?: boolean;
  readinessTimeoutMs?: number;
}

export class DindStage implements Stage {
  name = "DindStage";

  private shared = false;
  private networkName: string | null = null;
  private containerName: string | null = null;
  private sharedTmpVolume: string | null = null;
  private readonly disableCache: boolean;
  private readonly readinessTimeoutMs: number;

  constructor(options: DindStageOptions = {}) {
    this.disableCache = options.disableCache ?? false;
    this.readinessTimeoutMs = options.readinessTimeoutMs ??
      READINESS_TIMEOUT_MS;
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    if (!ctx.profile.docker.enable) {
      console.log("[nas] DinD: skipped (not enabled)");
      return ctx;
    }

    this.shared = ctx.profile.docker.shared;

    let networkName: string;
    let containerName: string;

    let sharedTmpVolume: string;

    if (this.shared) {
      networkName = SHARED_NETWORK_NAME;
      containerName = SHARED_CONTAINER_NAME;
      sharedTmpVolume = SHARED_TMP_VOLUME;
    } else {
      const sessionId = crypto.randomUUID().slice(0, 8);
      networkName = `nas-dind-${sessionId}`;
      containerName = `nas-dind-${sessionId}`;
      sharedTmpVolume = `nas-dind-tmp-${sessionId}`;
    }
    this.networkName = networkName;
    this.containerName = containerName;
    this.sharedTmpVolume = sharedTmpVolume;

    const isReusingSharedSidecar = this.shared &&
      await dockerIsRunning(containerName);

    // 共有モード: 既に起動中ならサイドカー作成をスキップ
    if (isReusingSharedSidecar) {
      console.log(`[nas] DinD: reusing shared sidecar (${containerName})`);
    } else {
      // 共有モードで停止済みコンテナが残っている場合は削除して再作成
      if (this.shared) {
        await dockerRm(containerName).catch(() => {});
      }

      // DinD rootless サイドカーをデフォルト bridge で起動
      // ※ rootlesskit が vpnkit + --copy-up=/run,/etc でネットワーク名前空間を構築するため、
      //    カスタム Docker ネットワーク上では起動に失敗する。
      //    起動後に docker network connect でカスタムネットワークに接続する。
      await startDindSidecar(containerName, sharedTmpVolume, {
        disableCache: this.disableCache,
        readinessTimeoutMs: this.readinessTimeoutMs,
      });
    }

    // 共有 tmp を全ユーザーから書き込み可能にする（DinD rootless の UID と
    // エージェントコンテナの UID が異なるため）。
    // shared sidecar 再利用時も毎回矯正し、既存 volume の 0755 を引きずらない。
    await ensureSharedTmpWritable(containerName);

    // カスタムネットワーク作成（既存ならスキップ）& サイドカー接続
    await ensureNetwork(networkName, containerName);

    // エージェントコンテナに DinD ネットワーク、DOCKER_HOST、共有 tmp を設定
    const args = [
      ...ctx.dockerArgs,
      "--network",
      networkName,
      "-v",
      `${sharedTmpVolume}:${SHARED_TMP_MOUNT_PATH}`,
    ];
    const envVars = {
      ...ctx.envVars,
      DOCKER_HOST: `tcp://${containerName}:${DIND_INTERNAL_PORT}`,
      NAS_DIND_CONTAINER_NAME: containerName,
      NAS_DIND_SHARED_TMP: SHARED_TMP_MOUNT_PATH,
    };

    return { ...ctx, dockerArgs: args, envVars };
  }

  async teardown(_ctx: ExecutionContext): Promise<void> {
    if (!this.containerName) return;

    // 共有モードではサイドカーもネットワークも残す
    if (this.shared) {
      console.log(
        `[nas] DinD: keeping shared sidecar (${this.containerName})`,
      );
      return;
    }

    try {
      console.log(`[nas] DinD: stopping sidecar ${this.containerName}`);
      await dockerStop(this.containerName, { timeoutSeconds: 0 });
    } catch {
      // コンテナが既に停止している場合は無視
    }
    try {
      await dockerRm(this.containerName);
    } catch {
      // コンテナが既に削除されている場合は無視
    }
    if (this.networkName) {
      try {
        console.log(`[nas] DinD: removing network ${this.networkName}`);
        await dockerNetworkRemove(this.networkName);
      } catch {
        // ネットワークが既に削除されている場合は無視
      }
    }
    if (this.sharedTmpVolume) {
      try {
        console.log(`[nas] DinD: removing volume ${this.sharedTmpVolume}`);
        await dockerVolumeRemove(this.sharedTmpVolume);
      } catch {
        // ボリュームが既に削除されている場合は無視
      }
    }
  }
}

async function ensureSharedTmpWritable(containerName: string): Promise<void> {
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
async function ensureNetwork(
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
    console.log(`[nas] DinD: created network ${networkName}`);
  } catch {
    // 既に存在する場合は無視
  }
  try {
    await dockerNetworkConnect(networkName, containerName);
  } catch {
    // 既に接続済みの場合は無視
  }
}

/**
 * DinD サイドカーを起動する。
 * キャッシュボリュームありで試み、起動に失敗したらキャッシュなしでリトライする。
 */
async function startDindSidecar(
  containerName: string,
  sharedTmpVolume: string,
  options: DindStageOptions = {},
): Promise<void> {
  console.log(`[nas] DinD: starting sidecar (${DIND_IMAGE})`);
  await dockerVolumeCreate(sharedTmpVolume, {
    [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
    [NAS_KIND_LABEL]: NAS_KIND_DIND_TMP,
  }).catch(() => {});
  const args = [
    "--privileged",
    "-v",
    `${sharedTmpVolume}:${SHARED_TMP_MOUNT_PATH}`,
  ];
  if (!options.disableCache) {
    args.splice(2, 0, "-v", `${DIND_CACHE_VOLUME}:${DIND_DATA_DIR}`);
  }
  await dockerRunDetached({
    name: containerName,
    image: DIND_IMAGE,
    args,
    envVars: {
      DOCKER_TLS_CERTDIR: "",
    },
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_DIND,
      [NAS_SHARED_LABEL]: String(containerName === SHARED_CONTAINER_NAME),
    },
  });

  console.log("[nas] DinD: waiting for daemon to be ready...");
  try {
    await waitForDindReady(
      containerName,
      options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
    );
    console.log("[nas] DinD: daemon is ready");
  } catch (e) {
    if (options.disableCache) {
      throw e;
    }
    console.warn(
      `[nas] DinD: failed to start with cache volume (${DIND_CACHE_VOLUME}), retrying without cache...`,
    );
    // キャッシュボリュームに stale lock がある可能性があるため、キャッシュなしで再試行
    await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
    await dockerRm(containerName).catch(() => {});

    await dockerRunDetached({
      name: containerName,
      image: DIND_IMAGE,
      args: [
        "--privileged",
        "-v",
        `${sharedTmpVolume}:${SHARED_TMP_MOUNT_PATH}`,
      ],
      envVars: {
        DOCKER_TLS_CERTDIR: "",
      },
      labels: {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_DIND,
        [NAS_SHARED_LABEL]: String(containerName === SHARED_CONTAINER_NAME),
      },
    });

    console.log("[nas] DinD: waiting for daemon to be ready (no cache)...");
    await waitForDindReady(
      containerName,
      options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
    );
    console.log("[nas] DinD: daemon is ready (without cache)");

    // 壊れたキャッシュボリュームを削除して次回はクリーンに開始
    await dockerVolumeRemove(DIND_CACHE_VOLUME).catch(() => {});
    void e;
  }
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
  while (Date.now() - start < timeoutMs) {
    // コンテナが生きているか確認（起動失敗で即座にエラーを返す）
    const running = await dockerIsRunning(containerName);
    if (!running) {
      const logs = await dockerLogs(containerName, { tail: 50 });
      throw new Error(
        `DinD rootless container exited unexpectedly.\n--- container logs ---\n${logs}`,
      );
    }

    // TCP 経由で Docker デーモンの readiness を確認
    const result = await dockerExec(containerName, [
      "docker",
      "-H",
      `tcp://127.0.0.1:${DIND_INTERNAL_PORT}`,
      "info",
    ]);
    if (result.code === 0) return;
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
