/**
 * Claude Code エージェント対応
 */

import {
  CLAUDE_SETTINGS_FILES,
  existingSettingsFiles,
} from "./settings_protection.ts";
import type {
  AgentConfigResult,
  AgentMode,
  ClaudeStatePaths,
  ProtectedClaudeState,
} from "./types.ts";

const DEFAULT_CONTAINER_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** Resolved from the container PATH; users provide the adapter and its runtime. */
export const CLAUDE_AGENT_ACP_COMMAND = "claude-agent-acp";
export const NAS_PROXY_CA_CERT_PATH =
  "/usr/local/share/ca-certificates/nas-proxy.crt";

// ---------------------------------------------------------------------------
// Probe types & resolver (side-effectful)
// ---------------------------------------------------------------------------

/** Claude 用 probe 結果 */
export interface ClaudeProbes {
  readonly claudeDirExists: boolean;
  readonly claudeJsonExists: boolean;
  readonly claudeBinPath: string | null;
  /**
   * `~/.claude` 配下に実在する設定ファイル (ディレクトリからの相対パス)。
   *
   * hooks や statusLine としてホスト上でコマンドを実行させる設定を持つため、
   * `protectSettings` が立っているときは RO で上乗せする。
   * see settings_protection.ts
   */
  readonly claudeSettingsFiles: readonly string[];
}

/** ホスト環境を調べて ClaudeProbes を返す (副作用あり) */
export function resolveClaudeProbes(hostHome: string): ClaudeProbes {
  return {
    claudeDirExists: dirExistsSync(`${hostHome}/.claude`),
    claudeJsonExists: fileExistsSync(`${hostHome}/.claude.json`),
    claudeBinPath: findBinaryResolved("claude"),
    claudeSettingsFiles: existingSettingsFiles(
      `${hostHome}/.claude`,
      CLAUDE_SETTINGS_FILES,
    ),
  };
}

// ---------------------------------------------------------------------------
// Pure configurator
// ---------------------------------------------------------------------------

/** configureClaude の入力 */
export interface ClaudeConfigInput {
  readonly mode?: AgentMode;
  readonly claudeState?: ClaudeStatePaths;
  readonly protectedClaudeState?: ProtectedClaudeState;
  readonly containerHome: string;
  readonly hostHome: string;
  readonly probes: ClaudeProbes;
  /** ホストの設定類を RO にし、認証・履歴だけを RW 共有するか。 */
  readonly protectSettings: boolean;
  readonly priorDockerArgs: readonly string[];
  readonly priorEnvVars: Readonly<Record<string, string>>;
}

/** Claude Code 固有のマウントと環境変数を決定する (純粋関数) */
export function configureClaude(input: ClaudeConfigInput): AgentConfigResult {
  const { containerHome, hostHome, probes, priorDockerArgs, priorEnvVars } =
    input;
  const args = [...priorDockerArgs];
  const envVars = { ...priorEnvVars };
  const containerLocalBin = `${containerHome}/.local/bin`;
  const mode = input.mode ?? "terminal";

  envVars.PATH = `${containerLocalBin}:${
    envVars.PATH ?? DEFAULT_CONTAINER_PATH
  }`;

  if (input.protectSettings && !input.protectedClaudeState) {
    throw new Error(
      "[nas] Protected Claude state must be prepared before configuring Claude",
    );
  }

  const stateMounts = input.protectedClaudeState
    ? [
        {
          source: input.protectedClaudeState.runtimeDir,
          target: `${containerHome}/.claude`,
        },
        ...input.protectedClaudeState.entries.map((entry) => ({
          source: entry.source,
          target: `${containerHome}/.claude/${entry.name}`,
          readOnly: entry.readOnly,
        })),
        {
          source: input.protectedClaudeState.claudeJson,
          target: `${containerHome}/.claude.json`,
        },
      ]
    : undefined;

  if (input.claudeState) {
    return {
      dockerArgs: args,
      envVars,
      agentCommand: ["claude"],
      mounts: stateMounts ?? [
        {
          source: input.claudeState.claudeDir,
          target: `${containerHome}/.claude`,
        },
        {
          source: input.claudeState.claudeJson,
          target: `${containerHome}/.claude.json`,
        },
      ],
    };
  }

  // ~/.claude/ をマウント（認証情報 + セッション履歴）
  if (!stateMounts && probes.claudeDirExists) {
    args.push("-v", `${hostHome}/.claude:${containerHome}/.claude`);
  }

  // ~/.claude.json をマウント（設定）
  if (!stateMounts && probes.claudeJsonExists) {
    args.push("-v", `${hostHome}/.claude.json:${containerHome}/.claude.json`);
  }

  // claude バイナリのマウント (実体パスを解決してマウント)
  if (probes.claudeBinPath) {
    args.push("-v", `${probes.claudeBinPath}:${containerLocalBin}/claude:ro`);
  }

  if (mode === "acp") {
    if (!probes.claudeBinPath) {
      throw new Error(
        "[nas] ACP mode requires Claude Code installed on the host; install and log in to Claude on the host before starting nas",
      );
    }
    envVars.CLAUDE_CODE_EXECUTABLE = `${containerLocalBin}/claude`;
    envVars.NODE_EXTRA_CA_CERTS = NAS_PROXY_CA_CERT_PATH;
    return {
      dockerArgs: [...args],
      mounts: stateMounts,
      envVars,
      agentCommand: [CLAUDE_AGENT_ACP_COMMAND],
    };
  }

  const agentCommand: string[] = probes.claudeBinPath
    ? ["claude"]
    : [
        "bash",
        "-c",
        // Tokens appended after `bash -c <script>` become the script's own
        // $0, $1, ... — not arguments to `claude` — so anything the launch
        // stage appends (e.g. --add-dir, profile.agentArgs) would otherwise
        // be silently dropped. Forward them explicitly via "$@"; the extra
        // "claude" token supplies the required $0 placeholder that "$@"
        // does not include.
        'curl -fsSL https://claude.ai/install.sh | bash && claude "$@"',
        "claude",
      ];

  return { dockerArgs: [...args], mounts: stateMounts, envVars, agentCommand };
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
  const which = Bun.which(name, { PATH: process.env.PATH ?? "" });
  if (!which) return null;
  try {
    const fs = require("node:fs");
    return fs.realpathSync(which);
  } catch {
    return null;
  }
}
