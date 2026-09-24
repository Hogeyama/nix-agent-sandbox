/**
 * GitHub Copilot CLI エージェント対応
 */

import {
  COPILOT_SETTINGS_FILES,
  existingSettingsFiles,
  settingsMountArgs,
} from "./settings_protection.ts";
import type { AgentConfigResult, AgentProvisionResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Probe types & resolver (side-effectful)
// ---------------------------------------------------------------------------

/** Copilot 用 probe 結果 */
export interface CopilotProbes {
  readonly copilotBinPath: string | null;
  readonly copilotLegacyDirExists: boolean;
  /**
   * `~/.copilot` 配下に実在する設定ファイル (ディレクトリからの相対パス)。
   *
   * MCP サーバの起動コマンドを持つため、`protectSettings` が立っているときは
   * RO で上乗せする。see settings_protection.ts
   */
  readonly copilotSettingsFiles: readonly string[];
}

/** ホスト環境を調べて CopilotProbes を返す (副作用あり) */
export function resolveCopilotProbes(hostHome: string): CopilotProbes {
  return {
    copilotBinPath: findBinaryResolved("copilot"),
    copilotLegacyDirExists: pathExistsSync(`${hostHome}/.copilot`),
    copilotSettingsFiles: existingSettingsFiles(
      `${hostHome}/.copilot`,
      COPILOT_SETTINGS_FILES,
    ),
  };
}

// ---------------------------------------------------------------------------
// Pure configurator
// ---------------------------------------------------------------------------

/** configureCopilot / provisionCopilot の入力 */
export interface CopilotConfigInput {
  readonly containerHome: string;
  readonly hostHome: string;
  readonly probes: CopilotProbes;
  /** `~/.copilot` 配下の設定ファイルを RO で上乗せするか。 */
  readonly protectSettings: boolean;
  readonly priorDockerArgs: readonly string[];
  readonly priorEnvVars: Readonly<Record<string, string>>;
}

/**
 * Copilot CLI をコンテナ内で使えるようにするマウントと環境変数を決定する
 * (純粋関数)。起動コマンドと起動時だけの設定は configureCopilot が足す。
 */
export function provisionCopilot(
  input: CopilotConfigInput,
): AgentProvisionResult {
  const { containerHome, hostHome, probes, priorDockerArgs, priorEnvVars } =
    input;
  const args = [...priorDockerArgs];
  const envVars = { ...priorEnvVars };

  // ~/.copilot (legacy state dir) のマウント
  if (probes.copilotLegacyDirExists) {
    args.push("-v", `${hostHome}/.copilot:${containerHome}/.copilot`);
    args.push(
      ...settingsMountArgs(
        `${hostHome}/.copilot`,
        `${containerHome}/.copilot`,
        input.protectSettings ? probes.copilotSettingsFiles : [],
      ),
    );
  }

  // copilot バイナリのマウント (実体パスを解決してマウント)
  if (probes.copilotBinPath) {
    args.push("-v", `${probes.copilotBinPath}:/usr/local/bin/copilot:ro`);
  }

  return { dockerArgs: [...args], envVars };
}

/** Copilot CLI 固有のマウントと環境変数、起動コマンドを決定する (純粋関数) */
export function configureCopilot(input: CopilotConfigInput): AgentConfigResult {
  const provisioned = provisionCopilot(input);
  const envVars = { ...provisioned.envVars };

  // Copilot CLI の clipboard モジュールは X11/Wayland にネイティブで繋ぎに行くが、
  // REMOTE_CONTAINERS が立っていると native クリップボードを諦めて OSC52 のみ使う。
  // ホスト側ターミナル (xterm.js + @xterm/addon-clipboard) が OSC52 を受けるので
  // これでコンテナ内 → ホストクリップボードのコピーが成立する。対話 UI の
  // ための設定で、コンテナ全体の環境変数に入るので起動するときだけ立てる。
  envVars.REMOTE_CONTAINERS ??= "true";

  const agentCommand: string[] = input.probes.copilotBinPath
    ? ["copilot"]
    : ["bash", "-c", "echo 'copilot binary not found'; exit 1"];

  return { ...provisioned, envVars, agentCommand };
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
