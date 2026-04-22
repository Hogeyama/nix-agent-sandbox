/**
 * ContainerLifecycleService — write-side container 操作の application service.
 *
 * UI (`ui/data.ts`) で個別に組まれていた以下 3 つのシーケンスを 1 service に
 * 寄せる:
 *
 *   - `stopContainer(name)`: docker inspect で `parentSessionId` を抽出
 *     (失敗握りつぶし) → `dockerStop` → 親 session に紐づく shell socket 掃除
 *   - `cleanContainers()`: `cleanNasContainers` 実行 + running parent set 取得 +
 *     orphan shell socket 掃除
 *   - `startShellSession(containerName)`: docker inspect → managed/running guard
 *     → label 抽出 → SessionLaunchService へ委譲
 *
 * Phase 2 の `SessionLaunchService` で残置されていた typed error
 * (`ContainerNotRunningError` / `NotNasManagedContainerError`) と `docker
 * inspect` guard を本 service に集約する。Phase 3 Commit 2 (`ContainerQueryService`)
 * で確立した `liveDeps` + `Layer.mergeAll` 閉包パターンをそのまま踏襲。
 *
 * 設計メモ:
 *   - error channel は `Effect.Effect<T, Error>` に統一。typed error は
 *     `Error` のサブクラスを `Effect.fail(new XxxError(...))` で投げる。
 *     plain-async client adapter は `Effect.runPromiseExit` + `Cause.failureOption`
 *     で typed error を unwrap して直接 throw し、UI route の
 *     `instanceof` 分岐の identity を保つ。
 *   - selection B: Live が `DockerService | SessionLaunchService |
 *     ContainerQueryService` を Layer 依存。Docker primitive mock 不能の
 *     ため fake DockerService を差し込んで D2 logic を unit test する。
 *   - `cleanContainers` の中で `cleanNasContainers(backend)` を呼ぶが、
 *     backend は file-private な `makeBackendFromDockerService(docker)`
 *     adapter で fake DockerService 経由で全貫通させる (DI 第三案)。
 *     `defaultBackend` は本 commit では撤廃しない (将来 commit で defer)。
 *   - `stopContainer` の inspect 失敗握りつぶしは `Effect.either` で吸収し、
 *     `parentSessionId` が取れた時のみ `removeShellSocketsForParent` を呼ぶ
 *     legacy 挙動を保存する (data.ts wrapper の try/catch ロジックと同型)。
 *   - `startShellSession` の label 欠落 (`!parentSessionId`) は generic
 *     `Error` として throw。message に `NAS_SESSION_ID_LABEL` を含める
 *     (元の wrapper と同じ contract)。
 */

import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import {
  type ContainerCleanBackend,
  type ContainerCleanResult,
  cleanNasContainers,
} from "../../container_clean.ts";
import {
  isNasManagedContainer,
  NAS_SESSION_ID_LABEL,
} from "../../docker/nas_resources.ts";
import { DockerService, DockerServiceLive } from "../../services/docker.ts";
import { SessionLaunchService, SessionLaunchServiceLive } from "../launch.ts";
import { SessionUiServiceLive } from "../session.ts";
import { ContainerQueryService, ContainerQueryServiceLive } from "./service.ts";
import {
  ContainerNotRunningError,
  NotNasManagedContainerError,
} from "./types.ts";

// ---------------------------------------------------------------------------
// ContainerLifecycleService tag
// ---------------------------------------------------------------------------

export class ContainerLifecycleService extends Context.Tag(
  "nas/ContainerLifecycleService",
)<
  ContainerLifecycleService,
  {
    readonly stopContainer: (
      terminalRuntimeDir: string,
      name: string,
    ) => Effect.Effect<void, Error>;
    readonly cleanContainers: (
      terminalRuntimeDir: string,
    ) => Effect.Effect<ContainerCleanResult, Error>;
    readonly startShellSession: (
      terminalRuntimeDir: string,
      containerName: string,
    ) => Effect.Effect<{ dtachSessionId: string }, Error>;
  }
>() {}

// ---------------------------------------------------------------------------
// Internal: DockerService -> ContainerCleanBackend adapter
// ---------------------------------------------------------------------------

