/**
 * OpenAI Codex CLI エージェント対応
 */

import path from "node:path";
import {
  CODEX_SETTINGS_FILES,
  existingSettingsFiles,
  settingsMountArgs,
  settingsMountSpecs,
} from "./settings_protection.ts";
import type {
  AgentConfigResult,
  AgentProvisionResult,
  CodexStatePaths,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Probe types & resolver (side-effectful)
// ---------------------------------------------------------------------------

/** Codex 用 probe 結果 */
export interface CodexProbes {
  readonly codexDirExists: boolean;
  readonly codexBinPath: string | null;
  readonly codexCodeModeHostBinPath: string | null;
  /**
   * `~/.codex` 配下に実在する設定ファイル (ディレクトリからの相対パス)。
   *
   * hooks と MCP サーバの起動コマンドを持つため、`protectSettings` が
   * 立っているときは RO で上乗せする。see settings_protection.ts
   */
  readonly codexSettingsFiles: readonly string[];
}

/** ホスト環境を調べて CodexProbes を返す (副作用あり) */
export function resolveCodexProbes(hostHome: string): CodexProbes {
  const codexBinPath = findBinaryResolved("codex");
  return {
    codexDirExists: dirExistsSync(`${hostHome}/.codex`),
    codexBinPath,
    codexSettingsFiles: existingSettingsFiles(
      `${hostHome}/.codex`,
      CODEX_SETTINGS_FILES,
    ),
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
export interface CodexConfigInput extends CodexProvisionInput {
  readonly codexState?: CodexStatePaths;
}

/** provisionCodex の入力 */
export interface CodexProvisionInput {
  readonly containerHome: string;
  readonly hostHome: string;
  readonly probes: CodexProbes;
  /** `~/.codex` 配下の設定ファイルを RO で上乗せするか。 */
  readonly protectSettings: boolean;
  readonly priorDockerArgs: readonly string[];
  readonly priorEnvVars: Readonly<Record<string, string>>;
}

/**
 * Codex をコンテナ内で使えるようにするマウントと環境変数を決定する
 * (純粋関数)。起動コマンドは configureCodex が足す。
 */
export function provisionCodex(
  input: CodexProvisionInput & { readonly codexState?: CodexStatePaths },
): AgentProvisionResult {
  const { containerHome, hostHome, probes, priorDockerArgs, priorEnvVars } =
    input;
  const args = [...priorDockerArgs];
  const envVars = { ...priorEnvVars };

  // Dev Container (Compose) path: ~/.codex always mounts — the runtime
  // creates it on the host first — as structured MountSpecs so colon-bearing
  // paths survive. The host codex binary is deliberately not mounted; the
  // devcontainer-codex wrapper execs the extension-bundled binary so the
  // app-server protocol version always matches the extension.
  if (input.codexState) {
    return {
      dockerArgs: args,
      envVars,
      mounts: [
        {
          source: input.codexState.codexDir,
          target: `${containerHome}/.codex`,
        },
        ...settingsMountSpecs(
          input.codexState.codexDir,
          `${containerHome}/.codex`,
          input.protectSettings ? probes.codexSettingsFiles : [],
        ),
      ],
    };
  }

  // ~/.codex をマウント（認証情報・設定）
  if (probes.codexDirExists) {
    args.push("-v", `${hostHome}/.codex:${containerHome}/.codex`);
    args.push(
      ...settingsMountArgs(
        `${hostHome}/.codex`,
        `${containerHome}/.codex`,
        input.protectSettings ? probes.codexSettingsFiles : [],
      ),
    );
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

  return { dockerArgs: [...args], envVars };
}

/** Codex 固有のマウントと環境変数、起動コマンドを決定する (純粋関数) */
export function configureCodex(input: CodexConfigInput): AgentConfigResult {
  const provisioned = provisionCodex(input);
  if (input.codexState) {
    return { ...provisioned, agentCommand: ["codex"] };
  }
  const agentCommand: string[] = input.probes.codexBinPath
    ? ["codex", "-c", "shell_environment_policy.inherit=all"]
    : ["bash", "-c", "echo 'codex binary not found'; exit 1"];
  return { ...provisioned, agentCommand };
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
