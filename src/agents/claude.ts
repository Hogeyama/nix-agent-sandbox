/**
 * Claude Code エージェント対応
 */

const DEFAULT_CONTAINER_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// ---------------------------------------------------------------------------
// Probe types & resolver (side-effectful)
// ---------------------------------------------------------------------------

/** Claude 用 probe 結果 */
export interface ClaudeProbes {
  readonly claudeDirExists: boolean;
  readonly claudeJsonExists: boolean;
  readonly claudeBinPath: string | null;
}

/** ホスト環境を調べて ClaudeProbes を返す (副作用あり) */
export function resolveClaudeProbes(hostHome: string): ClaudeProbes {
  return {
    claudeDirExists: dirExistsSync(`${hostHome}/.claude`),
    claudeJsonExists: fileExistsSync(`${hostHome}/.claude.json`),
    claudeBinPath: findBinaryResolved("claude"),
  };
}

// ---------------------------------------------------------------------------
// Pure configurator
// ---------------------------------------------------------------------------

/** configureClaude の入力 */
export interface ClaudeConfigInput {
  readonly containerHome: string;
  readonly hostHome: string;
  readonly probes: ClaudeProbes;
  readonly priorDockerArgs: readonly string[];
  readonly priorEnvVars: Readonly<Record<string, string>>;
}

/** configureClaude の出力 */
export interface AgentConfigResult {
  readonly dockerArgs: string[];
  readonly envVars: Record<string, string>;
  readonly agentCommand: string[];
}

/** Claude Code 固有のマウントと環境変数を決定する (純粋関数) */
export function configureClaude(input: ClaudeConfigInput): AgentConfigResult {
  const { containerHome, hostHome, probes, priorDockerArgs, priorEnvVars } =
    input;
  const args = [...priorDockerArgs];
  const envVars = { ...priorEnvVars };
  const containerLocalBin = `${containerHome}/.local/bin`;

  envVars["PATH"] = `${containerLocalBin}:${
    envVars["PATH"] ?? DEFAULT_CONTAINER_PATH
  }`;

  // ~/.claude/ をマウント（認証情報 + セッション履歴）
  if (probes.claudeDirExists) {
    args.push("-v", `${hostHome}/.claude:${containerHome}/.claude`);
  }

  // ~/.claude.json をマウント（設定）
  if (probes.claudeJsonExists) {
    args.push("-v", `${hostHome}/.claude.json:${containerHome}/.claude.json`);
  }

  // claude バイナリのマウント (実体パスを解決してマウント)
  if (probes.claudeBinPath) {
    args.push("-v", `${probes.claudeBinPath}:${containerLocalBin}/claude:ro`);
  }

  const agentCommand: string[] = probes.claudeBinPath
    ? ["claude"]
    : [
        "bash",
        "-c",
        "curl -fsSL https://claude.ai/install.sh | bash && claude",
      ];

  return { dockerArgs: [...args], envVars, agentCommand };
}

// ---------------------------------------------------------------------------
// Internal helpers (side-effectful, used only by resolveClaudeProbes)
// ---------------------------------------------------------------------------

/** ディレクトリが存在するか判定 */
function dirExistsSync(p: string): boolean {
  try {
    const { statSync } = require("node:fs");
    const s = statSync(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** ファイルが存在するか判定 */
function fileExistsSync(p: string): boolean {
  try {
    const { statSync } = require("node:fs");
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** ホスト上のバイナリの実体パスを取得 (シンボリックリンク解決) */
function findBinaryResolved(name: string): string | null {
  const which = Bun.which(name, { PATH: process.env["PATH"] ?? "" });
  if (!which) return null;
  try {
    const fs = require("node:fs");
    return fs.realpathSync(which);
  } catch {
    return null;
  }
}
