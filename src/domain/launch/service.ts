/**
 * SessionLaunchService — dtach session の起動・shell 派生・掃除を束ねる
 * application service.
 *
 * UI (`src/ui/launch.ts`, `src/ui/data.ts`) 側で個別に組まれていた
 * `shellEscape` + `socketPathFor` + `dtachNewSession` + 失敗時 `safeRemove`
 * のシーケンスを 1 箇所に寄せる。CLI の `runInsideDtach` (`src/cli.ts`) は
 * self-exec 一発呼びで CRUD 定義外なので scope 外。
 *
 * 先行 5 service (Network / HostExec / Audit / SessionUi / Terminal) と同じく
 * `stages/*_service.ts` がパイプライン実行時の lifecycle を扱うのに対し、
 * このサービスは長寿命プロセス中に UI から繰り返し呼ばれる CRUD 相当の
 * 操作を提供する。
 *
 * Live は `src/dtach/client.ts` の既存 primitive を `Effect.tryPromise` で
 * 薄くラップする。
 *
 * 設計メモ:
 *   - scope は `launchAgentSession` / `startShellSession` /
 *     `removeShellSocketsForParent` / `removeOrphanShellSockets` の 4 method。
 *   - 引数順は `(runtimeDir, ...)` 固定。TerminalSessionService の
 *     `(runtimeDir, sessionId)` と対称。
 *   - `LaunchValidationError` は domain service に入れない。UI wrapper
 *     `src/ui/launch.ts#launchSession` で validation → `dtachIsAvailable`
 *     → `svc.launchAgentSession(...)` の順に呼ぶ。
 *   - `resolveStableNasBin` も UI wrapper 残置。env 依存は domain boundary
 *     外。UI が resolve 済の `nasBin` を `AgentLaunchSpec.nasBin` に詰めて
 *     service に渡す。
 *   - `startShellSession` の docker inspect + `isNasManagedContainer` +
 *     `NAS_SESSION_ID_LABEL` 抽出 + `ContainerNotRunningError` /
 *     `NotNasManagedContainerError` throw は UI wrapper 側に残置。
 *     Phase 3 `ContainerLifecycleService` で整理予定。
 *   - `removeOrphanShellSockets` は docker 依存を切り離し、呼び出し側が
 *     `runningParentIds: ReadonlySet<string>` を渡す契約。wrapper
 *     (`ui/data.ts#cleanContainers`) の docker primitive 直叩きは
 *     Phase 3 Commit 2 の `ContainerQueryService.collectRunningParentIds`
 *     で解消済。
 *   - `nextShellSessionId` は `startShellSession` 内部 private helper 化
 *     (外部露出なし)。
 *   - `NAS_INSIDE_DTACH=1 NAS_SESSION_ID=<escapedSessionId>` の env prefix
 *     組み立て (prefix 順序、shellEscape 適用) を `launchAgentSession` 内で
 *     保存する。
 *   - `dtachNewSession` 失敗時の `safeRemove(socketPath)` cleanup も
 *     service 内で保存する。元のエラーを握りつぶさず re-throw する。
 */

import { Context, Effect, Layer } from "effect";
import {
  dtachListSessions,
  dtachNewSession,
  shellEscape,
  socketPathFor,
} from "../../dtach/client.ts";
import { safeRemove } from "../../lib/fs_utils.ts";
import {
  buildShellSessionId,
  parseShellSessionId,
} from "../../ui/shell_session_id.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentLaunchSpec {
  readonly sessionId: string;
  readonly nasBin: string;
  readonly extraArgs: string[];
  readonly cwd?: string;
}

export interface ShellLaunchContainer {
  readonly containerName: string;
  readonly parentSessionId: string;
}

// ---------------------------------------------------------------------------
// SessionLaunchService tag
// ---------------------------------------------------------------------------

