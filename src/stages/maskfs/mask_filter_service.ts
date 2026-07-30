/**
 * MaskFilterService — nas-mask-filter の `--serve` デーモンをホスト側で起動し、
 * コンテナには socket だけを見せるための準備を行う。
 *
 * 解決済みシークレットのフレームはホスト専用ディレクトリに書き、コンテナへは
 * マウントしない (C1 / S1)。コンテナ内の `--supervise` はフレームを読まず、
 * この socket 越しにバイト列を中継してマスクを受け取る。
 *
 * socket はセッションディレクトリとは別のディレクトリに置く。マウントするのは
 * socket の「あるディレクトリ」なので、フレームと同居させるとフレームごと
 * コンテナへ渡すことになる。そのディレクトリは読み取り専用でマウントし、
 * エージェントによる socket の差し替えを構造的に封じる (connect(2) は読み取り
 * 専用バインドマウント越しでも成功する)。
 *
 * MaskFsService と同じくデーモンのライフサイクルを持ち、Scope 終了時に
 * デーモンを kill してフレーム・socket・ログを削除する (S2)。フレームの
 * 削除は書き込みと同じ acquireRelease で登録するため、その後のデーモン
 * 起動 (spawn) が失敗してもフレームは残らない — 起動失敗と後片付けは
 * 独立している。
 *
 * D1/D2 分離: IO プリミティブ呼び出しは 1 関数 1 呼び出しの D1 ラッパに閉じ、
 * 合成 Effect (D2) はそれらを組み合わせるだけにする。
 */

import * as path from "node:path";
import { Context, Effect, Layer, type Scope } from "effect";
import type { MaskValueConfig } from "../../config/types.ts";
import { resolveMaskSecrets } from "../../lib/mask_secrets.ts";
import type { MountSpec } from "../../pipeline/state.ts";
import type { HostEnv } from "../../pipeline/types.ts";
import { FsService } from "../../services/fs.ts";
import { ProcessService, type SpawnHandle } from "../../services/process.ts";
import { encodeMaskSecrets } from "./secrets_frame.ts";

type Fs = Context.Tag.Service<typeof FsService>;
type Proc = Context.Tag.Service<typeof ProcessService>;

export const MASK_FILTER_CONTAINER_PATH =
  "/opt/nas/mask-filter/nas-mask-filter";

export interface MaskFilterPreparePlan {
  /** ホスト専用。このディレクトリは決してマウントしない。 */
  readonly secretsFramePath: string;
  readonly filterBinaryHostPath: string;
  /** マウントされる。socket 以外を置いてはならない。 */
  readonly socketDir: string;
  /** `${socketDir}/mask.sock` */
  readonly socketPath: string;
  /** socketDir の下に置いてはならない。 */
  readonly logFile: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface MaskFilterResult {
  readonly mounts: readonly MountSpec[];
  readonly envVars: Readonly<Record<string, string>>;
}

export class MaskFilterService extends Context.Tag("nas/MaskFilterService")<
  MaskFilterService,
  {
    readonly prepareMaskFilter: (
      plan: MaskFilterPreparePlan,
      secrets: string[],
    ) => Effect.Effect<MaskFilterResult, unknown, Scope.Scope>;
    readonly resolveSecrets: (
      values: MaskValueConfig[],
      host: HostEnv,
    ) => Effect.Effect<string[], unknown>;
  }
>() {}

// ---------------------------------------------------------------------------
// Pure planners
// ---------------------------------------------------------------------------

/**
 * コンテナから見えるのは socket のディレクトリ (ro) とフィルタバイナリ (ro)
 * だけ。socket ディレクトリはホストと同じ絶対パスにマウントするので、
 * コンテナ側パスの定数は不要 (hostexec と同じ方式)。
 */
function planMounts(plan: MaskFilterPreparePlan): MountSpec[] {
  return [
    { source: plan.socketDir, target: plan.socketDir, readOnly: true },
    {
      source: plan.filterBinaryHostPath,
      target: MASK_FILTER_CONTAINER_PATH,
      readOnly: true,
    },
  ];
}

function planEnvVars(plan: MaskFilterPreparePlan): Record<string, string> {
  return {
    NAS_MASK_SOCKET: plan.socketPath,
    NAS_MASK_FILTER: MASK_FILTER_CONTAINER_PATH,
  };
}

// ---------------------------------------------------------------------------
// D1: primitive effect wrappers (one IO call each; not unit-tested directly)
// ---------------------------------------------------------------------------

function makePrivateDir(fs: Fs, dir: string): Effect.Effect<void> {
  return fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

function writeSecretsFrame(
  fs: Fs,
  framePath: string,
  frame: Uint8Array,
): Effect.Effect<void> {
  return fs.writeFile(framePath, frame, { mode: 0o600 });
}

function spawnServe(
  proc: Proc,
  plan: MaskFilterPreparePlan,
): Effect.Effect<SpawnHandle> {
  return proc.spawn(plan.filterBinaryHostPath, ["--serve", plan.socketPath], {
    logFile: plan.logFile,
    // ホスト側プロセスの env なのでコンテナ境界を越えない (C1/S1 の対象外)。
    env: { NAS_MASK_SECRETS_FILE: plan.secretsFramePath },
  });
}

/**
 * ProcessService.spawn は openSync(path, "a") でログを開くため 0644 になる。
 * serve はストリーム由来のバイト列を書かない契約だが、ログはセッション
 * ディレクトリ内の永続ファイルなので 0600 に落としておく。
 */
function restrictLogFile(fs: Fs, logFile: string): Effect.Effect<void> {
  return fs.chmod(logFile, 0o600);
}

function awaitSocket(
  proc: Proc,
  plan: MaskFilterPreparePlan,
): Effect.Effect<void> {
  return proc.waitForFileExists(
    plan.socketPath,
    plan.timeoutMs,
    plan.pollIntervalMs,
  );
}

function removeFile(fs: Fs, target: string): Effect.Effect<void> {
  return fs.rm(target, { force: true });
}

function killDaemon(handle: SpawnHandle): Effect.Effect<void> {
  return Effect.sync(() => handle.kill());
}

// ---------------------------------------------------------------------------
// D2: composed effects
// ---------------------------------------------------------------------------

/**
 * フレーム削除は「フレームを書いた直後」から scope 終了まで、いつ finalizer
 * として起動されても失敗してはならない。releaseServe と同じ理由で total 化
 * する。
 */
function removeFrame(fs: Fs, plan: MaskFilterPreparePlan): Effect.Effect<void> {
  return removeFile(fs, plan.secretsFramePath).pipe(
    Effect.catchAllCause(() =>
      Effect.logWarning("mask-filter: secrets frame cleanup failed"),
    ),
  );
}

/**
 * フレームは 0700 のディレクトリに 0600 で書く。hostexec が C3 のマスクで
 * これを直読みするため、マウントを止めてもファイル自体は残す。
 *
 * フレームの書き込みそのものを acquireRelease で包み、削除を「フレームが
 * 存在するようになった瞬間」に登録する。これにより、この後の startServe
 * (デーモン起動) が失敗しても — acquire 自体が同期的に throw するケースを
 * 含め — scope が閉じればフレームは必ず削除される。デーモンが起動できな
 * かったことと、フレームが残ることは無関係でなければならない。
 */
function writeHostSideFrame(
  fs: Fs,
  plan: MaskFilterPreparePlan,
  secrets: string[],
): Effect.Effect<void, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    yield* makePrivateDir(fs, path.dirname(plan.secretsFramePath));
    yield* makePrivateDir(fs, plan.socketDir);
    yield* Effect.acquireRelease(
      writeSecretsFrame(fs, plan.secretsFramePath, encodeMaskSecrets(secrets)),
      () => removeFrame(fs, plan),
    );
  });
}

