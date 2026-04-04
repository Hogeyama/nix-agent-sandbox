/**
 * OpenAI Codex CLI エージェント対応
 */

// ---------------------------------------------------------------------------
// Probe types & resolver (side-effectful)
// ---------------------------------------------------------------------------

/** Codex 用 probe 結果 */
export interface CodexProbes {
  readonly codexDirExists: boolean;
  readonly codexBinPath: string | null;
}

/** ホスト環境を調べて CodexProbes を返す (副作用あり) */
export function resolveCodexProbes(hostHome: string): CodexProbes {
  return {
    codexDirExists: dirExistsSync(`${hostHome}/.codex`),
    codexBinPath: findBinaryResolved("codex"),
  };
}

// ---------------------------------------------------------------------------
// Pure configurator
// ---------------------------------------------------------------------------

/** configureCodex の入力 */
export interface CodexConfigInput {
  readonly containerHome: string;
  readonly hostHome: string;
  readonly probes: CodexProbes;
  readonly priorDockerArgs: readonly string[];
  readonly priorEnvVars: Readonly<Record<string, string>>;
}

/** configureCodex の出力 */
export interface AgentConfigResult {
  readonly dockerArgs: string[];
  readonly envVars: Record<string, string>;
  readonly agentCommand: string[];
}

/** Codex 固有のマウントと環境変数を決定する (純粋関数) */
export function configureCodex(input: CodexConfigInput): AgentConfigResult {
  const { containerHome, hostHome, probes, priorDockerArgs, priorEnvVars } =
    input;
  const args = [...priorDockerArgs];
  const envVars = { ...priorEnvVars };

  // ~/.codex をマウント（認証情報・設定）
  if (probes.codexDirExists) {
    args.push("-v", `${hostHome}/.codex:${containerHome}/.codex`);
  }

  // codex バイナリのマウント (実体パスを解決してマウント)
  if (probes.codexBinPath) {
    args.push("-v", `${probes.codexBinPath}:/usr/local/bin/codex:ro`);
  }

  const agentCommand: string[] = probes.codexBinPath
    ? ["codex"]
    : ["bash", "-c", "echo 'codex binary not found'; exit 1"];

  return { dockerArgs: [...args], envVars, agentCommand };
}

// ---------------------------------------------------------------------------
// Internal helpers (side-effectful, used only by resolveCodexProbes)
// ---------------------------------------------------------------------------

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
