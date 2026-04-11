/**
 * GitHub Copilot CLI エージェント対応
 */

// ---------------------------------------------------------------------------
// Probe types & resolver (side-effectful)
// ---------------------------------------------------------------------------

/** Copilot 用 probe 結果 */
export interface CopilotProbes {
  readonly copilotBinPath: string | null;
  readonly copilotConfigDirExists: boolean;
  readonly copilotStateDirExists: boolean;
  readonly copilotLegacyDirExists: boolean;
  /** ホスト環境変数 XDG_CONFIG_HOME */
  readonly xdgConfigHome: string | null;
  /** ホスト環境変数 XDG_STATE_HOME */
  readonly xdgStateHome: string | null;
}

/** ホスト環境を調べて CopilotProbes を返す (副作用あり) */
export function resolveCopilotProbes(hostHome: string): CopilotProbes {
  const xdgConfigHome = process.env["XDG_CONFIG_HOME"] ?? null;
  const xdgStateHome = process.env["XDG_STATE_HOME"] ?? null;

  const hostCopilotConfigDir = xdgConfigHome
    ? `${xdgConfigHome}/.copilot`
    : `${hostHome}/.copilot`;
  const hostCopilotStateDir = xdgStateHome
    ? `${xdgStateHome}/.copilot`
    : `${hostHome}/.copilot`;
  const hostLegacyCopilotDir = `${hostHome}/.copilot`;

  return {
    copilotBinPath: findBinaryResolved("copilot"),
    copilotConfigDirExists: pathExistsSync(hostCopilotConfigDir),
    copilotStateDirExists: pathExistsSync(hostCopilotStateDir),
    copilotLegacyDirExists:
      hostLegacyCopilotDir !== hostCopilotConfigDir &&
      hostLegacyCopilotDir !== hostCopilotStateDir
        ? pathExistsSync(hostLegacyCopilotDir)
        : false,
    xdgConfigHome,
    xdgStateHome,
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

  const xdgConfigHome = probes.xdgConfigHome;
  const xdgStateHome = probes.xdgStateHome;

  // Copilot が実際に使うパスを決定（XDG 未設定時は $HOME/.copilot）
  const hostCopilotConfigDir = xdgConfigHome
    ? `${xdgConfigHome}/.copilot`
    : `${hostHome}/.copilot`;
  const hostCopilotStateDir = xdgStateHome
    ? `${xdgStateHome}/.copilot`
    : `${hostHome}/.copilot`;

  const containerCopilotConfigDir = remapToContainer(
    hostCopilotConfigDir,
    hostHome,
    containerHome,
  );
  const containerCopilotStateDir = remapToContainer(
    hostCopilotStateDir,
    hostHome,
    containerHome,
  );

  // XDG_CONFIG_HOME をコンテナに渡す（ホストで設定されている場合のみ）
  if (xdgConfigHome) {
    envVars["XDG_CONFIG_HOME"] = remapToContainer(
      xdgConfigHome,
      hostHome,
      containerHome,
    );
  }

  // XDG_STATE_HOME をコンテナに渡す（ホストで設定されている場合のみ）
  if (xdgStateHome) {
    envVars["XDG_STATE_HOME"] = remapToContainer(
      xdgStateHome,
      hostHome,
      containerHome,
    );
  }

  // config ディレクトリをマウント
  if (probes.copilotConfigDirExists) {
    args.push("-v", `${hostCopilotConfigDir}:${containerCopilotConfigDir}`);
  }

  // state ディレクトリをマウント（config と同じ場合は重複を避ける）
  if (
    hostCopilotStateDir !== hostCopilotConfigDir &&
    probes.copilotStateDirExists
  ) {
    args.push("-v", `${hostCopilotStateDir}:${containerCopilotStateDir}`);
  }

  // Copilot v1.0.2 で config.json が ~/.copilot へシンボリックリンクになるケースをカバー
  if (probes.copilotLegacyDirExists) {
    const hostLegacyCopilotDir = `${hostHome}/.copilot`;
    const containerLegacyCopilotDir = remapToContainer(
      hostLegacyCopilotDir,
      hostHome,
      containerHome,
    );
    args.push("-v", `${hostLegacyCopilotDir}:${containerLegacyCopilotDir}`);
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
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * ホストのパスをコンテナ内パスにリマップする。
 * $HOME 配下のパスはコンテナ内の $HOME 配下に変換し、それ以外はそのまま返す。
 */
function remapToContainer(
  hostPath: string,
  hostHome: string,
  containerHome: string,
): string {
  if (hostPath.startsWith(hostHome + "/")) {
    return `${containerHome}/` + hostPath.slice(hostHome.length + 1);
  }
  return hostPath;
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
  const which = Bun.which(name, { PATH: process.env["PATH"] ?? "" });
  if (!which) return null;
  try {
    const fs = require("node:fs");
    return fs.realpathSync(which);
  } catch {
    return null;
  }
}
