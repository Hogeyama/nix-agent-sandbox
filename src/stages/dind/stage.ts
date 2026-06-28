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
 * 3. エージェントコンテナに DOCKER_HOST env（tcp://<サイドカー名>:2375）を注入し、
 *    サイドカーの Docker デーモンを利用可能にする
 *
 * エージェントコンテナの network は DindStage では設定しない（network の設定は
 * 別ステージが担う）。
 */

import { Effect, type Scope } from "effect";
import {
  DIND_INTERNAL_PORT,
  SHARED_CONTAINER_NAME,
  SHARED_TMP_MOUNT_PATH,
} from "../../docker/dind.ts";
import { logInfo } from "../../log.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { ContainerPlan, PipelineState } from "../../pipeline/state.ts";
import type { StageInput, StageResult } from "../../pipeline/types.ts";
import { DindService } from "./dind_service.ts";

const SHARED_TMP_VOLUME = "nas-dind-shared-tmp";

export type { DindStageOptions } from "../../docker/dind.ts";

// ---------------------------------------------------------------------------
// DindPlan
// ---------------------------------------------------------------------------

export interface DindPlan {
  readonly containerName: string;
  readonly sharedTmpVolume: string;
  /**
   * Session network name the sidecar attaches to (e.g. `nas-session-net-<sid>`).
   * Sourced from the `network` slice produced by ProxyStage, replacing the old
   * per-session private DinD network.
   */
  readonly networkName: string;
  /** dockerd HTTP(S)_PROXY endpoint (token-bearing proxy URL). */
  readonly proxyEndpoint: string;
  readonly shared: boolean;
  readonly disableCache: boolean;
  readonly readinessTimeoutMs: number;
  readonly outputOverrides: Pick<StageResult, "container" | "dind">;
}

type DindStageState = Pick<
  PipelineState,
  "workspace" | "container" | "network" | "proxy"
>;
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

  // The session network and proxy endpoint are produced by ProxyStage, which
  // now runs before DindStage. The sidecar attaches to this internal session
  // network instead of a private DinD-owned bridge, so its egress is
  // funnelled through the proxy.
  const networkName = input.network.networkName;
  const proxyEndpoint = input.proxy.proxyEndpoint;

  let containerName: string;
  let sharedTmpVolume: string;

  if (shared) {
    containerName = SHARED_CONTAINER_NAME;
    sharedTmpVolume = SHARED_TMP_VOLUME;
  } else {
    const sessionId = input.sessionId.slice(0, 8);
    containerName = `nas-dind-${sessionId}`;
    sharedTmpVolume = `nas-dind-tmp-${sessionId}`;
  }

  return {
    containerName,
    sharedTmpVolume,
    networkName,
    proxyEndpoint,
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
  "workspace" | "container" | "network" | "proxy",
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
  "workspace" | "container" | "network" | "proxy",
  Partial<Pick<StageResult, "container" | "dind">>,
  DindService,
  unknown
> {
  return {
    name: "DindStage",
    needs: ["workspace", "container", "network", "proxy"],

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
        proxyEndpoint: plan.proxyEndpoint,
        shared: plan.shared,
        disableCache: plan.disableCache,
        readinessTimeoutMs: plan.readinessTimeoutMs,
      }),
      () =>
        dind
          .teardownSidecar({
            containerName: plan.containerName,
            sharedTmpVolume: plan.sharedTmpVolume,
            networkName: plan.networkName,
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
  // The agent talks to the sidecar over DOCKER_HOST=tcp://<dind>:2375. That
  // hostname must bypass the agent's local proxy, so append the sidecar name to
  // the no_proxy lists ProxyStage already seeded. env.static is key-merged
  // (patch wins), so writing the full appended value here overrides ProxyStage's
  // baseline cleanly. Fall back to the loopback baseline if (unexpectedly)
  // ProxyStage left no value.
  const baseNoProxyLower =
    input.container.env.static.no_proxy ?? "localhost,127.0.0.1";
  const baseNoProxyUpper =
    input.container.env.static.NO_PROXY ?? "localhost,127.0.0.1";

  return mergeContainerPlan(input.container, {
    env: {
      static: {
        DOCKER_HOST: `tcp://${config.containerName}:${DIND_INTERNAL_PORT}`,
        NAS_DIND_CONTAINER_NAME: config.containerName,
        NAS_DIND_SHARED_TMP: SHARED_TMP_MOUNT_PATH,
        no_proxy: `${baseNoProxyLower},${config.containerName}`,
        NO_PROXY: `${baseNoProxyUpper},${config.containerName}`,
      },
    },
    extraRunArgs: ["-v", `${config.sharedTmpVolume}:${SHARED_TMP_MOUNT_PATH}`],
  });
}

// ---------------------------------------------------------------------------
// Re-export helper (used by tests)
// ---------------------------------------------------------------------------

export { buildDindSidecarArgs } from "../../docker/dind.ts";
