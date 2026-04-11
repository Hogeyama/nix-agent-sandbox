/**
 * network / hostexec 共通の approve/deny/pending/review フロー
 */

import type { ReviewItem } from "../fzf_review.ts";
import { runFzfReview } from "../fzf_review.ts";
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
 * approve/deny/pending/review の共通フローを実行する。
 * 処理したサブコマンドに該当すれば true を返す。
 */
export async function handleApprovalSubcommand(
  adapter: ApprovalAdapter,
  sub: string | undefined,
  nasArgs: string[],
): Promise<boolean> {
  if (sub === "pending" || sub === undefined) {
    const items = await adapter.listPending();
    if (hasFormatJson(nasArgs)) {
      const jsonItems = items.map(
        (item) =>
          item.structured ?? {
            sessionId: item.sessionId,
            requestId: item.requestId,
          },
      );
      console.log(JSON.stringify(jsonItems));
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
