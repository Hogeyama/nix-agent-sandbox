/**
 * GitHub Copilot CLI エージェント対応
 */

// ---------------------------------------------------------------------------
// Probe types & resolver (side-effectful)
// ---------------------------------------------------------------------------

/** Copilot 用 probe 結果 */
export interface CopilotProbes {
  readonly copilotBinPath: string | null;
  readonly copilotLegacyDirExists: boolean;
}

/** ホスト環境を調べて CopilotProbes を返す (副作用あり) */
export function resolveCopilotProbes(hostHome: string): CopilotProbes {
  return {
    copilotBinPath: findBinaryResolved("copilot"),
    copilotLegacyDirExists: pathExistsSync(`${hostHome}/.copilot`),
  };
}

// ---------------------------------------------------------------------------
// Pure configurator
// ---------------------------------------------------------------------------

/** configureCopilot の入力 */
export interface CopilotConfigInput {
  readonly containerHome: string;
  readonly hostHome: string;
  readonly probes: CopilotProbes;
  readonly priorDockerArgs: readonly string[];
  readonly priorEnvVars: Readonly<Record<string, string>>;
}

/** configureCopilot の出力 */
export interface AgentConfigResult {
  readonly dockerArgs: string[];
  readonly envVars: Record<string, string>;
  readonly agentCommand: string[];
}

/** Copilot CLI 固有のマウントと環境変数を決定する (純粋関数) */
export function configureCopilot(input: CopilotConfigInput): AgentConfigResult {
  const { containerHome, hostHome, probes, priorDockerArgs, priorEnvVars } =
    input;
  const args = [...priorDockerArgs];
  const envVars = { ...priorEnvVars };

  // ~/.copilot (legacy state dir) のマウント
  if (probes.copilotLegacyDirExists) {
    args.push("-v", `${hostHome}/.copilot:${containerHome}/.copilot`);
  }

  // copilot バイナリのマウント (実体パスを解決してマウント)
  if (probes.copilotBinPath) {
    args.push("-v", `${probes.copilotBinPath}:/usr/local/bin/copilot:ro`);
  }

  const agentCommand: string[] = probes.copilotBinPath
    ? ["copilot"]
    : ["bash", "-c", "echo 'copilot binary not found'; exit 1"];

  return { dockerArgs: [...args], envVars, agentCommand };
}

// ---------------------------------------------------------------------------
// Internal helpers (side-effectful, used only by resolveCopilotProbes)
// ---------------------------------------------------------------------------

function pathExistsSync(p: string): boolean {
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
  const which = Bun.which(name, { PATH: process.env.PATH ?? "" });
  if (!which) return null;
  try {
    const fs = require("node:fs");
    return fs.realpathSync(which);
  } catch {
    return null;
  }
}