/**
 * `cleanNasContainers` は `ContainerCleanBackend` interface (Promise-based) を
 * 受ける既存実装。`DockerService` (Effect) 経由で全 method を貫通させるため、
 * `Effect.runPromise` でラップして file-private adapter を生やす。
 *
 * 失敗時は `.catch(e => { throw e instanceof Error ? e : new Error(String(e)) })`
 * で正規化し、`Effect.runPromise` がデフォルトで投げる `FiberFailure` 文字列化
 * (元のメッセージが取れない) を回避する。
 */
function makeBackendFromDockerService(
  docker: Context.Tag.Service<DockerService>,
): ContainerCleanBackend {
  const normalize = (e: unknown): Error =>
    e instanceof Error ? e : new Error(String(e));
  return {
    listContainerNames: () =>
      Effect.runPromise(docker.listContainerNames()).catch((e) => {
        throw normalize(e);
      }),
    inspectContainer: (name) =>
      Effect.runPromise(docker.inspect(name)).catch((e) => {
        throw normalize(e);
      }),
    listNetworkNames: () =>
      Effect.runPromise(docker.listNetworkNames()).catch((e) => {
        throw normalize(e);
      }),
    inspectNetwork: (name) =>
      Effect.runPromise(docker.inspectNetwork(name)).catch((e) => {
        throw normalize(e);
      }),
    listVolumeNames: () =>
      Effect.runPromise(docker.listVolumeNames()).catch((e) => {
        throw normalize(e);
      }),
    inspectVolume: (name) =>
      Effect.runPromise(docker.inspectVolume(name)).catch((e) => {
        throw normalize(e);
      }),
    stopContainer: (name) =>
      Effect.runPromise(docker.stop(name, { timeoutSeconds: 0 })).catch((e) => {
        throw normalize(e);
      }),
    removeContainer: (name) =>
      Effect.runPromise(docker.rm(name)).catch((e) => {
        throw normalize(e);
      }),
    removeNetwork: (name) =>
      Effect.runPromise(docker.networkRemove(name)).catch((e) => {
        throw normalize(e);
      }),
    removeVolume: (name) =>
      Effect.runPromise(docker.volumeRemove(name)).catch((e) => {
        throw normalize(e);
      }),
  };
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const ContainerLifecycleServiceLive: Layer.Layer<
  ContainerLifecycleService,
  never,
  DockerService | SessionLaunchService | ContainerQueryService
> = Layer.effect(
  ContainerLifecycleService,
  Effect.gen(function* () {
    const docker = yield* DockerService;
    const launch = yield* SessionLaunchService;
    const query = yield* ContainerQueryService;

    return ContainerLifecycleService.of({
      stopContainer: (terminalRuntimeDir, name) =>
        Effect.gen(function* () {
          // inspect は失敗握りつぶし (container がすでに消えている可能性)。
          // wrapper の try/catch ロジックと同型: parentSessionId が取れた時のみ
          // removeShellSocketsForParent を呼ぶ。
          const inspectEither = yield* Effect.either(docker.inspect(name));
          let parentSessionId: string | undefined;
          if (inspectEither._tag === "Right") {
            parentSessionId = inspectEither.right.labels[NAS_SESSION_ID_LABEL];
          }
          yield* docker.stop(name);
          if (parentSessionId) {
            yield* launch.removeShellSocketsForParent(
              terminalRuntimeDir,
              parentSessionId,
            );
          }
        }),

      cleanContainers: (terminalRuntimeDir) =>
        Effect.gen(function* () {
          const backend = makeBackendFromDockerService(docker);
          const result = yield* Effect.tryPromise({
            try: () => cleanNasContainers(backend),
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          });
          // `removeOrphanShellSockets` は docker 依存を切り離した契約なので、
          // running parent 集合は ContainerQueryService 経由で取得する。
          const runningParents = yield* query.collectRunningParentIds();
          yield* launch.removeOrphanShellSockets(
            terminalRuntimeDir,
            runningParents,
          );
          return result;
        }),

      startShellSession: (terminalRuntimeDir, containerName) =>
        Effect.gen(function* () {
          const details = yield* docker.inspect(containerName);
          if (!isNasManagedContainer(details.labels, details.name)) {
            return yield* Effect.fail(
              new NotNasManagedContainerError(containerName),
            );
          }
          if (!details.running) {
            return yield* Effect.fail(
              new ContainerNotRunningError(containerName),
            );
          }
          const parentSessionId = details.labels[NAS_SESSION_ID_LABEL];
          if (!parentSessionId) {
            return yield* Effect.fail(
              new Error(
                `Container ${containerName} has no ${NAS_SESSION_ID_LABEL} label`,
              ),
            );
          }
          return yield* launch.startShellSession(terminalRuntimeDir, {
            containerName,
            parentSessionId,
          });
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface ContainerLifecycleServiceFakeConfig {
  readonly stopContainer?: (
    terminalRuntimeDir: string,
    name: string,
  ) => Effect.Effect<void, Error>;
  readonly cleanContainers?: (
    terminalRuntimeDir: string,
  ) => Effect.Effect<ContainerCleanResult, Error>;
  readonly startShellSession?: (
    terminalRuntimeDir: string,
    containerName: string,
  ) => Effect.Effect<{ dtachSessionId: string }, Error>;
}

export function makeContainerLifecycleServiceFake(
  overrides: ContainerLifecycleServiceFakeConfig = {},
): Layer.Layer<ContainerLifecycleService> {
  return Layer.succeed(
    ContainerLifecycleService,
    ContainerLifecycleService.of({
      stopContainer: overrides.stopContainer ?? (() => Effect.void),
      cleanContainers:
        overrides.cleanContainers ??
        (() =>
          Effect.succeed({
            removedContainers: [],
            removedNetworks: [],
            removedVolumes: [],
          })),
      startShellSession:
        overrides.startShellSession ??
        ((_runtimeDir, containerName) =>
          Effect.succeed({ dtachSessionId: `shell-${containerName}.1` })),
    }),
  );
}

// ---------------------------------------------------------------------------
// Plain-async adapter
// ---------------------------------------------------------------------------

/**
 * Module-level Layer description で transitive deps を 1 階層で閉じる。
 * `ContainerQueryServiceLive` 自身は `DockerService | SessionUiService` を
 * 必要とするので、ここで提供して `R = never` の `ContainerQueryService`
 * Layer に変換する。
 *
 * Live factory 内で nested provide する anti-pattern (SKILL.md L185) を
 * 避けるため、`Layer.mergeAll` で全ての依存を 1 箇所にまとめる。
 */
const liveDeps: Layer.Layer<
  DockerService | SessionLaunchService | ContainerQueryService
> = Layer.mergeAll(
  DockerServiceLive,
  SessionLaunchServiceLive,
  ContainerQueryServiceLive.pipe(
    Layer.provide(Layer.mergeAll(DockerServiceLive, SessionUiServiceLive)),
  ),
);

/**
 * plain async ラッパ。Effect ランタイムを介さず、既存の async/await コードから
 * 直接呼べる。`Effect.runPromiseExit` で Exit を受け、`Cause.failureOption` で
 * typed error を unwrap してそのまま throw することで、UI route の
 * `instanceof ContainerNotRunningError` / `instanceof NotNasManagedContainerError`
 * 分岐の identity を保つ。
 */
export function makeContainerLifecycleClient(
  layer: Layer.Layer<
    ContainerLifecycleService,
    never,
    DockerService | SessionLaunchService | ContainerQueryService
  > = ContainerLifecycleServiceLive,
) {
  const provided: Layer.Layer<ContainerLifecycleService> = layer.pipe(
    Layer.provide(liveDeps),
  );

  async function run<A>(
    f: (
      s: Context.Tag.Service<ContainerLifecycleService>,
    ) => Effect.Effect<A, Error>,
  ): Promise<A> {
    const program = Effect.flatMap(ContainerLifecycleService, f);
    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(provided)),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) {
      // typed error を素通し: instanceof identity 保持
      throw failure.value;
    }
    throw new Error(`Defect or interruption: ${Cause.pretty(exit.cause)}`);
  }

  return {
    stopContainer: (terminalRuntimeDir: string, name: string): Promise<void> =>
      run((svc) => svc.stopContainer(terminalRuntimeDir, name)),
    cleanContainers: (
      terminalRuntimeDir: string,
    ): Promise<ContainerCleanResult> =>
      run((svc) => svc.cleanContainers(terminalRuntimeDir)),
    startShellSession: (
      terminalRuntimeDir: string,
      containerName: string,
    ): Promise<{ dtachSessionId: string }> =>
      run((svc) => svc.startShellSession(terminalRuntimeDir, containerName)),
  };
}
