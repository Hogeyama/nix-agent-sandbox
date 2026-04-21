/**
 * HostExecApprovalService — hostexec 承認フローの application service.
 *
 * CLI (`cli/hostexec.ts`) と UI (`ui/routes/api.ts`, `ui/routes/sse.ts`) の
 * 両方から使われる。stages/*_service.ts がパイプライン実行時の lifecycle を
 * 扱うのに対し、このサービスは長寿命プロセス中に繰り返し呼ばれる CRUD 相当の
 * 操作 (pending 一覧、承認、拒否) を提供する。
 *
 * Live は `src/hostexec/` の既存 primitive を薄くラップする。
 *
 * 設計メモ:
 *   - gc は listPending でのみ呼び、approve/deny では呼ばない。これは既存の
 *     cli/hostexec.ts と ui/data.ts の挙動を維持するためで、承認/拒否の
 *     ホットパスに stale session スキャンのコストを乗せないことが意図。
 *   - deny は scope を受け取らない。broker protocol (`DenyRequest`) が
 *     scope を持たない形のため、型レベルで scope を渡せないようにする。
 */

import { Context, Effect, Layer } from "effect";
import type { HostExecPromptScope } from "../../config/types.ts";
import { sendHostExecBrokerRequest } from "../../hostexec/broker.ts";
import {
  gcHostExecRuntime,
  type HostExecRuntimePaths,
  listHostExecPendingEntries,
  readHostExecSessionRegistry,
} from "../../hostexec/registry.ts";
import type { HostExecPendingEntry } from "../../hostexec/types.ts";

// ---------------------------------------------------------------------------
// HostExecApprovalService tag
// ---------------------------------------------------------------------------

export class HostExecApprovalService extends Context.Tag(
  "nas/HostExecApprovalService",
)<
  HostExecApprovalService,
  {
    readonly listPending: (
      paths: HostExecRuntimePaths,
    ) => Effect.Effect<HostExecPendingEntry[], Error>;
    readonly approve: (
      paths: HostExecRuntimePaths,
      sessionId: string,
      requestId: string,
      scope?: HostExecPromptScope,
    ) => Effect.Effect<void, Error>;
    readonly deny: (
      paths: HostExecRuntimePaths,
      sessionId: string,
      requestId: string,
    ) => Effect.Effect<void, Error>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export const HostExecApprovalServiceLive: Layer.Layer<HostExecApprovalService> =
  Layer.succeed(
    HostExecApprovalService,
    HostExecApprovalService.of({
      listPending: (paths) =>
        Effect.tryPromise({
          try: async () => {
            await gcHostExecRuntime(paths);
            return await listHostExecPendingEntries(paths);
          },
          catch: toError,
        }),

      approve: (paths, sessionId, requestId, scope) =>
        Effect.tryPromise({
          try: async () => {
            const session = await readHostExecSessionRegistry(paths, sessionId);
            if (!session) {
              throw new Error(`Session not found: ${sessionId}`);
            }
            await sendHostExecBrokerRequest(session.brokerSocket, {
              type: "approve",
              requestId,
              scope,
            });
          },
          catch: toError,
        }),

      deny: (paths, sessionId, requestId) =>
        Effect.tryPromise({
          try: async () => {
            const session = await readHostExecSessionRegistry(paths, sessionId);
            if (!session) {
              throw new Error(`Session not found: ${sessionId}`);
            }
            await sendHostExecBrokerRequest(session.brokerSocket, {
              type: "deny",
              requestId,
            });
          },
          catch: toError,
        }),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface HostExecApprovalServiceFakeConfig {
  readonly listPending?: (
    paths: HostExecRuntimePaths,
  ) => Effect.Effect<HostExecPendingEntry[], Error>;
  readonly approve?: (
    paths: HostExecRuntimePaths,
    sessionId: string,
    requestId: string,
    scope?: HostExecPromptScope,
  ) => Effect.Effect<void, Error>;
  readonly deny?: (
    paths: HostExecRuntimePaths,
    sessionId: string,
    requestId: string,
  ) => Effect.Effect<void, Error>;
}

export function makeHostExecApprovalServiceFake(
  overrides: HostExecApprovalServiceFakeConfig = {},
): Layer.Layer<HostExecApprovalService> {
  return Layer.succeed(
    HostExecApprovalService,
    HostExecApprovalService.of({
      listPending: overrides.listPending ?? (() => Effect.succeed([])),
      approve: overrides.approve ?? (() => Effect.void),
      deny: overrides.deny ?? (() => Effect.void),
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
export function makeHostExecApprovalClient(
  layer: Layer.Layer<HostExecApprovalService> = HostExecApprovalServiceLive,
) {
  function run<A>(
    f: (
      s: Context.Tag.Service<HostExecApprovalService>,
    ) => Effect.Effect<A, Error>,
  ): Promise<A> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* HostExecApprovalService;
        return yield* f(svc);
      }).pipe(Effect.provide(layer)),
    );
  }

  return {
    listPending: (
      paths: HostExecRuntimePaths,
    ): Promise<HostExecPendingEntry[]> => run((svc) => svc.listPending(paths)),
    approve: (
      paths: HostExecRuntimePaths,
      sessionId: string,
      requestId: string,
      scope?: HostExecPromptScope,
    ): Promise<void> =>
      run((svc) => svc.approve(paths, sessionId, requestId, scope)),
    deny: (
      paths: HostExecRuntimePaths,
      sessionId: string,
      requestId: string,
    ): Promise<void> => run((svc) => svc.deny(paths, sessionId, requestId)),
  };
}
