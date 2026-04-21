/**
 * TerminalSessionService — dtach terminal session 操作の application service.
 *
 * CLI (`cli/session.ts`) と UI (`ui/data.ts`, `ui/routes/api.ts`,
 * `ui/routes/sse.ts`) の両方から使われる。先行 4 service (Network /
 * HostExec / Audit / SessionUi) と同じく、stages/*_service.ts がパイプライン
 * 実行時の lifecycle を扱うのに対し、このサービスは長寿命プロセス中に繰り返し
 * 呼ばれる CRUD 相当の操作を提供する。
 *
 * Live は `src/dtach/client.ts` の既存 primitive を薄くラップする。
 *
 * 設計メモ:
 *   - scope は listSessions / killClients の 2 method。
 *     shell session 起動 (`startShellSession` / `nextShellSessionId` /
 *     `removeShellSocketsForParent` / `removeOrphanShellSockets`) は
 *     SessionLaunchService 回に送るため意図的にここに入れない。
 *   - 引数順は `(runtimeDir, sessionId)` 固定。audit の `(auditDir, filter)` /
 *     network の `(paths, ...)` と対称な `(runtimeDir, ...)` 規約に揃える。
 *     `TerminalRuntimePaths` 型は作らず、dtach primitive の `runtimeDir?: string`
 *     と同じ 1 本 string 引数をそのまま service 契約にする。
 *   - `DtachSessionInfo` は `src/dtach/client.ts` の既存 export を type-only
 *     import で再利用する。domain 側で再定義しない。
 *   - `listSessions` が内部で呼ぶ `gcDtachRuntime` の副作用、および
 *     `killDtachClients` の master 除外 (`-a` / `-A` のみ kill) は primitive 側
 *     で保たれる observable behavior。薄い wrap なので service 経由でも維持。
 *   - `socketPathFor` の path traversal check (`assertWithin`) も primitive で
 *     同期的に throw されるものが Effect の error channel に素通しされる。
 *     test 4 で明示的にこの経路を縛る。
 */

import { Context, Effect, Layer } from "effect";
import {
  type DtachSessionInfo,
  dtachListSessions,
  killDtachClients,
  socketPathFor,
} from "../../dtach/client.ts";

export type { DtachSessionInfo };

// ---------------------------------------------------------------------------
// TerminalSessionService tag
// ---------------------------------------------------------------------------

export class TerminalSessionService extends Context.Tag(
  "nas/TerminalSessionService",
)<
  TerminalSessionService,
  {
    readonly listSessions: (
      runtimeDir: string,
    ) => Effect.Effect<DtachSessionInfo[], Error>;
    readonly killClients: (
      runtimeDir: string,
      sessionId: string,
    ) => Effect.Effect<number, Error>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export const TerminalSessionServiceLive: Layer.Layer<TerminalSessionService> =
  Layer.succeed(
    TerminalSessionService,
    TerminalSessionService.of({
      listSessions: (runtimeDir) =>
        Effect.tryPromise({
          try: () => dtachListSessions(runtimeDir),
          catch: toError,
        }),

      killClients: (runtimeDir, sessionId) =>
        Effect.tryPromise({
          // socketPathFor は同期的に path traversal 等で throw する場合が
          // あるため、try 内で呼んで error channel に流す。成功時は
          // killDtachClients を await してその戻り値を service 結果にする。
          try: async () => {
            const socketPath = socketPathFor(sessionId, runtimeDir);
            return await killDtachClients(socketPath);
          },
          catch: toError,
        }),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface TerminalSessionServiceFakeConfig {
  readonly listSessions?: (
    runtimeDir: string,
  ) => Effect.Effect<DtachSessionInfo[], Error>;
  readonly killClients?: (
    runtimeDir: string,
    sessionId: string,
  ) => Effect.Effect<number, Error>;
}

export function makeTerminalSessionServiceFake(
  overrides: TerminalSessionServiceFakeConfig = {},
): Layer.Layer<TerminalSessionService> {
  return Layer.succeed(
    TerminalSessionService,
    TerminalSessionService.of({
      listSessions: overrides.listSessions ?? (() => Effect.succeed([])),
      killClients: overrides.killClients ?? (() => Effect.succeed(0)),
    }),
  );
}

// ---------------------------------------------------------------------------
// Plain-async adapter
// ---------------------------------------------------------------------------

/**
 * plain async ラッパ。Effect ランタイムを介さず、既存の async/await コードから
 * 直接呼べる。Live Layer を毎回 provide するだけなので副作用コストは軽い。
 *
 * CLI サブコマンドや UI route はこれを経由して service を使う。Fake を
 * 差し込みたいテストは Effect API を直接呼び、この関数は使わない。
 */
export function makeTerminalSessionClient(
  layer: Layer.Layer<TerminalSessionService> = TerminalSessionServiceLive,
) {
  function run<A>(
    f: (
      s: Context.Tag.Service<TerminalSessionService>,
    ) => Effect.Effect<A, Error>,
  ): Promise<A> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* TerminalSessionService;
        return yield* f(svc);
      }).pipe(Effect.provide(layer)),
    );
  }

  return {
    listSessions: (runtimeDir: string): Promise<DtachSessionInfo[]> =>
      run((svc) => svc.listSessions(runtimeDir)),
    killClients: (runtimeDir: string, sessionId: string): Promise<number> =>
      run((svc) => svc.killClients(runtimeDir, sessionId)),
  };
}
