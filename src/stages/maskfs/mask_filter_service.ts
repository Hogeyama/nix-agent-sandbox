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
 * デーモンを kill してフレーム・socket・ログと、それらを置いた 2 つの
 * ディレクトリを削除する (S2)。作成したものはすべて作成と同じ
 * acquireRelease で削除を登録するため、その後のデーモン起動 (spawn) が
 * 失敗しても何も残らない — 起動失敗と後片付けは独立している。
 *
 * D1/D2 分離: IO プリミティブ呼び出しは 1 関数 1 呼び出しの D1 ラッパに閉じ、
 * 合成 Effect (D2) はそれらを組み合わせるだけにする。
 */

import * as path from "node:path";
import { Context, Effect, Layer, type Scope } from "effect";
import type { SecretConfig } from "../../config/types.ts";
import { resolveSecretList } from "../../network/secrets.ts";
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
      secrets: Readonly<Record<string, SecretConfig>>,
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

/** How much of the serve log's tail is quoted back to the operator. */
const SERVE_LOG_TAIL_CHARS = 2000;

/**
 * What the serve log had to say about a startup failure.
 *
 * "empty" and "unreadable" are separate outcomes on purpose: an empty log
 * means the daemon was killed or died before writing (SIGKILL, OOM), while an
 * unreadable one means the read itself failed on a log that the session did
 * create — its permissions changed, it was deleted under us, or the filesystem
 * errored. They point at different things to check, so collapsing both into
 * "no output" would hide half the diagnosis.
 */
type ServeLogTail =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Unreadable"; readonly reason: string };

function describeDefect(defect: unknown): string {
  return defect instanceof Error ? defect.message : String(defect);
}

/**
 * Builds the error an operator sees when the broker never bound its socket.
 *
 * The timeout's own message is kept verbatim — it is the only place the polled
 * path and the deadline are named — and the serve log's tail is appended below
 * it, because that is where nas-mask-filter reports *why* it gave up (missing
 * or unreadable secrets file, corrupt frame, bind failure).
 *
 * Quoting the log is safe only because serve mode never writes stream-derived
 * bytes to stdout/stderr; everything it emits there is a constant diagnostic
 * string. That invariant exists for exactly this reason: relaxing it turns this
 * splice into a plaintext leak.
 */
