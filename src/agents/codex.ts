/**
 * OpenAI Codex CLI エージェント対応
 */

import type { ExecutionContext } from "../pipeline/context.ts";

/** Codex 固有のマウントと環境変数を追加 */
export function configureCodex(ctx: ExecutionContext): ExecutionContext {
  const args = [...ctx.dockerArgs];
  const envVars = { ...ctx.envVars };
  const containerHome = ctx.envVars["NAS_HOME"] ?? resolveContainerHome();
  const home = Deno.env.get("HOME") ?? "/root";

  // ~/.codex をマウント（認証情報・設定）
  const codexDir = `${home}/.codex`;
  if (dirExistsSync(codexDir)) {
    args.push("-v", `${codexDir}:${containerHome}/.codex`);
  }

  // codex バイナリのマウント (実体パスを解決してマウント)
  const codexBin = findBinaryResolved("codex");
  if (codexBin) {
    args.push("-v", `${codexBin}:/usr/local/bin/codex:ro`);
  }

  return {
    ...ctx,
    dockerArgs: args,
    envVars,
    agentCommand: codexBin
      ? ["codex"]
      : ["bash", "-c", "echo 'codex binary not found'; exit 1"],
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
