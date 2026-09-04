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
 * 3. エージェントコンテナをサイドカーの network namespace に参加させる
 *    (`--network container:<サイドカー名>`)。これにより daemon は
 *    127.0.0.1:2375 で応答し、エージェントが起動した内部コンテナの公開ポートも
 *    エージェント自身の loopback に現れる — ローカルインストールされた Docker と
 *    同じ挙動になる。
 */

import { Effect, type Scope } from "effect";
import {
  DIND_INTERNAL_PORT,
  DIND_ROOTLESS_SOCKET_PATH,
  SHARED_CONTAINER_NAME,
  SHARED_TMP_MOUNT_PATH,
} from "../../docker/dind.ts";
import { containerNameForSession } from "../../docker/nas_resources.ts";
import { logInfo } from "../../log.ts";
import { LOCAL_PROXY_PORT } from "../../network/ports.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type {
  ContainerPlan,
  ExtraHost,
  PipelineState,
} from "../../pipeline/state.ts";
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
  /**
   * Host-to-IP mappings the sidecar's /etc/hosts must carry (e.g. the proxy
   * alias). The agent joins the sidecar's network namespace and cannot carry
   * its own --add-host, so these entries are wired onto the sidecar instead.
   */
  readonly extraHosts: readonly ExtraHost[];
  readonly shared: boolean;
  readonly disableCache: boolean;
  readonly readinessTimeoutMs: number;
  /**
   * Name of the agent container that will join this sidecar's network
   * namespace. Teardown uses it to check whether the agent is still
   * running before removing the sidecar out from under it.
   */
  readonly joinerContainerName: string;
  /**
   * Ports already bound inside the shared network namespace (the DinD daemon
   * port, the local proxy, and every forwarded port). Publishing an inner
   * container on one of these fails with EADDRINUSE once the agent joins the
   * sidecar's namespace.
   */
  readonly reservedPorts: readonly number[];
  readonly outputOverrides: Pick<StageResult, "container" | "dind">;
}

/**
 * Ports already bound inside the shared network namespace.
 *
 * Reads the forwarded set from the env ProxyStage seeded rather than from the
 * profile: ProxyStage unions the profile's ports with the observability
 * receiver port before binding them, so the profile alone under-reports.
 */
export function reservedNamespacePorts(
  forwardPortsEnv: string | undefined,
): number[] {
  const forwarded = (forwardPortsEnv ?? "")
    .split(",")
    .map((part) => Number.parseInt(part, 10))
    .filter((port) => Number.isInteger(port));
  return [DIND_INTERNAL_PORT, LOCAL_PROXY_PORT, ...forwarded];
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
    extraHosts: input.container.extraHosts,
    shared,
    disableCache,
    readinessTimeoutMs,
    joinerContainerName: containerNameForSession(input.sessionId),
    reservedPorts: reservedNamespacePorts(
      input.container.env.static.NAS_FORWARD_PORTS,
    ),
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
      logInfo(
        `[nas] DinD: ports already bound in the shared namespace: ${plan.reservedPorts.join(", ")} — publishing a container on one of these fails with EADDRINUSE`,
      );
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
        extraHosts: plan.extraHosts,
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
            joinerContainerName: plan.joinerContainerName,
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
  // The agent joins the sidecar's network namespace, so the daemon answers on
  // loopback and every port an inner container publishes lands on the agent's
  // own 127.0.0.1 -- what a locally installed Docker would do. `no_proxy`
  // needs no addition: ProxyStage's baseline already carries 127.0.0.1.
  const staticEnv: Record<string, string> = {
    DOCKER_HOST: `tcp://127.0.0.1:${DIND_INTERNAL_PORT}`,
    NAS_DIND_SHARED_TMP: SHARED_TMP_MOUNT_PATH,
  };
  // env.static is a key-merge in which the patch wins, so writing this
  // unconditionally would silently replace a value set through profile env.
  if (
    input.container.env.static.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ===
    undefined
  ) {
    staticEnv.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = DIND_ROOTLESS_SOCKET_PATH;
  }
  return mergeContainerPlan(input.container, {
    network: { mode: "container", containerName: config.containerName },
    env: { static: staticEnv },
    extraRunArgs: ["-v", `${config.sharedTmpVolume}:${SHARED_TMP_MOUNT_PATH}`],
  });
}

// ---------------------------------------------------------------------------
// Re-export helper (used by tests)
// ---------------------------------------------------------------------------

export { buildDindSidecarArgs } from "../../docker/dind.ts";
