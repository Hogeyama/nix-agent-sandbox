/**
 * ContainerQueryService — read-only container 状態取得の application service.
 *
 * UI (`ui/data.ts`) で `dockerListContainerNames` + `dockerInspectContainer`
 * + `isNasManagedContainer` filter + session record join のシーケンスを
 * 個別に組み立てていた箇所を 1 service に寄せる。Phase 2 で導入された
 * `SessionLaunchService` の `removeOrphanShellSockets` が
 * `runningParentIds: ReadonlySet<string>` を引数に取る契約だったため、
 * `ui/data.ts#cleanContainers` 内で docker primitive を直叩きして
 * 集合を組み立てる中間状態が残っていた。本 service の
 * `collectRunningParentIds` でそれも解消する。
 *
 * Live は `DockerService` (新メソッド `inspect` / `listContainerNames`) と
 * `SessionUiService` を Layer 依存で受け取る。Docker primitive は mock 不能
 * のため、fake DockerService + fake SessionUiService を `Layer.mergeAll` で
 * 差し込む形で D2 logic を unit test 可能にする (effect-separation
 * SKILL.md L143-146)。
 *
 * 設計メモ:
 *   - `R = DockerService | SessionUiService` は Live の依存マニフェストで
 *     あり、最小化目標ではない (SKILL.md L172)。default layer の R=never
 *     閉包は plain-async adapter の責務として `Layer.mergeAll(...)` を
 *     `Layer.provide` する形で達成する。Live factory 内 nested provide
 *     anti-pattern (SKILL.md L185) は避ける。
 *   - `listManaged()` を public 露出するのは `collectRunningParentIds()`
 *     との対称性 (両方 docker-only view) を取るため。
 *   - 直列ループ + `Effect.either` で個別 skip という legacy try/catch-
 *     continue 挙動を保存する。並列化 (`Effect.all({concurrency})`) は
 *     CLI 側 (Phase 3 Commit 5) で別途検討。
 */

import { Context, Effect, Layer } from "effect";
import {
  isNasManagedContainer,
  NAS_SESSION_ID_LABEL,
} from "../../docker/nas_resources.ts";
import { DockerService, DockerServiceLive } from "../../services/docker.ts";
import type { SessionRuntimePaths } from "../../sessions/store.ts";
import { SessionUiService, SessionUiServiceLive } from "../session.ts";
import { joinSessionsToContainers, type NasContainerInfo } from "./types.ts";

// ---------------------------------------------------------------------------
// ContainerQueryService tag
// ---------------------------------------------------------------------------

