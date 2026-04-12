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

import { Effect, type Scope } from "effect";
import {
  DIND_INTERNAL_PORT,
  ensureDindSidecar,
  SHARED_CONTAINER_NAME,
  SHARED_TMP_MOUNT_PATH,
  teardownDindSidecar,
} from "../docker/dind.ts";
import { logInfo } from "../log.ts";
import type {
  EffectStage,
  EffectStageResult,
  StageInput,
} from "../pipeline/types.ts";

const SHARED_NETWORK_NAME = "nas-dind-shared";
const SHARED_TMP_VOLUME = "nas-dind-shared-tmp";

export type { DindStageOptions } from "../docker/dind.ts";

// ---------------------------------------------------------------------------
// DindPlan
// ---------------------------------------------------------------------------

export interface DindPlan {
  readonly containerName: string;
  readonly sharedTmpVolume: string;
  readonly networkName: string;
  readonly shared: boolean;
  readonly disableCache: boolean;
  readonly readinessTimeoutMs: number;
  readonly outputOverrides: EffectStageResult;
}

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

export function planDind(
  input: StageInput,
  options: { disableCache?: boolean; readinessTimeoutMs?: number } = {},
): DindPlan | null {
  if (!input.profile.docker.enable) {
    logInfo("[nas] DinD: skipped (not enabled)");
    return null;
  }

  const disableCache = options.disableCache ?? false;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
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
    containerName,
    sharedTmpVolume,
    networkName,
    shared,
    disableCache,
    readinessTimeoutMs,
    outputOverrides: {
      dindContainerName: containerName,
      networkName,
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
    },
  };
}

// ---------------------------------------------------------------------------
// EffectStage
// ---------------------------------------------------------------------------

export function createDindStage(
  options: { disableCache?: boolean; readinessTimeoutMs?: number } = {},
): EffectStage<never> {
  return {
    kind: "effect",
    name: "DindStage",

    run(
      input: StageInput,
    ): Effect.Effect<EffectStageResult, unknown, Scope.Scope> {
      const plan = planDind(input, options);
      if (plan === null) {
        return Effect.succeed({});
      }
      return runDind(plan);
    },
  };
}

// ---------------------------------------------------------------------------
// Effect runner
// ---------------------------------------------------------------------------

function runDind(
  plan: DindPlan,
): Effect.Effect<EffectStageResult, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          ensureDindSidecar({
            containerName: plan.containerName,
            sharedTmpVolume: plan.sharedTmpVolume,
            networkName: plan.networkName,
            shared: plan.shared,
            disableCache: plan.disableCache,
            readinessTimeoutMs: plan.readinessTimeoutMs,
          }),
        catch: (e) =>
          new Error(
            `DinD sidecar setup failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }),
      () =>
        Effect.tryPromise({
          try: () =>
            teardownDindSidecar({
              containerName: plan.containerName,
              networkName: plan.networkName,
              sharedTmpVolume: plan.sharedTmpVolume,
              shared: plan.shared,
            }),
          catch: (e) =>
            new Error(
              `DinD sidecar teardown failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
        }).pipe(Effect.ignoreLogged),
    );

    return plan.outputOverrides;
  });
}

// ---------------------------------------------------------------------------
// Re-export helper (used by tests)
// ---------------------------------------------------------------------------

export { buildDindSidecarArgs } from "../docker/dind.ts";
