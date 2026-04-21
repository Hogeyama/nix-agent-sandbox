/**
 * AuditQueryService — audit log 読み出しの application service.
 *
 * CLI (`cli/audit.ts`) と UI (`ui/data.ts`) の両方から使われる。network /
 * hostexec の Approval service と同じく、stages/*_service.ts がパイプライン
 * 実行時の lifecycle を扱うのに対し、このサービスは長寿命プロセス中に繰り返し
 * 呼ばれる CRUD 相当の操作を提供する。
 *
 * Live は `src/audit/store.ts` の既存 primitive を薄くラップする。
 *
 * 設計メモ:
 *   - read-only service。write 側 (`appendAuditLog`) は触らない。audit 書き込み
 *     は broker の hot path から直接呼ばれており、service 層を挟むと呼び出し
 *     経路が複雑になるだけなので意図的にスコープ外にする。
 *   - service には `resolveAuditDir()` の default を持たせない。呼び出し側
 *     (CLI / UI) で明示解決して渡す。`NetworkRuntimePaths` / `HostExecRuntimePaths`
 *     を引数で受け取る既存 service と対称な形にして、テスト時に tmpdir を
 *     注入できるようにしておく。
 *   - `DEFAULT_EXCLUDE_COMMAND_PREFIXES` や `entries.slice(-limit)` のような UI
 *     固有の表示方針は service に押し込まない。UI 側 (`getAuditLogs`) に残す。
 *   - **引数順は `(auditDir, filter)`**。下位の `queryAuditLogs(filter, auditDir?)`
 *     とは逆である点に注意 (network の `(paths, ...)` 規約に揃えた)。
 */

import { Context, Effect, Layer } from "effect";
import { queryAuditLogs } from "../../audit/store.ts";
import type { AuditLogEntry, AuditLogFilter } from "../../audit/types.ts";

// ---------------------------------------------------------------------------
// AuditQueryService tag
// ---------------------------------------------------------------------------

export class AuditQueryService extends Context.Tag("nas/AuditQueryService")<
  AuditQueryService,
  {
    readonly query: (
      auditDir: string,
      filter: AuditLogFilter,
    ) => Effect.Effect<AuditLogEntry[], Error>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export const AuditQueryServiceLive: Layer.Layer<AuditQueryService> =
  Layer.succeed(
    AuditQueryService,
    AuditQueryService.of({
      query: (auditDir, filter) =>
        Effect.tryPromise({
          try: () => queryAuditLogs(filter, auditDir),
          catch: toError,
        }),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface AuditQueryServiceFakeConfig {
  readonly query?: (
    auditDir: string,
    filter: AuditLogFilter,
  ) => Effect.Effect<AuditLogEntry[], Error>;
}

export function makeAuditQueryServiceFake(
  overrides: AuditQueryServiceFakeConfig = {},
): Layer.Layer<AuditQueryService> {
  return Layer.succeed(
    AuditQueryService,
    AuditQueryService.of({
      query: overrides.query ?? (() => Effect.succeed([])),
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
export function makeAuditQueryClient(
  layer: Layer.Layer<AuditQueryService> = AuditQueryServiceLive,
) {
  function run<A>(
    f: (s: Context.Tag.Service<AuditQueryService>) => Effect.Effect<A, Error>,
  ): Promise<A> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* AuditQueryService;
        return yield* f(svc);
      }).pipe(Effect.provide(layer)),
    );
  }

  return {
    query: (
      auditDir: string,
      filter: AuditLogFilter,
    ): Promise<AuditLogEntry[]> => run((svc) => svc.query(auditDir, filter)),
  };
}