export class ContainerQueryService extends Context.Tag(
  "nas/ContainerQueryService",
)<
  ContainerQueryService,
  {
    readonly listManaged: () => Effect.Effect<NasContainerInfo[], Error>;
    readonly listManagedWithSessions: (
      paths: SessionRuntimePaths,
    ) => Effect.Effect<NasContainerInfo[], Error>;
    readonly collectRunningParentIds: () => Effect.Effect<
      ReadonlySet<string>,
      Error
    >;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const ContainerQueryServiceLive: Layer.Layer<
  ContainerQueryService,
  never,
  DockerService | SessionUiService
> = Layer.effect(
  ContainerQueryService,
  Effect.gen(function* () {
    const docker = yield* DockerService;
    const sessionUi = yield* SessionUiService;

    const listManaged = (): Effect.Effect<NasContainerInfo[], Error> =>
      Effect.gen(function* () {
        const names = yield* docker.listContainerNames();
        const containers: NasContainerInfo[] = [];
        for (const name of names) {
          const result = yield* Effect.either(docker.inspect(name));
          if (result._tag === "Left") {
            // container disappeared between list and inspect; preserves
            // legacy try/catch-continue behavior
            continue;
          }
          const details = result.right;
          if (!isNasManagedContainer(details.labels, details.name)) continue;
          containers.push({
            name: details.name,
            running: details.running,
            labels: details.labels,
            networks: details.networks,
            startedAt: details.startedAt,
          });
        }
        return containers;
      });

    return ContainerQueryService.of({
      listManaged,

      listManagedWithSessions: (paths) =>
        Effect.gen(function* () {
          const containers = yield* listManaged();
          const sessions = yield* sessionUi.list(paths);
          return joinSessionsToContainers(containers, sessions);
        }),

      collectRunningParentIds: () =>
        Effect.gen(function* () {
          const names = yield* docker.listContainerNames();
          const running = new Set<string>();
          for (const name of names) {
            const result = yield* Effect.either(docker.inspect(name));
            if (result._tag === "Left") {
              // container disappeared between list and inspect; preserves
              // legacy try/catch-continue behavior
              continue;
            }
            const details = result.right;
            if (!details.running) continue;
            const sid = details.labels[NAS_SESSION_ID_LABEL];
            if (sid) running.add(sid);
          }
          return running as ReadonlySet<string>;
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface ContainerQueryServiceFakeConfig {
  readonly listManaged?: () => Effect.Effect<NasContainerInfo[], Error>;
  readonly listManagedWithSessions?: (
    paths: SessionRuntimePaths,
  ) => Effect.Effect<NasContainerInfo[], Error>;
  readonly collectRunningParentIds?: () => Effect.Effect<
    ReadonlySet<string>,
    Error
  >;
}

export function makeContainerQueryServiceFake(
  overrides: ContainerQueryServiceFakeConfig = {},
): Layer.Layer<ContainerQueryService> {
  return Layer.succeed(
    ContainerQueryService,
    ContainerQueryService.of({
      listManaged: overrides.listManaged ?? (() => Effect.succeed([])),
      listManagedWithSessions:
        overrides.listManagedWithSessions ?? (() => Effect.succeed([])),
      collectRunningParentIds:
        overrides.collectRunningParentIds ??
        (() => Effect.succeed(new Set<string>() as ReadonlySet<string>)),
    }),
  );
}

// ---------------------------------------------------------------------------
// Plain-async adapter
// ---------------------------------------------------------------------------

/**
 * Module-level Layer description. `Layer` は pure description (副作用なし)
 * なので module-level const は SKILL.md L385 の制約に整合する。
 */
const liveDeps: Layer.Layer<DockerService | SessionUiService> = Layer.mergeAll(
  DockerServiceLive,
  SessionUiServiceLive,
);

/**
 * plain async ラッパ。Effect ランタイムを介さず、既存の async/await コードから
 * 直接呼べる。Live Layer + 依存 (DockerService / SessionUiService) を毎回
 * provide するだけなので副作用コストは軽い。
 *
 * CLI / UI route はこれを経由して service を使う。Fake を差し込みたい
 * テストは Effect API を直接呼び、この関数は使わない。
 */
export function makeContainerQueryClient(
  layer: Layer.Layer<
    ContainerQueryService,
    never,
    DockerService | SessionUiService
  > = ContainerQueryServiceLive,
) {
  // Live deps を provide して R=never に閉じる。fake を差し込みたい場合は
  // fake DockerService + fake SessionUiService を含む `Layer.Layer<
  // ContainerQueryService>` (R=never) を直接渡してもよい — その場合は
  // ここで再度 provide しても余分な依存を上書きするだけで害はない。
  const provided: Layer.Layer<ContainerQueryService> = layer.pipe(
    Layer.provide(liveDeps),
  );

  function run<A>(
    f: (
      s: Context.Tag.Service<ContainerQueryService>,
    ) => Effect.Effect<A, Error>,
  ): Promise<A> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ContainerQueryService;
        return yield* f(svc);
      }).pipe(Effect.provide(provided)),
    );
  }

  return {
    listManaged: (): Promise<NasContainerInfo[]> =>
      run((svc) => svc.listManaged()),
    listManagedWithSessions: (
      paths: SessionRuntimePaths,
    ): Promise<NasContainerInfo[]> =>
      run((svc) => svc.listManagedWithSessions(paths)),
    collectRunningParentIds: (): Promise<ReadonlySet<string>> =>
      run((svc) => svc.collectRunningParentIds()),
  };
}