export class SessionLaunchService extends Context.Tag(
  "nas/SessionLaunchService",
)<
  SessionLaunchService,
  {
    readonly launchAgentSession: (
      runtimeDir: string,
      spec: AgentLaunchSpec,
    ) => Effect.Effect<{ sessionId: string }, Error>;
    readonly startShellSession: (
      runtimeDir: string,
      target: ShellLaunchContainer,
    ) => Effect.Effect<{ dtachSessionId: string }, Error>;
    readonly removeShellSocketsForParent: (
      runtimeDir: string,
      parentSessionId: string,
    ) => Effect.Effect<number, Error>;
    readonly removeOrphanShellSockets: (
      runtimeDir: string,
      runningParentIds: ReadonlySet<string>,
    ) => Effect.Effect<number, Error>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * 既存の shell セッションを走査して `shell-<parentSessionId>.<seq>` の
 * 次に使える seq を返す。seq は 1 始まり。外部露出なし。
 */
async function nextShellSessionIdImpl(
  runtimeDir: string,
  parentSessionId: string,
): Promise<string> {
  const existing = await dtachListSessions(runtimeDir);
  let maxSeq = 0;
  for (const s of existing) {
    const parsed = parseShellSessionId(s.name);
    if (!parsed) continue;
    if (parsed.parentSessionId !== parentSessionId) continue;
    if (parsed.seq > maxSeq) maxSeq = parsed.seq;
  }
  return buildShellSessionId(parentSessionId, maxSeq + 1);
}

async function launchAgentSessionImpl(
  runtimeDir: string,
  spec: AgentLaunchSpec,
): Promise<{ sessionId: string }> {
  const socketPath = socketPathFor(spec.sessionId, runtimeDir);

  const cmdArgs: string[] = [spec.nasBin, ...spec.extraArgs];
  const escaped = shellEscape(cmdArgs);
  const escapedSessionId = shellEscape([spec.sessionId]);
  // NAS_INSIDE_DTACH / NAS_SESSION_ID env prefix の順序と shellEscape 適用は
  // 既存 UI の launchSession 挙動をそのまま保存 (commit message 明示対象)。
  const shellCommand = `NAS_INSIDE_DTACH=1 NAS_SESSION_ID=${escapedSessionId} ${escaped}`;

  try {
    await dtachNewSession(socketPath, shellCommand, { cwd: spec.cwd });
  } catch (error) {
    // cleanup は必ず走らせつつ、失敗時の元エラーをマスクしない。
    try {
      await safeRemove(socketPath);
    } catch {
      // 元のエラーを優先するため cleanup 失敗は握りつぶす。
    }
    throw error;
  }

  return { sessionId: spec.sessionId };
}

async function startShellSessionImpl(
  runtimeDir: string,
  target: ShellLaunchContainer,
): Promise<{ dtachSessionId: string }> {
  // shell- prefix + parentSessionId + seq で衝突しない番号を選ぶ。
  const dtachSessionId = await nextShellSessionIdImpl(
    runtimeDir,
    target.parentSessionId,
  );
  const socketPath = socketPathFor(dtachSessionId, runtimeDir);

  // docker exec -it -u 0:0 <container> /entrypoint.sh --shell
  // docker exec はデフォルトで ENTRYPOINT を通らないため明示的に呼ぶ。
  // entrypoint.sh --shell が root → setpriv → agent UID/GID の bash に drop。
  const execArgs = [
    "docker",
    "exec",
    "-it",
    "-u",
    "0:0",
    target.containerName,
    "/entrypoint.sh",
    "--shell",
  ];
  const shellCommand = shellEscape(execArgs);

  try {
    await dtachNewSession(socketPath, shellCommand);
  } catch (error) {
    try {
      await safeRemove(socketPath);
    } catch {
      // 元のエラーを優先するため cleanup 失敗は握りつぶす。
    }
    throw error;
  }

  return { dtachSessionId };
}

async function removeShellSocketsForParentImpl(
  runtimeDir: string,
  parentSessionId: string,
): Promise<number> {
  const sessions = await dtachListSessions(runtimeDir);
  let removed = 0;
  for (const session of sessions) {
    const parsed = parseShellSessionId(session.name);
    if (!parsed || parsed.parentSessionId !== parentSessionId) continue;
    await safeRemove(session.socketPath);
    removed += 1;
  }
  return removed;
}

async function removeOrphanShellSocketsImpl(
  runtimeDir: string,
  runningParentIds: ReadonlySet<string>,
): Promise<number> {
  const sessions = await dtachListSessions(runtimeDir);
  let removed = 0;
  for (const session of sessions) {
    const parsed = parseShellSessionId(session.name);
    if (!parsed) continue;
    if (runningParentIds.has(parsed.parentSessionId)) continue;
    await safeRemove(session.socketPath);
    removed += 1;
  }
  return removed;
}

export const SessionLaunchServiceLive: Layer.Layer<SessionLaunchService> =
  Layer.succeed(
    SessionLaunchService,
    SessionLaunchService.of({
      launchAgentSession: (runtimeDir, spec) =>
        Effect.tryPromise({
          try: () => launchAgentSessionImpl(runtimeDir, spec),
          catch: toError,
        }),

      startShellSession: (runtimeDir, target) =>
        Effect.tryPromise({
          try: () => startShellSessionImpl(runtimeDir, target),
          catch: toError,
        }),

      removeShellSocketsForParent: (runtimeDir, parentSessionId) =>
        Effect.tryPromise({
          try: () =>
            removeShellSocketsForParentImpl(runtimeDir, parentSessionId),
          catch: toError,
        }),

      removeOrphanShellSockets: (runtimeDir, runningParentIds) =>
        Effect.tryPromise({
          try: () => removeOrphanShellSocketsImpl(runtimeDir, runningParentIds),
          catch: toError,
        }),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface SessionLaunchServiceFakeConfig {
  readonly launchAgentSession?: (
    runtimeDir: string,
    spec: AgentLaunchSpec,
  ) => Effect.Effect<{ sessionId: string }, Error>;
  readonly startShellSession?: (
    runtimeDir: string,
    target: ShellLaunchContainer,
  ) => Effect.Effect<{ dtachSessionId: string }, Error>;
  readonly removeShellSocketsForParent?: (
    runtimeDir: string,
    parentSessionId: string,
  ) => Effect.Effect<number, Error>;
  readonly removeOrphanShellSockets?: (
    runtimeDir: string,
    runningParentIds: ReadonlySet<string>,
  ) => Effect.Effect<number, Error>;
}

export function makeSessionLaunchServiceFake(
  overrides: SessionLaunchServiceFakeConfig = {},
): Layer.Layer<SessionLaunchService> {
  return Layer.succeed(
    SessionLaunchService,
    SessionLaunchService.of({
      launchAgentSession:
        overrides.launchAgentSession ??
        ((_runtimeDir, spec) => Effect.succeed({ sessionId: spec.sessionId })),
      startShellSession:
        overrides.startShellSession ??
        ((_runtimeDir, target) =>
          Effect.succeed({
            dtachSessionId: buildShellSessionId(target.parentSessionId, 1),
          })),
      removeShellSocketsForParent:
        overrides.removeShellSocketsForParent ?? (() => Effect.succeed(0)),
      removeOrphanShellSockets:
        overrides.removeOrphanShellSockets ?? (() => Effect.succeed(0)),
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
 * UI route / data.ts はこれを経由して service を使う。Fake を差し込みたい
 * テストは Effect API を直接呼び、この関数は使わない。
 */
export function makeSessionLaunchClient(
  layer: Layer.Layer<SessionLaunchService> = SessionLaunchServiceLive,
) {
  function run<A>(
    f: (
      s: Context.Tag.Service<SessionLaunchService>,
    ) => Effect.Effect<A, Error>,
  ): Promise<A> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionLaunchService;
        return yield* f(svc);
      }).pipe(Effect.provide(layer)),
    );
  }

  return {
    launchAgentSession: (
      runtimeDir: string,
      spec: AgentLaunchSpec,
    ): Promise<{ sessionId: string }> =>
      run((svc) => svc.launchAgentSession(runtimeDir, spec)),
    startShellSession: (
      runtimeDir: string,
      target: ShellLaunchContainer,
    ): Promise<{ dtachSessionId: string }> =>
      run((svc) => svc.startShellSession(runtimeDir, target)),
    removeShellSocketsForParent: (
      runtimeDir: string,
      parentSessionId: string,
    ): Promise<number> =>
      run((svc) =>
        svc.removeShellSocketsForParent(runtimeDir, parentSessionId),
      ),
    removeOrphanShellSockets: (
      runtimeDir: string,
      runningParentIds: ReadonlySet<string>,
    ): Promise<number> =>
      run((svc) => svc.removeOrphanShellSockets(runtimeDir, runningParentIds)),
  };
}
