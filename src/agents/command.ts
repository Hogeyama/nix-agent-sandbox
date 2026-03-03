/**
 * エージェント起動コマンド共通ヘルパー
 */

/** tmux タイトル通知してからエージェントを exec する */
export function buildAgentCommandWithTmuxTitle(
  binaryName: string,
  title: string,
): string[] {
  return [
    "bash",
    "-lc",
    `printf '\\033k${title}\\033\\\\'; exec ${binaryName} "$@"`,
    "--",
  ];
}
