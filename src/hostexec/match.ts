import * as path from "node:path";
import type { HostExecRule } from "../config/types.ts";

export interface MatchResult {
  rule: HostExecRule;
}

export interface MatchContext {
  /** コンテナ内での実行時 cwd（絶対パス） */
  cwd: string;
  /** コンテナ内でのワークスペースルート（絶対パス） */
  workspaceRoot: string;
}

/**
 * ルール配列から最初にマッチするルールを返す。
 * マッチしなければ null。
 */
export function matchRule(
  rules: HostExecRule[],
  argv0: string,
  args: string[],
  context?: MatchContext,
): MatchResult | null {
  const argsString = args.join(" ");

  for (const rule of rules) {
    if (!argv0MatchesRule(rule.match.argv0, argv0, context)) continue;

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

function argv0MatchesRule(
  ruleArgv0: string,
  actualArgv0: string,
  context?: MatchContext,
): boolean {
  if (isRelativeHostExecArgv0(ruleArgv0)) {
    if (!isRelativeHostExecArgv0(actualArgv0)) return false;
    // 直接比較（同じ相対パス同士）
    if (path.normalize(ruleArgv0) === path.normalize(actualArgv0)) return true;
    // CWD考慮: 実際の argv0 を cwd 基準で解決し、ワークスペースルートからの相対パスで比較
    if (context) {
      const absActual = path.resolve(context.cwd, actualArgv0);
      const relToWorkspace = path.relative(context.workspaceRoot, absActual);
      if (!relToWorkspace.startsWith("..")) {
        return (
          path.normalize(ruleArgv0) === path.normalize("./" + relToWorkspace)
        );
      }
    }
    return false;
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
