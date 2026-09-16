/**
 * プロファイル名より前に置く nas 自身のオプション。
 *
 * これらはプロファイル名の判定より先に取り除く必要がある。値を残したままだと
 * `parseProfileAndWorktreeArgs` と `findFirstNonFlagArg` が、フラグの値を
 * プロファイル名として拾う。
 */

/** 値を 1 つ取る制御オプション。`--flag value` と `--flag=value` の両方を受ける。 */
const VALUE_FLAGS = ["--log-file", "--write-session-id"] as const;

/** 制御プレフィクス以降へ素通しする、値を 1 つ取るオプション。 */
const PASSTHROUGH_VALUE_FLAGS = [
  "--name",
  "--worktree",
  "-b",
  "--scope",
  "--runtime-dir",
  "--port",
  "--since",
  "--session",
  "--domain",
  "--audit-dir",
  "--format",
];

export interface ControlOptions {
  args: string[];
  logFile?: string;
  writeSessionId?: string;
}

/** nas の制御オプションを、制御プレフィクスの中だけで消費する。 */
export function extractControlOptions(args: readonly string[]): ControlOptions {
  const result: string[] = [];
  const values: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--" || !arg.startsWith("-")) {
      result.push(...args.slice(i));
      break;
    }

    const flag = VALUE_FLAGS.find(
      (name) => arg === name || arg.startsWith(`${name}=`),
    );
    if (flag) {
      const value = arg === flag ? args[++i] : arg.slice(flag.length + 1);
      if (!value || value.startsWith("-")) {
        throw new Error(`${flag} requires a path.`);
      }
      values[flag] = value;
      continue;
    }

    result.push(arg);
    if (PASSTHROUGH_VALUE_FLAGS.includes(arg) && i + 1 < args.length) {
      result.push(args[++i]);
    }
  }

  return {
    args: result,
    logFile: values["--log-file"],
    writeSessionId: values["--write-session-id"],
  };
}
