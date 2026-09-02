/**
 * イベントループのブロック検出。
 *
 * nas UI デーモンは Bun の単一イベントループで動く。ターミナルの
 * WebSocket 中継 (`routes/terminal.ts`) は、SSE のポーリングも HTTP
 * ルートも同じループに載せている。どこか1箇所が同期的にループを塞ぐと、
 * その間キーストロークも PTY 出力も配送されず、塞ぎが解けた瞬間に
 * まとめて流れる。ユーザーからは「タイプが固まって、あとから一気に
 * 入る」ように見える。
 *
 * この症状は原因から遠い。過去には監査ログの無制限クエリが1周あたり
 * 400ms 近くループを占有していたが、症状だけを見て xterm のレンダラや
 * WebSocket 経路を疑うことになり、原因に辿り着くまで何度も外した。
 * 「遅い」ではなく **「塞いだ」** を直接測る指標が1つあれば、その回り道は
 * 要らなかった。
 *
 * 一定間隔のタイマーが予定より何 ms 遅れて起きたかが、そのままブロック
 * 時間になる。タイマー自身の仕事は引き算だけなので、観測が観測対象を
 * 歪めない。健全なら何も出力しない。
 */

/** サンプリング間隔。これ未満のブロックは検出できない。 */
const SAMPLE_INTERVAL_MS = 250;

/**
 * これを超えて遅れたら警告する。1フレーム程度の遅れは GC でも起きるので、
 * 「人間が入力の引っかかりとして感じる」水準に置いている。
 */
const BLOCKED_THRESHOLD_MS = 250;

export interface LoopWatchdogDeps {
  intervalMs?: number;
  thresholdMs?: number;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  warn?: (message: string) => void;
}

export interface LoopWatchdog {
  stop(): void;
}

export function startLoopWatchdog(deps: LoopWatchdogDeps = {}): LoopWatchdog {
  const intervalMs = deps.intervalMs ?? SAMPLE_INTERVAL_MS;
  const thresholdMs = deps.thresholdMs ?? BLOCKED_THRESHOLD_MS;
  const now = deps.now ?? (() => performance.now());
  const setIntervalFn =
    deps.setIntervalFn ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearIntervalFn =
    deps.clearIntervalFn ??
    ((h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>));
  const warn = deps.warn ?? ((m: string) => console.warn(m));

  let expected = now() + intervalMs;
  const handle = setIntervalFn(() => {
    const actual = now();
    const lagMs = actual - expected;
    // 次の期待時刻は「実際に起きた時刻」から測る。予定時刻から測ると、
    // 一度の大きなブロックが以降のサンプルすべてを遅刻扱いにしてしまう。
    expected = actual + intervalMs;
    if (lagMs >= thresholdMs) {
      warn(`[ui] event loop blocked for ${lagMs.toFixed(0)}ms`);
    }
  }, intervalMs);

  // 監視タイマーがデーモンの終了を引き止めてはならない。
  const timer = handle as { unref?: () => void };
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      clearIntervalFn(handle);
    },
  };
}
