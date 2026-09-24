import * as path from "node:path";
import type { HostExecApproval, HostExecRule } from "../config/types.ts";

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
  if (path.isAbsolute(argv0)) return false;
  // Any non-absolute path containing '/' is relative (e.g. "./foo", "../foo", "hoge/fuga.bash")
  return argv0.includes("/");
}

export function isBareCommandHostExecArgv0(argv0: string): boolean {
  return !path.isAbsolute(argv0) && !argv0.includes("/");
}

/**
 * ルールに一致した要求について、ホストで起動する argv0 を返す。
 *
 * bare name のルールは、コンテナ側でどのパスから呼ばれたか
 * (`/opt/nas/hostexec/bin/git`, `tools/git` など) にかかわらずホスト PATH 上の
 * 同名コマンドを起動するので basename を返す。絶対・相対パスのルールは要求の
 * argv0 をそのまま起動する。
 *
 * 承認表示・承認キー・監査・実行のすべてがこの値を使う。表示だけ要求の生の
 * argv0 を見せると、ユーザーはワークスペースのスクリプトを承認したつもりで
 * ホストの別バイナリを走らせることになる。
 */
export function hostCommandArgv0(
  ruleArgv0: string,
  requestArgv0: string,
): string {
  return isBareCommandHostExecArgv0(ruleArgv0)
    ? path.basename(requestArgv0)
    : requestArgv0;
}

function argv0MatchesRule(
  ruleArgv0: string,
  actualArgv0: string,
  context?: MatchContext,
): boolean {
  if (isRelativeHostExecArgv0(ruleArgv0)) {
    if (isRelativeHostExecArgv0(actualArgv0)) {
      // 直接比較（同じ相対パス同士）
      if (path.normalize(ruleArgv0) === path.normalize(actualArgv0))
        return true;
      // CWD考慮: 実際の argv0 を cwd 基準で解決し、ワークスペースルートからの相対パスで比較
      if (context) {
        const absActual = path.resolve(context.cwd, actualArgv0);
        const relToWorkspace = path.relative(context.workspaceRoot, absActual);
        if (!relToWorkspace.startsWith("..")) {
          return (
            path.normalize(ruleArgv0) === path.normalize(`./${relToWorkspace}`)
          );
        }
      }
    } else if (path.isAbsolute(actualArgv0) && context) {
      // 絶対パスで exec された場合（nix develop 等がパスを解決するケース）:
      // ワークスペースルートからの相対パスでルールと比較
      const relToWorkspace = path.relative(context.workspaceRoot, actualArgv0);
      if (!relToWorkspace.startsWith("..")) {
        return (
          path.normalize(ruleArgv0) === path.normalize(`./${relToWorkspace}`)
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
 * argRegex が見る文字列（引数のスペース連結）から、引数の境界を一意に
 * 復元できないか。
 *
 * 空白を含む引数は複数の引数と区別できない（`["a b"]` と `["a", "b"]` は
 * どちらも `"a b"`。`\s` を区切りに書いたルールならタブや改行も同じ）。
 * 空の引数は `[]` と `[""]` を区別できない。どちらでもなければ連結は単射で、
 * argRegex は引数列そのものを見ているのと同じになる。
 */
export function argsAmbiguousForArgRegex(args: readonly string[]): boolean {
  return args.some((arg) => arg === "" || /\s/.test(arg));
}

/**
 * 一致したルールを、この引数列に対してどの承認で扱うか。
 *
 * `approval = "allow"` のルールの argRegex は、引数の境界が曖昧な要求に対して
 * 作者の意図より広く一致しうる（`^-u [^ ]+ --sign$` のような境界前提の正規表現が、
 * 1 引数に詰めた別の引数列にも一致する）。その場合だけ自動許可せず承認に回す。
 * integrity 変化時の格上げと同じく、黙ってルールを外してコンテナや後続ルールへ
 * 落とすより、ユーザーに実際の要求を見せる方を選ぶ。
 *
 * `"prompt"` と `"deny"` はそのまま返す。広く一致しても、承認を求めるか拒否する
 * だけで、許可が広がることはない。
 */
export function effectiveApproval(
  rule: HostExecRule,
  args: readonly string[],
): HostExecApproval {
  if (
    rule.approval === "allow" &&
    rule.match.argRegex !== undefined &&
    argsAmbiguousForArgRegex(args)
  ) {
    return "prompt";
  }
  return rule.approval;
}

/**
 * args を join した文字列を返す（テスト用 CLI 表示向け）。
 */
export function buildArgsString(args: string[]): string {
  return args.join(" ");
}
