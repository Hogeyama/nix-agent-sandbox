/**
 * テストが解決済みドキュメントを組み立てるための補助。
 *
 * ドキュメントを手で書くとテストが解決器の出力ではなく作者の記憶を検証する
 * ことになるので、テストも設定を書いて `resolveAuthzConfig` に通す。
 */

import type { AuthzConfig, ScopeConfig } from "./config.ts";
import { type ResolvedDocument, resolveAuthzConfig } from "./resolve.ts";

/** 設定を解決する。設定エラーがあれば投げる。 */
export function resolvedDocument(config: AuthzConfig): ResolvedDocument {
  const outcome = resolveAuthzConfig(config);
  if (outcome.document === null) {
    throw new Error(
      outcome.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  return outcome.document;
}

/** スコープだけを与えてドキュメントを作る。 */
export function documentWithScopes(
  scopes: Readonly<Record<string, ScopeConfig>>,
  fallback: "review" | "deny" = "deny",
): ResolvedDocument {
  return resolvedDocument({ network: { scopes, fallback } });
}
