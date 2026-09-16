/**
 * 承認保留の購読 — pending スナップショットの差分計算。
 *
 * 差分計算は純粋関数に保つ。ループ側は listPending / sleep / 書き出し先を
 * 引数で受け取るため、実時間とファイルシステムなしで両方を検証できる。
 */

import type { PendingItem } from "./approval_command.ts";

/** 購読が流す 1 行。 */
export type WatchEvent =
  | {
      readonly event: "added";
      readonly domain: string;
      readonly entry: Record<string, unknown>;
    }
  | {
      readonly event: "removed";
      readonly domain: string;
      readonly sessionId: string;
      readonly requestId: string;
    };

/** 前回スナップショットに残す最小限。removed の組み立てに使う。 */
export interface PendingSnapshotEntry {
  readonly sessionId: string;
  readonly requestId: string;
}

/** requestId はセッションをまたぐと衝突しうるので、両方で識別する。 */
export function pendingKey(sessionId: string, requestId: string): string {
  return `${sessionId}/${requestId}`;
}

/**
 * `pending --format json` と同じ構造を返す。両コマンドで形が違うと、
 * 購読するクライアントがパーサを 2 つ持つことになる。
 */
export function structuredOf(item: PendingItem): Record<string, unknown> {
  return (
    item.structured ?? {
      sessionId: item.sessionId,
      requestId: item.requestId,
    }
  );
}

export function diffPending(
  domain: string,
  prev: ReadonlyMap<string, PendingSnapshotEntry>,
  next: readonly PendingItem[],
): {
  events: WatchEvent[];
  nextState: Map<string, PendingSnapshotEntry>;
} {
  const nextState = new Map<string, PendingSnapshotEntry>();
  for (const item of next) {
    nextState.set(pendingKey(item.sessionId, item.requestId), {
      sessionId: item.sessionId,
      requestId: item.requestId,
    });
  }

  const events: WatchEvent[] = [];

  // 消滅を先に流す。クライアントは古いプロンプトを畳んでから新着を受け取る。
  for (const [key, entry] of prev) {
    if (nextState.has(key)) continue;
    events.push({
      event: "removed",
      domain,
      sessionId: entry.sessionId,
      requestId: entry.requestId,
    });
  }

  // listPendingEntries が createdAt 昇順で返すため、added もその順で流れる。
  for (const item of next) {
    if (prev.has(pendingKey(item.sessionId, item.requestId))) continue;
    events.push({ event: "added", domain, entry: structuredOf(item) });
  }

  return { events, nextState };
}

/** 人間が承認を待つ用途には十分速く、空ディレクトリの readdir は無視できる。 */
export const WATCH_INTERVAL_MS = 1000;

export interface WatchDeps {
  readonly listPending: () => Promise<PendingItem[]>;
  readonly write: (line: string) => void;
  readonly warn: (message: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: AbortSignal;
}

/** 中断されたら待たずに返る。終了要求から実際の停止までを間隔分待たせない。 */
export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * 停止要求まで pending を監視し続ける。
 *
 * 1 回のポーリング失敗では購読を切らない。ここで抜けると、一時的な
 * ファイルシステムエラーのせいでエージェントが承認タイムアウトまで停止する。
 */
export async function runApprovalWatch(
  domain: string,
  sessionFilter: string | undefined,
  deps: WatchDeps,
): Promise<void> {
  let state = new Map<string, PendingSnapshotEntry>();

  while (!deps.signal.aborted) {
    // 書き出しは try の外に置く。出力先の失敗をポーリング失敗として報告すると
    // 診断が嘘になり、しかも state は進んだままなので取りこぼしたイベントは
    // 二度と流れない。出力先が壊れているなら購読自体が成り立たない。
    let events: WatchEvent[] = [];
    try {
      const items = await deps.listPending();
      const scoped = sessionFilter
        ? items.filter((item) => item.sessionId === sessionFilter)
        : items;
      const diff = diffPending(domain, state, scoped);
      state = diff.nextState;
      events = diff.events;
    } catch (err) {
      deps.warn(`[nas] ${domain} watch: ${errorMessage(err)}`);
    }

    for (const event of events) {
      deps.write(`${JSON.stringify(event)}\n`);
    }

    if (deps.signal.aborted) break;
    await deps.sleep(WATCH_INTERVAL_MS);
  }
}

/** reject された値が Error とは限らない。"undefined" を診断に出さない。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
