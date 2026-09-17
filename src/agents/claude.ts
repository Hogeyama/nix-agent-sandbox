/**
 * Claude Code エージェント対応
 */

import type {
  AgentConfigResult,
  AgentMode,
  ClaudeStatePaths,
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
  readonly mode?: AgentMode;
  readonly claudeState?: ClaudeStatePaths;
  readonly containerHome: string;
  readonly hostHome: string;
  readonly probes: ClaudeProbes;
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

  if (input.claudeState) {
    return {
      dockerArgs: args,
      envVars,
      agentCommand: ["claude"],
      mounts: [
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
  const which = Bun.which(name, { PATH: process.env.PATH ?? "" });
  if (!which) return null;
  try {
    const fs = require("node:fs");
    return fs.realpathSync(which);
  } catch {
    return null;
  }
}
