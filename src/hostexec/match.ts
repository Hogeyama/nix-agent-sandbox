import type {
  HostExecRule,
  HostExecSubcommandConfig,
} from "../config/types.ts";
import { normalizeSubcommand } from "./subcommand.ts";

export interface MatchResult {
  rule: HostExecRule;
  subcommand: string | null;
}

/**
 * ルール配列から最初にマッチするルールを返す。
 * マッチしなければ null。
 */
export function matchRule(
  rules: HostExecRule[],
  argv0: string,
  args: string[],
  subcommandConfig: HostExecSubcommandConfig,
): MatchResult | null {
  const subcommand = normalizeSubcommand(argv0, args, subcommandConfig);
  const argsString = args.join(" ");

  for (const rule of rules) {
    if (rule.match.argv0 !== argv0) continue;

    // subcommands チェック
    if (rule.match.subcommands !== undefined) {
      if (subcommand === null) continue;
      if (!rule.match.subcommands.includes(subcommand)) continue;
    }

    // arg-regex チェック
    if (rule.match.argRegex !== undefined) {
      const re = new RegExp(rule.match.argRegex);
      if (!re.test(argsString)) continue;
    }

    return { rule, subcommand };
  }

  return null;
}

/**
 * args を join した文字列を返す（テスト用 CLI 表示向け）。
 */
export function buildArgsString(args: string[]): string {
  return args.join(" ");
}
