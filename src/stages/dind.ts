/**
 * DinD (Docker-in-Docker) Rootless サイドカーステージ
 *
 * docker:dind-rootless コンテナをサイドカーとして起動し、
 * エージェントコンテナから隔離された Docker デーモンを利用可能にする。
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
  dockerNetworkCreate,
  dockerNetworkRemove,
  dockerRm,
  dockerRunDetached,
  dockerStop,
} from "../docker/client.ts";

const DIND_IMAGE = "docker:dind-rootless";
const DIND_INTERNAL_PORT = 2375;
const DIND_CACHE_VOLUME = "nas-docker-cache";
const DIND_DATA_DIR = "/home/rootless/.local/share/docker";
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_INTERVAL_MS = 500;

export class DindStage implements Stage {
  name = "DindStage";

  private networkName: string | null = null;
  private containerName: string | null = null;

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    if (!ctx.profile.docker.enable) {
      console.log("[nas] DinD: skipped (not enabled)");
      return ctx;
    }

    const sessionId = crypto.randomUUID().slice(0, 8);
    const networkName = `nas-dind-${sessionId}`;
    const containerName = `nas-dind-${sessionId}`;
    this.networkName = networkName;
    this.containerName = containerName;

    // DinD rootless サイドカーをデフォルト bridge で起動
    // ※ rootlesskit が vpnkit + --copy-up=/run,/etc でネットワーク名前空間を構築するため、
    //    カスタム Docker ネットワーク上では起動に失敗する。
    //    起動後に docker network connect でカスタムネットワークに接続する。
    // ※ Docker named volume を使用。初回は Dockerfile の VOLUME 宣言から
    //    正しいパーミッション（rootless:rootless）で初期化される。
    //    ホスト bind mount は rootlesskit の UID remapping と競合するため使わない。
    console.log(`[nas] DinD: starting sidecar (${DIND_IMAGE})`);
    await dockerRunDetached({
      name: containerName,
      image: DIND_IMAGE,
      args: [
        "--privileged",
        "-v",
        `${DIND_CACHE_VOLUME}:${DIND_DATA_DIR}`,
      ],
      envVars: {
        DOCKER_TLS_CERTDIR: "",
      },
    });

    // DinD readiness check (TCP 経由)
    console.log("[nas] DinD: waiting for daemon to be ready...");
    await waitForDindReady(containerName, READINESS_TIMEOUT_MS);
    console.log("[nas] DinD: daemon is ready");

    // カスタムネットワークを作成し、サイドカーを接続
    console.log(`[nas] DinD: creating network ${networkName}`);
    await dockerNetworkCreate(networkName);
    await dockerNetworkConnect(networkName, containerName);

    // エージェントコンテナに DinD ネットワークと DOCKER_HOST を設定
    const args = [...ctx.dockerArgs, "--network", networkName];
    const envVars = {
      ...ctx.envVars,
      DOCKER_HOST: `tcp://${containerName}:${DIND_INTERNAL_PORT}`,
    };

    return { ...ctx, dockerArgs: args, envVars };
  }

  async teardown(_ctx: ExecutionContext): Promise<void> {
    if (!this.containerName) return;

    try {
      console.log(`[nas] DinD: stopping sidecar ${this.containerName}`);
      await dockerStop(this.containerName);
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
    `DinD rootless failed to become ready within ${timeoutMs / 1000}s\n--- container logs ---\n${logs}`,
  );
}
