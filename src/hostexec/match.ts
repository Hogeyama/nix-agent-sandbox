import type { HostExecRule } from "../config/types.ts";

export interface MatchResult {
  rule: HostExecRule;
}

/**
 * ルール配列から最初にマッチするルールを返す。
 * マッチしなければ null。
 */
export function matchRule(
  rules: HostExecRule[],
  argv0: string,
  args: string[],
): MatchResult | null {
  const argsString = args.join(" ");

  for (const rule of rules) {
    if (rule.match.argv0 !== argv0) continue;

    // arg-regex チェック
    if (rule.match.argRegex !== undefined) {
      const re = new RegExp(rule.match.argRegex);
      if (!re.test(argsString)) continue;
    }

    return { rule };
  }

  return null;
}

/**
 * args を join した文字列を返す（テスト用 CLI 表示向け）。
 */
export function buildArgsString(args: string[]): string {
  return args.join(" ");
}
