/**
 * Claude Code エージェント対応
 */

import type { ExecutionContext } from "../pipeline/context.ts";

const DEFAULT_CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Claude Code 固有のマウントと環境変数を追加 */
export function configureClaude(ctx: ExecutionContext): ExecutionContext {
  const args = [...ctx.dockerArgs];
  const envVars = { ...ctx.envVars };
  const containerHome = ctx.envVars["NAS_HOME"] ?? resolveContainerHome();
  const containerLocalBin = `${containerHome}/.local/bin`;

  const home = Deno.env.get("HOME") ?? "/root";
  envVars["PATH"] = `${containerLocalBin}:${envVars["PATH"] ?? DEFAULT_CONTAINER_PATH}`;

  // ~/.claude/ をマウント（認証情報 + セッション履歴）
  const claudeDir = `${home}/.claude`;
  if (dirExistsSync(claudeDir)) {
    args.push("-v", `${claudeDir}:${containerHome}/.claude`);
  }

  // ~/.claude.json をマウント（設定）
  const claudeJson = `${home}/.claude.json`;
  if (fileExistsSync(claudeJson)) {
    args.push("-v", `${claudeJson}:${containerHome}/.claude.json`);
  }

  // claude バイナリのマウント (実体パスを解決してマウント)
  const claudeBin = findBinaryResolved("claude");
  if (claudeBin) {
    args.push("-v", `${claudeBin}:${containerLocalBin}/claude:ro`);
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

/** ディレクトリが存在するか判定 */
function dirExistsSync(path: string): boolean {
  try {
    const stat = Deno.statSync(path);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

/** ファイルが存在するか判定 */
function fileExistsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
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

function resolveContainerHome(): string {
  const user = Deno.env.get("USER")?.trim();
  return `/home/${user || "nas"}`;
}
