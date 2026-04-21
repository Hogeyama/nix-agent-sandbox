/**
 * NetworkApprovalService — network 承認フローの application service.
 *
 * CLI (`cli/network.ts`) と UI (`ui/routes/api.ts`, `ui/routes/sse.ts`) の
 * 両方から使われる。stages/*_service.ts がパイプライン実行時の lifecycle を
 * 扱うのに対し、このサービスは長寿命プロセス中に繰り返し呼ばれる CRUD 相当の
 * 操作 (pending 一覧、承認、拒否) を提供する。
 *
 * Live は `src/network/` の既存 primitive を薄くラップする。
 */

import { Context, Effect, Layer } from "effect";
import { sendBrokerRequest } from "../../network/broker.ts";
import type { ApprovalScope, PendingEntry } from "../../network/protocol.ts";
import {
  gcNetworkRuntime,
  listPendingEntries,
  type NetworkRuntimePaths,
  readSessionRegistry,
} from "../../network/registry.ts";

// ---------------------------------------------------------------------------
// NetworkApprovalService tag
// ---------------------------------------------------------------------------

export class NetworkApprovalService extends Context.Tag(
  "nas/NetworkApprovalService",
)<
  NetworkApprovalService,
  {
    readonly listPending: (
      paths: NetworkRuntimePaths,
    ) => Effect.Effect<PendingEntry[], Error>;
    readonly approve: (
      paths: NetworkRuntimePaths,
      sessionId: string,
      requestId: string,
      scope?: ApprovalScope,
    ) => Effect.Effect<void, Error>;
    readonly deny: (
      paths: NetworkRuntimePaths,
      sessionId: string,
      requestId: string,
      scope?: ApprovalScope,
    ) => Effect.Effect<void, Error>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export const NetworkApprovalServiceLive: Layer.Layer<NetworkApprovalService> =
  Layer.succeed(
    NetworkApprovalService,
    NetworkApprovalService.of({
      listPending: (paths) =>
        Effect.tryPromise({
          try: async () => {
            await gcNetworkRuntime(paths);
            return await listPendingEntries(paths);
          },
          catch: toError,
        }),

      approve: (paths, sessionId, requestId, scope) =>
        Effect.tryPromise({
          try: async () => {
            await gcNetworkRuntime(paths);
            const session = await readSessionRegistry(paths, sessionId);
            if (!session) {
              throw new Error(`Session not found: ${sessionId}`);
            }
            await sendBrokerRequest(session.brokerSocket, {
              type: "approve",
              requestId,
              scope,
            });
          },
          catch: toError,
        }),

      deny: (paths, sessionId, requestId, scope) =>
        Effect.tryPromise({
          try: async () => {
            await gcNetworkRuntime(paths);
            const session = await readSessionRegistry(paths, sessionId);
            if (!session) {
              throw new Error(`Session not found: ${sessionId}`);
            }
            await sendBrokerRequest(session.brokerSocket, {
              type: "deny",
              requestId,
              scope,
            });
          },
          catch: toError,
        }),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface NetworkApprovalServiceFakeConfig {
  readonly listPending?: (
    paths: NetworkRuntimePaths,
  ) => Effect.Effect<PendingEntry[], Error>;
  readonly approve?: (
    paths: NetworkRuntimePaths,
    sessionId: string,
    requestId: string,
    scope?: ApprovalScope,
  ) => Effect.Effect<void, Error>;
  readonly deny?: (
    paths: NetworkRuntimePaths,
    sessionId: string,
    requestId: string,
    scope?: ApprovalScope,
  ) => Effect.Effect<void, Error>;
}

export function makeNetworkApprovalServiceFake(
  overrides: NetworkApprovalServiceFakeConfig = {},
): Layer.Layer<NetworkApprovalService> {
  return Layer.succeed(
    NetworkApprovalService,
    NetworkApprovalService.of({
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
export function makeNetworkApprovalClient(
  layer: Layer.Layer<NetworkApprovalService> = NetworkApprovalServiceLive,
) {
  function run<A>(
    f: (
      s: Context.Tag.Service<NetworkApprovalService>,
    ) => Effect.Effect<A, Error>,
  ): Promise<A> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* NetworkApprovalService;
        return yield* f(svc);
      }).pipe(Effect.provide(layer)),
    );
  }

  return {
    listPending: (paths: NetworkRuntimePaths): Promise<PendingEntry[]> =>
      run((svc) => svc.listPending(paths)),
    approve: (
      paths: NetworkRuntimePaths,
      sessionId: string,
      requestId: string,
      scope?: ApprovalScope,
    ): Promise<void> =>
      run((svc) => svc.approve(paths, sessionId, requestId, scope)),
    deny: (
      paths: NetworkRuntimePaths,
      sessionId: string,
      requestId: string,
      scope?: ApprovalScope,
    ): Promise<void> =>
      run((svc) => svc.deny(paths, sessionId, requestId, scope)),
  };
}
