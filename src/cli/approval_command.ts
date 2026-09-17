/**
 * network / hostexec 共通の approve/deny/pending/review フロー
 */

import type { ReviewItem } from "../fzf_review.ts";
import { runFzfReview } from "../fzf_review.ts";
import {
  isOwnerPipe,
  runApprovalWatch,
  sleepAbortable,
  stopOnOwnerExit,
  structuredOf,
} from "./approval_watch.ts";
import {
  getFlagValue,
  hasFormatJson,
  positionalArgsAfterSubcommand,
} from "./helpers.ts";

/** pending 一覧の各アイテム */
export interface PendingItem {
  sessionId: string;
  requestId: string;
  displayLine: string;
  /** JSON 出力用の構造化データ */
  structured?: Record<string, unknown>;
}

/** approve/deny メッセージ */
export type DecisionMessage =
  | { type: "approve"; requestId: string; scope?: string }
  | { type: "deny"; requestId: string };

/** サブコマンドごとの差異を吸収するアダプタ */
export interface ApprovalAdapter {
  /** ドメイン名（ログ表示用: "network" | "hostexec"） */
  domain: string;
  /** pending アイテム一覧を取得 */
  listPending(): Promise<PendingItem[]>;
  /** 承認/拒否を送信 */
  sendDecision(
    sessionId: string,
    requestId: string,
    message: DecisionMessage,
  ): Promise<void>;
  /** fzf review で表示するスコープ選択肢 */
  scopeOptions: string[];
  /** そのセッションがまだ生きているか。watch のセッション指定でのみ使う。 */
  sessionAlive(sessionId: string): Promise<boolean>;
}

/**
 * `--session` の値を取り出す。欠けていれば失敗させる。
 *
 * 値を黙って無視すると、絞ったつもりの全セッションが対象になる。値の無い
 * `--session` も、`--session --format json` のように次のフラグを拾った場合も
 * 同じ結果になる。pending / review では利用者が気づかないまま無関係な
 * セッションの承認を操作しうる。watch では一致するセッションが無いまま
 * 無音で待ち続けることになり、「承認待ちに気づけない」状態そのものになる。
 */
export function sessionFilterArg(nasArgs: string[]): string | undefined {
  const index = nasArgs.indexOf("--session");
  if (index === -1) return undefined;
  const value = nasArgs[index + 1];
  if (value === undefined || value === "" || value.startsWith("-"))
    throw new Error("--session requires a session id");
  return value;
}

/** セッション id の完全一致で絞る。フィルタ未指定なら素通しする。 */
function filterBySession(
  items: PendingItem[],
  sessionFilter: string | undefined,
): PendingItem[] {
  if (sessionFilter === undefined) return items;
  return items.filter((item) => item.sessionId === sessionFilter);
}

/**
 * 該当なしのときの文言を組み立てる。
 *
 * フィルタ指定時は id をそのまま出す。綴りを誤った id をただの 0 件として
 * 表示すると、承認待ちが無いのか id が違うのかを利用者が区別できない。
 */
function emptyPendingMessage(
  domain: string,
  sessionFilter: string | undefined,
): string {
  return sessionFilter === undefined
    ? `[nas] No pending ${domain} approvals.`
    : `[nas] No pending ${domain} approvals for session ${sessionFilter}.`;
}

/** 呼び出し側が中断と出力先を持ち込むための引数。watch だけが参照する。 */
export interface ApprovalSubcommandDeps {
  readonly signal?: AbortSignal;
  readonly write?: (line: string) => void;
}

/**
 * approve/deny/pending/review/watch の共通フローを実行する。
 * 処理したサブコマンドに該当すれば true を返す。
 */
export async function handleApprovalSubcommand(
  adapter: ApprovalAdapter,
  sub: string | undefined,
  nasArgs: string[],
  deps: ApprovalSubcommandDeps = {},
): Promise<boolean> {
  if (sub === "pending" || sub === undefined) {
    const sessionFilter = sessionFilterArg(nasArgs);
    const items = filterBySession(await adapter.listPending(), sessionFilter);
    if (hasFormatJson(nasArgs)) {
      console.log(JSON.stringify(items.map(structuredOf)));
      return true;
    }
    if (items.length === 0) {
      console.log(emptyPendingMessage(adapter.domain, sessionFilter));
      return true;
    }
    for (const item of items) {
      console.log(item.displayLine);
    }
    return true;
  }

  if (sub === "watch") {
    const sessionFilter = sessionFilterArg(nasArgs);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // 読み口が閉じたら止まる。EPIPE を警告として流し続けない。
    process.stdout.once("error", stop);
    const releaseOwner =
      deps.signal === undefined && isOwnerPipe(0)
        ? stopOnOwnerExit(process.stdin, stop)
        : undefined;
    if (deps.signal) {
      if (deps.signal.aborted) stop();
      else deps.signal.addEventListener("abort", stop, { once: true });
    }

    const write =
      deps.write ??
      ((line: string) => {
        try {
          process.stdout.write(line);
        } catch {
          stop();
        }
      });

    try {
      await runApprovalWatch(adapter.domain, sessionFilter, {
        listPending: () => adapter.listPending(),
        write,
        warn: (message) => {
          console.error(message);
        },
        sleep: (ms) => sleepAbortable(ms, controller.signal),
        signal: controller.signal,
        sessionAlive: (id) => adapter.sessionAlive(id),
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdout.off("error", stop);
      releaseOwner?.();
      deps.signal?.removeEventListener("abort", stop);
    }
    return true;
  }

  if (sub === "approve") {
    const [sessionId, requestId] = positionalArgsAfterSubcommand(nasArgs, sub);
    const scope = getFlagValue(nasArgs, "--scope") ?? undefined;
    await adapter.sendDecision(sessionId, requestId, {
      type: "approve",
      requestId,
      scope,
    });
    console.log(`[nas] Approved ${sessionId} ${requestId}`);
    return true;
  }

  if (sub === "deny") {
    const [sessionId, requestId] = positionalArgsAfterSubcommand(nasArgs, sub);
    await adapter.sendDecision(sessionId, requestId, {
      type: "deny",
      requestId,
    });
    console.log(`[nas] Denied ${sessionId} ${requestId}`);
    return true;
  }

  if (sub === "review") {
    const sessionFilter = sessionFilterArg(nasArgs);
    const items = filterBySession(await adapter.listPending(), sessionFilter);
    if (items.length === 0) {
      console.log(emptyPendingMessage(adapter.domain, sessionFilter));
      return true;
    }
    const reviewItems: ReviewItem[] = items.map((item) => ({
      sessionId: item.sessionId,
      requestId: item.requestId,
      displayLine: item.displayLine,
    }));
    const result = await runFzfReview(reviewItems, adapter.scopeOptions);
    if (!result) return true;
    for (const selected of result.items) {
      const message: DecisionMessage =
        result.action === "approve"
          ? {
              type: "approve",
              requestId: selected.requestId,
              scope: result.scope,
            }
          : { type: "deny", requestId: selected.requestId };
      try {
        await adapter.sendDecision(
          selected.sessionId,
          selected.requestId,
          message,
        );
        console.log(
          `[nas] ${
            result.action === "approve" ? "Approved" : "Denied"
          } ${selected.sessionId} ${selected.requestId}`,
        );
      } catch (err) {
        console.error(
          `[nas] Warning: failed to ${result.action} ${selected.sessionId} ${selected.requestId}: ${
            (err as Error).message
          }`,
        );
      }
    }
    return true;
  }

  return false;
}
