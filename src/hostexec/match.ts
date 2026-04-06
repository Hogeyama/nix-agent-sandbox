import type { HostExecRule } from "../config/types.ts";
import * as path from "node:path";

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
    if (!argv0MatchesRule(rule.match.argv0, argv0)) continue;

    // arg-regex チェック
    if (rule.match.argRegex !== undefined) {
      const re = new RegExp(rule.match.argRegex);
      if (!re.test(argsString)) continue;
    }

    return { rule };
  }

  return null;
}

export function isRelativeHostExecArgv0(argv0: string): boolean {
  return argv0.startsWith("./") || argv0.startsWith("../");
}

export function isBareCommandHostExecArgv0(argv0: string): boolean {
  return !path.isAbsolute(argv0) && !argv0.includes("/");
}

function argv0MatchesRule(ruleArgv0: string, actualArgv0: string): boolean {
  if (isRelativeHostExecArgv0(ruleArgv0)) {
    return isRelativeHostExecArgv0(actualArgv0) &&
      path.normalize(ruleArgv0) === path.normalize(actualArgv0);
  }
  if (path.isAbsolute(ruleArgv0)) {
    return path.normalize(ruleArgv0) === path.normalize(actualArgv0);
  }
  return path.basename(actualArgv0) === ruleArgv0;
}

/**
 * args を join した文字列を返す（テスト用 CLI 表示向け）。
 */
export function buildArgsString(args: string[]): string {
  return args.join(" ");
}
