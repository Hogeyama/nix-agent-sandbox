/**
 * OpenAI Codex CLI エージェント対応
 */

import path from "node:path";
import type { AgentConfigResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Probe types & resolver (side-effectful)
// ---------------------------------------------------------------------------

/** Codex 用 probe 結果 */
export interface CodexProbes {
  readonly codexDirExists: boolean;
  readonly codexBinPath: string | null;
  readonly codexCodeModeHostBinPath: string | null;
}

/** ホスト環境を調べて CodexProbes を返す (副作用あり) */
export function resolveCodexProbes(hostHome: string): CodexProbes {
  const codexBinPath = findBinaryResolved("codex");
  return {
    codexDirExists: dirExistsSync(`${hostHome}/.codex`),
    codexBinPath,
    codexCodeModeHostBinPath: findSiblingExecutableResolved(
      codexBinPath,
      "codex-code-mode-host",
    ),
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

  if (probes.codexCodeModeHostBinPath) {
    args.push(
      "-v",
      `${probes.codexCodeModeHostBinPath}:/usr/local/bin/codex-code-mode-host:ro`,
    );
  }

  const agentCommand: string[] = probes.codexBinPath
    ? ["codex", "-c", "shell_environment_policy.inherit=all"]
    : ["bash", "-c", "echo 'codex binary not found'; exit 1"];

  return { dockerArgs: [...args], envVars, agentCommand };
}

// ---------------------------------------------------------------------------
// Internal helpers (side-effectful, used only by resolveCodexProbes)
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

function findSiblingExecutableResolved(
  executablePath: string | null,
  siblingName: string,
): string | null {
  if (!executablePath) return null;
  try {
    const fs = require("node:fs");
    const siblingPath = fs.realpathSync(
      path.join(path.dirname(executablePath), siblingName),
    );
    if (!fs.statSync(siblingPath).isFile()) return null;
    fs.accessSync(siblingPath, fs.constants.R_OK | fs.constants.X_OK);
    return siblingPath;
  } catch {
    return null;
  }
}