function formatServeStartupError(
  plan: MaskFilterPreparePlan,
  defect: unknown,
  tail: ServeLogTail,
): Error {
  const lines = [
    `[nas] mask: the mask broker did not create its socket at ${plan.socketPath} within ${plan.timeoutMs}ms`,
    describeDefect(defect),
  ];
  switch (tail._tag) {
    case "Text":
      lines.push(
        `--- nas-mask-filter --serve output (${plan.logFile}, removed with the session) ---`,
        tail.text,
      );
      break;
    case "Empty":
      lines.push(
        `the serve log at ${plan.logFile} is empty; the daemon may have died before writing`,
      );
      break;
    case "Unreadable":
      lines.push(
        `the serve log at ${plan.logFile} could not be read: ${tail.reason}`,
      );
      break;
  }
  return new Error(lines.join("\n"));
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

function waitForSocketFile(
  proc: Proc,
  plan: MaskFilterPreparePlan,
): Effect.Effect<void> {
  return proc.waitForFileExists(
    plan.socketPath,
    plan.timeoutMs,
    plan.pollIntervalMs,
  );
}

function readLogFile(fs: Fs, logFile: string): Effect.Effect<string> {
  return fs.readFile(logFile);
}

function removeFile(fs: Fs, target: string): Effect.Effect<void> {
  return fs.rm(target, { force: true });
}

/** 空になったディレクトリを取り除く。中身を消した後に呼ぶこと。 */
function removeDir(fs: Fs, dir: string): Effect.Effect<void> {
  return fs.rmdir(dir);
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
 * 自分で作ったディレクトリを畳む。
 *
 * rm ではなく rmdir を使うので、想定外の中身が残っていれば ENOTEMPTY で
 * 失敗する — それを消してしまうより、残して警告する方が安全。ただし
 * finalizer は失敗してはならないので、ここで total 化して release の
 * 残りのステップを止めないようにする。
 */
function removeOwnDir(
  fs: Fs,
  dir: string,
  warning: string,
): Effect.Effect<void> {
  return removeDir(fs, dir).pipe(
    Effect.catchAllCause(() => Effect.logWarning(warning)),
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
 *
 * ディレクトリの作成も同じ理由で acquireRelease にしてある。ここで作る
 * 2 つは `${runtimeDir}/${sessionId}` と `${runtimeDir}/${sessionId}-sock` で、
 * どちらもセッション固有なので、消さないと $XDG_RUNTIME_DIR に空ディレクトリが
 * セッションごとに積み上がる (刈り取る仕組みは無い)。
 *
 * 登録順は「セッションディレクトリ → socket ディレクトリ → フレーム →
 * (startServe の) デーモン」。finalizer は逆順なので、実際の解体は
 * デーモン停止 → socket・ログ削除 → フレーム削除 → socket ディレクトリ →
 * セッションディレクトリ となり、中身は必ずディレクトリより先に消える。
 */
function writeHostSideFrame(
  fs: Fs,
  plan: MaskFilterPreparePlan,
  secrets: string[],
): Effect.Effect<void, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const sessionDir = path.dirname(plan.secretsFramePath);
    yield* Effect.acquireRelease(makePrivateDir(fs, sessionDir), () =>
      removeOwnDir(fs, sessionDir, "mask-filter: session dir cleanup failed"),
    );
    yield* Effect.acquireRelease(makePrivateDir(fs, plan.socketDir), () =>
      removeOwnDir(
        fs,
        plan.socketDir,
        "mask-filter: socket dir cleanup failed",
      ),
    );
    yield* Effect.acquireRelease(
      writeSecretsFrame(fs, plan.secretsFramePath, encodeMaskSecrets(secrets)),
      () => removeFrame(fs, plan),
    );
  });
}

/**
 * 起動失敗時に運用者へ見せるログ末尾を読み取り、3 つの結果のどれかに畳む。
 *
 * fs.readFile は失敗を defect にする (orDie) ので、ここは catchAllDefect で
 * data 化する。catchAllCause だと interrupt まで「読めなかった」に化けるので
 * 使わない。読めなかったことと空だったことは別の結果として残す — 潰すと
 * 運用者が次に見るべき場所を選べなくなる。
 */
function serveLogTail(fs: Fs, logFile: string): Effect.Effect<ServeLogTail> {
  return readLogFile(fs, logFile).pipe(
    Effect.map((content): ServeLogTail => {
      const text = content.slice(-SERVE_LOG_TAIL_CHARS).trim();
      return text.length === 0 ? { _tag: "Empty" } : { _tag: "Text", text };
    }),
    Effect.catchAllDefect((defect) =>
      Effect.succeed<ServeLogTail>({
        _tag: "Unreadable",
        reason: describeDefect(defect),
      }),
    ),
  );
}

/**
 * socket が現れるのを待ち、現れなければ serve デーモンのログ末尾を添えて
 * 失敗する。
 *
 * waitForFileExists はタイムアウトを typed error ではなく defect として報告
 * するので、診断は catchAllDefect で付ける — catchAllCause は interrupt まで
 * 拾ってしまい、単に中断されただけの実行を「起動に失敗した」と偽ることに
 * なる。ログを読むのは失敗したときだけで、socket が現れた場合は fs に
 * 一切触らない。
 */
function awaitSocket(
  fs: Fs,
  proc: Proc,
  plan: MaskFilterPreparePlan,
): Effect.Effect<void, Error> {
  return waitForSocketFile(proc, plan).pipe(
    Effect.catchAllDefect((defect) =>
      serveLogTail(fs, plan.logFile).pipe(
        Effect.flatMap((tail) =>
          Effect.fail(formatServeStartupError(plan, defect, tail)),
        ),
      ),
    ),
  );
}

/**
 * S2: デーモンを止めてから、socket・ログを消す。フレームとディレクトリの
 * 削除は writeHostSideFrame 側の acquireRelease が扱うのでここでは触らない
 * (二重削除を避けるため)。scope の finalizer は登録の逆順で実行される
 * ので、それらの acquire がデーモン起動より先に行われている限り、
 * このデーモン停止処理は必ずフレーム削除・ディレクトリ削除より先に走る —
 * デーモンがその socket やディレクトリより長生きすることはない。
 *
 * 起動に失敗した場合でもログは消す。証拠は awaitSocket が scope の解体より
 * 前にエラーへ写し取っているので失われないし、残せば removeOwnDir の rmdir が
 * ENOTEMPTY になり、$XDG_RUNTIME_DIR にセッションディレクトリが積み上がる。
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
    yield* awaitSocket(fs, proc, plan);
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

      resolveSecrets: (secrets, host) =>
        Effect.tryPromise({
          try: () => {
            const env: Record<string, string | undefined> = {};
            for (const [k, v] of host.env) env[k] = v;
            return resolveSecretList(secrets, env);
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
    secrets: Readonly<Record<string, SecretConfig>>,
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
