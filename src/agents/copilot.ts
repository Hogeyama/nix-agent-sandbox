/**
 * GitHub Copilot CLI エージェント対応
 */

import type { ExecutionContext } from "../pipeline/context.ts";

/** Copilot CLI 固有のマウントと環境変数を追加 */
export function configureCopilot(ctx: ExecutionContext): ExecutionContext {
  const args = [...ctx.dockerArgs];
  const envVars = { ...ctx.envVars };

  // gh auth token で GitHub トークンを取得
  const token = getGhToken();
  if (token) {
    envVars["GITHUB_TOKEN"] = token;
  }

  // copilot バイナリのマウント (実体パスを解決してマウント)
  const copilotBin = findBinaryResolved("copilot");
  if (copilotBin) {
    args.push("-v", `${copilotBin}:/usr/local/bin/copilot:ro`);
  }

  return {
    ...ctx,
    dockerArgs: args,
    envVars,
    agentCommand: copilotBin ? ["copilot"] : [
      "bash",
      "-c",
      "curl -fsSL https://gh.io/copilot-install | bash && copilot",
    ],
  };
}

/** gh auth token を取得 */
function getGhToken(): string | null {
  try {
    const cmd = new Deno.Command("gh", {
      args: ["auth", "token"],
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

/** ホスト上のバイナリの実体パスを取得 (シンボリックリンク解決) */
function findBinaryResolved(name: string): string | null {
  try {
    const cmd = new Deno.Command("which", {
      args: [name],
      stdout: "piped",
      stderr: "null",
    });
    const output = cmd.outputSync();
    if (output.success) {
      const binPath = new TextDecoder().decode(output.stdout).trim();
      return Deno.realPathSync(binPath);
    }
  } catch {
    // ignore
  }
  return null;
}
