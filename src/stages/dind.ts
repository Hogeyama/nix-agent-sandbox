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
  DIND_INTERNAL_PORT,
  SHARED_CONTAINER_NAME,
  SHARED_TMP_MOUNT_PATH,
} from "../docker/dind.ts";
import { logInfo } from "../log.ts";

const SHARED_NETWORK_NAME = "nas-dind-shared";
const SHARED_TMP_VOLUME = "nas-dind-shared-tmp";

export type { DindStageOptions } from "../docker/dind.ts";

// ---------------------------------------------------------------------------
// PlanStage
// ---------------------------------------------------------------------------

export function createDindStage(
  options: { disableCache?: boolean; readinessTimeoutMs?: number } = {},
): PlanStage {
  const disableCache = options.disableCache ?? false;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;

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
// Re-export helper (used by tests)
// ---------------------------------------------------------------------------

export { buildDindSidecarArgs } from "../docker/dind.ts";
