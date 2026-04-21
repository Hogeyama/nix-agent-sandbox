/**
 * SessionUiService — session record 読み書きの application service.
 *
 * CLI (`cli/session.ts`) と UI (`ui/data.ts`, `ui/routes/api.ts`) の両方から
 * 使われる。stages/session_store/ の `SessionStoreService` がパイプライン実行時
 * の lifecycle (create / delete / ensurePaths) を扱うのに対し、このサービスは
 * 長寿命プロセス中に UI / CLI から繰り返し呼ばれる CRUD 相当の操作
 * (list / rename / ack) を提供する。Tag 文字列も `nas/SessionUiService` と
 * して `nas/SessionStoreService` とは別名空間にする。
 *
 * Live は `src/sessions/store.ts` の既存 primitive を薄くラップする。
 *
 * 設計メモ:
 *   - scope は list / acknowledgeTurn / rename の 3 つだけ。`createSession` /
 *     `deleteSession` / `readSession` / `updateSessionTurn` /
 *     `ensureSessionRuntimePaths` は stages 側ライフサイクルや hook 専用なので
 *     意図的にこの service には入れない。
 *   - `resolveSessionRuntimePaths` も service に入れない。pure な path 解決は
 *     CLI / UI それぞれで呼び、`SessionRuntimePaths` を引数として渡す。先行
 *     3 service (`NetworkRuntimePaths` / `HostExecRuntimePaths` / `auditDir`) と
 *     対称。
 *   - error message は store.ts が投げる `"Session not found: ${id}"` /
 *     `"Cannot acknowledge turn in state: ${turn}"` をそのまま保存する。
 *     `src/ui/routes/api.ts` の `startsWith("Session not found:")` /
 *     `startsWith("Cannot acknowledge turn in state:")` の prefix-match 契約を
 *     保つため。Phase 3 で `Data.TaggedError` に移行する予定。
 */

import { Context, Effect, Layer } from "effect";
import {
  acknowledgeSessionTurn,
  listSessions,
  type SessionRecord,
  type SessionRuntimePaths,
  updateSessionName,
} from "../../sessions/store.ts";

// ---------------------------------------------------------------------------
// SessionUiService tag
// ---------------------------------------------------------------------------

export class SessionUiService extends Context.Tag("nas/SessionUiService")<
  SessionUiService,
  {
    readonly list: (
      paths: SessionRuntimePaths,
    ) => Effect.Effect<SessionRecord[], Error>;
    readonly acknowledgeTurn: (
      paths: SessionRuntimePaths,
      sessionId: string,
    ) => Effect.Effect<SessionRecord, Error>;
    readonly rename: (
      paths: SessionRuntimePaths,
      sessionId: string,
      name: string,
    ) => Effect.Effect<SessionRecord, Error>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export const SessionUiServiceLive: Layer.Layer<SessionUiService> =
  Layer.succeed(
    SessionUiService,
    SessionUiService.of({
      list: (paths) =>
        Effect.tryPromise({
          try: () => listSessions(paths),
          catch: toError,
        }),

      acknowledgeTurn: (paths, sessionId) =>
        Effect.tryPromise({
          try: () => acknowledgeSessionTurn(paths, sessionId),
          catch: toError,
        }),

      rename: (paths, sessionId, name) =>
        Effect.tryPromise({
          try: () => updateSessionName(paths, sessionId, name),
          catch: toError,
        }),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface SessionUiServiceFakeConfig {
  readonly list?: (
    paths: SessionRuntimePaths,
  ) => Effect.Effect<SessionRecord[], Error>;
  readonly acknowledgeTurn?: (
    paths: SessionRuntimePaths,
    sessionId: string,
  ) => Effect.Effect<SessionRecord, Error>;
  readonly rename?: (
    paths: SessionRuntimePaths,
    sessionId: string,
    name: string,
  ) => Effect.Effect<SessionRecord, Error>;
}

function defaultFakeRecord(sessionId: string): SessionRecord {
  return {
    sessionId,
    agent: "unknown",
    profile: "unknown",
    turn: "user-turn",
    startedAt: "1970-01-01T00:00:00.000Z",
    lastEventAt: "1970-01-01T00:00:00.000Z",
  };
}

export function makeSessionUiServiceFake(
  overrides: SessionUiServiceFakeConfig = {},
): Layer.Layer<SessionUiService> {
  return Layer.succeed(
    SessionUiService,
    SessionUiService.of({
      list: overrides.list ?? (() => Effect.succeed([])),
      acknowledgeTurn:
        overrides.acknowledgeTurn ??
        ((_paths, sessionId) => Effect.succeed(defaultFakeRecord(sessionId))),
      rename:
        overrides.rename ??
        ((_paths, sessionId, name) =>
          Effect.succeed({ ...defaultFakeRecord(sessionId), name })),
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
export function makeSessionUiClient(
  layer: Layer.Layer<SessionUiService> = SessionUiServiceLive,
) {
  function run<A>(
    f: (s: Context.Tag.Service<SessionUiService>) => Effect.Effect<A, Error>,
  ): Promise<A> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionUiService;
        return yield* f(svc);
      }).pipe(Effect.provide(layer)),
    );
  }

  return {
    list: (paths: SessionRuntimePaths): Promise<SessionRecord[]> =>
      run((svc) => svc.list(paths)),
    acknowledgeTurn: (
      paths: SessionRuntimePaths,
      sessionId: string,
    ): Promise<SessionRecord> =>
      run((svc) => svc.acknowledgeTurn(paths, sessionId)),
    rename: (
      paths: SessionRuntimePaths,
      sessionId: string,
      name: string,
    ): Promise<SessionRecord> =>
      run((svc) => svc.rename(paths, sessionId, name)),
  };
}
