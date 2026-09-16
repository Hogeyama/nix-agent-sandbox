/**
 * network / hostexec 共通の approve/deny/pending/review フロー
 */

import type { ReviewItem } from "../fzf_review.ts";
import { runFzfReview } from "../fzf_review.ts";
import {
  runApprovalWatch,
  sleepAbortable,
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
}

/**
 * `--session` の値を取り出す。欠けていれば失敗させる。
 *
 * 値を黙って無視すると症状が watch の存在意義と正面から衝突する。値の無い
 * `--session` は全セッション購読へ広がり、`--session --format json` のように
 * 次のフラグを拾えば一致するセッションが無いまま無音で待ち続ける。どちらも
 * 「承認待ちに気づけない」状態そのものである。
 */
export function watchSessionFilter(nasArgs: string[]): string | undefined {
  const index = nasArgs.indexOf("--session");
  if (index === -1) return undefined;
  const value = nasArgs[index + 1];
  if (value === undefined || value.startsWith("-"))
    throw new Error("--session requires a session id");
  return value;
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
    const items = await adapter.listPending();
    if (hasFormatJson(nasArgs)) {
      console.log(JSON.stringify(items.map(structuredOf)));
      return true;
    }
    if (items.length === 0) {
      console.log(`[nas] No pending ${adapter.domain} approvals.`);
      return true;
    }
    for (const item of items) {
      console.log(item.displayLine);
    }
    return true;
  }

  if (sub === "watch") {
    const sessionFilter = watchSessionFilter(nasArgs);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    // 読み口が閉じたら止まる。EPIPE を警告として流し続けない。
    process.stdout.once("error", stop);
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
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdout.off("error", stop);
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
    const items = await adapter.listPending();
    if (items.length === 0) {
      console.log(`[nas] No pending ${adapter.domain} approvals.`);
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
