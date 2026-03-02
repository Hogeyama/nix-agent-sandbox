/**
 * Claude Code エージェント対応
 */

import type { ExecutionContext } from "../pipeline/context.ts";

/** Claude Code 固有のマウントと環境変数を追加 */
export function configureClaude(ctx: ExecutionContext): ExecutionContext {
  const args = [...ctx.dockerArgs];
  const envVars = { ...ctx.envVars };

  // ~/.claude/ をマウント（認証情報）
  const home = Deno.env.get("HOME") ?? "/root";
  const claudeDir = `${home}/.claude`;
  try {
    Deno.statSync(claudeDir);
    args.push("-v", `${claudeDir}:/root/.claude`);
  } catch {
    // ~/.claude が無い場合はスキップ
  }

  // claude バイナリのマウント
  const claudeBin = findBinary("claude");
  if (claudeBin) {
    args.push("-v", `${claudeBin}:/usr/local/bin/claude:ro`);
  }

  return {
    ...ctx,
    dockerArgs: args,
    envVars,
    agentCommand: claudeBin ? ["claude"] : [
      "bash",
      "-c",
      "curl -fsSL https://claude.ai/install.sh | bash && claude",
    ],
  };
}

/** ホスト上のバイナリパスを取得 */
function findBinary(name: string): string | null {
  try {
    const cmd = new Deno.Command("which", {
      args: [name],
      stdout: "piped",
      stderr: "null",
    });
    const output = cmd.outputSync();
    if (output.success) {
      return new TextDecoder().decode(output.stdout).trim();
    }
  } catch {
    // ignore
  }
  return null;
}
