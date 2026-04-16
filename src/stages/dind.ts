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
  SHARED_CONTAINER_NAME,
  SHARED_TMP_MOUNT_PATH,
} from "../docker/dind.ts";
import { logInfo } from "../log.ts";
import { mergeContainerPlan } from "../pipeline/container_plan.ts";
import type { Stage } from "../pipeline/stage_builder.ts";
import type { ContainerPlan, PipelineState } from "../pipeline/state.ts";
import type { StageInput, StageResult } from "../pipeline/types.ts";
import { DindService } from "../services/dind.ts";

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
  readonly outputOverrides: Pick<StageResult, "container" | "dind">;
}

type DindStageState = Pick<PipelineState, "workspace" | "container">;
type DindStageInput = StageInput & DindStageState;
export interface DindStagePlanOptions {
  disableCache?: boolean;
  readinessTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

export function planDind(
  input: DindStageInput,
  options: DindStagePlanOptions = {},
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
      dind: {
        containerName,
      },
      container: buildContainerState(input, {
        containerName,
        sharedTmpVolume,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// EffectStage
// ---------------------------------------------------------------------------

export function createDindStage(
  shared: StageInput,
): Stage<
  "workspace" | "container",
  Partial<Pick<StageResult, "container" | "dind">>,
  DindService,
  unknown
> {
  return createDindStageWithOptions(shared);
}

export function createDindStageWithOptions(
  shared: StageInput,
  options: DindStagePlanOptions = {},
): Stage<
  "workspace" | "container",
  Partial<Pick<StageResult, "container" | "dind">>,
  DindService,
  unknown
> {
  return {
    name: "DindStage",
    needs: ["workspace", "container"],

    run(
      input,
    ): Effect.Effect<
      Partial<Pick<StageResult, "container" | "dind">>,
      unknown,
      Scope.Scope | DindService
    > {
      const stageInput: DindStageInput = {
        ...shared,
        ...input,
      };
      const plan = planDind(stageInput, options);
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
): Effect.Effect<
  Partial<Pick<StageResult, "container" | "dind">>,
  unknown,
  Scope.Scope | DindService
> {
  return Effect.gen(function* () {
    const dind = yield* DindService;

    yield* Effect.acquireRelease(
      dind.ensureSidecar({
        containerName: plan.containerName,
        sharedTmpVolume: plan.sharedTmpVolume,
        networkName: plan.networkName,
        shared: plan.shared,
        disableCache: plan.disableCache,
        readinessTimeoutMs: plan.readinessTimeoutMs,
      }),
      () =>
        dind
          .teardownSidecar({
            containerName: plan.containerName,
            networkName: plan.networkName,
            sharedTmpVolume: plan.sharedTmpVolume,
            shared: plan.shared,
          })
          .pipe(Effect.ignoreLogged),
    );

    return plan.outputOverrides;
  });
}

function buildContainerState(
  input: DindStageInput,
  config: {
    readonly containerName: string;
    readonly sharedTmpVolume: string;
  },
): ContainerPlan {
  const base = normalizeContainerBase(input);

  return mergeContainerPlan(base, {
    network: {
      name: input.profile.docker.shared
        ? SHARED_NETWORK_NAME
        : `nas-dind-${input.sessionId.slice(0, 8)}`,
    },
    env: {
      static: {
        DOCKER_HOST: `tcp://${config.containerName}:${DIND_INTERNAL_PORT}`,
        NAS_DIND_CONTAINER_NAME: config.containerName,
        NAS_DIND_SHARED_TMP: SHARED_TMP_MOUNT_PATH,
      },
    },
    extraRunArgs: ["-v", `${config.sharedTmpVolume}:${SHARED_TMP_MOUNT_PATH}`],
  });
}

function normalizeContainerBase(input: DindStageInput): ContainerPlan {
  const { network: _network, ...containerWithoutNetwork } = input.container;
  return containerWithoutNetwork;
}

// ---------------------------------------------------------------------------
// Re-export helper (used by tests)
// ---------------------------------------------------------------------------

export { buildDindSidecarArgs } from "../docker/dind.ts";