/**
 * S2: デーモンを止めてから、socket・ログを消す。フレームの削除は
 * writeHostSideFrame 側の acquireRelease が扱うのでここでは触らない
 * (二重削除を避けるため)。scope の finalizer は登録の逆順で実行される
 * ので、フレームの acquire がデーモン起動より先に行われている限り、
 * このデーモン停止処理は必ずフレーム削除より先に走る — デーモンがその
 * フレームより長生きすることはない。
 */
function releaseServe(
  fs: Fs,
  plan: MaskFilterPreparePlan,
  handle: SpawnHandle,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* killDaemon(handle);
    yield* removeFile(fs, plan.socketPath);
    yield* removeFile(fs, plan.logFile);
  }).pipe(
    // finalizer は失敗してはならない。
    Effect.catchAllCause(() =>
      Effect.logWarning("mask-filter: serve daemon cleanup failed"),
    ),
  );
}

function startServe(
  fs: Fs,
  proc: Proc,
  plan: MaskFilterPreparePlan,
): Effect.Effect<void, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    yield* Effect.acquireRelease(spawnServe(proc, plan), (handle) =>
      releaseServe(fs, plan, handle),
    );
    yield* restrictLogFile(fs, plan.logFile);
    yield* awaitSocket(proc, plan);
  });
}

function prepareMaskFilter(
  fs: Fs,
  proc: Proc,
  plan: MaskFilterPreparePlan,
  secrets: string[],
): Effect.Effect<MaskFilterResult, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    yield* writeHostSideFrame(fs, plan, secrets);
    yield* startServe(fs, proc, plan);
    return { mounts: planMounts(plan), envVars: planEnvVars(plan) };
  });
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const MaskFilterServiceLive: Layer.Layer<
  MaskFilterService,
  never,
  FsService | ProcessService
> = Layer.effect(
  MaskFilterService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    const proc = yield* ProcessService;

    return MaskFilterService.of({
      prepareMaskFilter: (plan, secrets) =>
        prepareMaskFilter(fs, proc, plan, secrets),

      resolveSecrets: (values, host) =>
        Effect.tryPromise({
          try: () => {
            const env: Record<string, string | undefined> = {};
            for (const [k, v] of host.env) env[k] = v;
            return resolveMaskSecrets(values, env);
          },
          catch: (e) => e,
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface MaskFilterServiceFakeConfig {
  readonly prepareMaskFilter?: (
    plan: MaskFilterPreparePlan,
    secrets: string[],
  ) => Effect.Effect<MaskFilterResult, unknown, Scope.Scope>;
  readonly resolveSecrets?: (
    values: MaskValueConfig[],
    host: HostEnv,
  ) => Effect.Effect<string[], unknown>;
}

export function makeMaskFilterServiceFake(
  overrides: MaskFilterServiceFakeConfig = {},
): Layer.Layer<MaskFilterService> {
  return Layer.succeed(
    MaskFilterService,
    MaskFilterService.of({
      prepareMaskFilter:
        overrides.prepareMaskFilter ??
        (() => Effect.succeed({ mounts: [], envVars: {} })),
      resolveSecrets: overrides.resolveSecrets ?? (() => Effect.succeed([])),
    }),
  );
}
