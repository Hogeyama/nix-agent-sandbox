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
