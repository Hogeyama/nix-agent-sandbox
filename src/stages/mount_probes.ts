/**
 * MountStage 用の I/O プローブ解決
 *
 * 全てのファイル存在チェック・コマンド実行・stat 呼び出しをここで行い、
 * plan() が純粋関数になるようにデータとして返す。
 */

import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { ClaudeProbes } from "../agents/claude.ts";
import { resolveClaudeProbes } from "../agents/claude.ts";
import type { CodexProbes } from "../agents/codex.ts";
import { resolveCodexProbes } from "../agents/codex.ts";
import type { CopilotProbes } from "../agents/copilot.ts";
import { resolveCopilotProbes } from "../agents/copilot.ts";
import type { EnvConfig, ExtraMountConfig, Profile } from "../config/types.ts";
import type { HostEnv } from "../pipeline/types.ts";
// ---------------------------------------------------------------------------
// Types — pre-resolved I/O results
// ---------------------------------------------------------------------------

/** Extra mount の事前解決結果 */
export interface ResolvedExtraMount {
  /** ホスト上の正規化された絶対パス */
  normalizedSrc: string;
  /** ソースが存在するか */
  srcExists: boolean;
  /** ソースがディレクトリか (srcExists=false の場合 false) */
  srcIsDirectory: boolean;
  /** 元のモード */
  mode: "ro" | "rw";
  /** 元の index (エラーメッセージ用) */
  index: number;
}

/** 環境変数エントリの事前解決結果 */
interface ResolvedEnvEntryBase {
  /** 解決済みキー */
  key: string;
  /** 解決済み値 */
  value: string;
  /** 元の index (エラーメッセージ用) */
  index: number;
  /** key の出典 ("key" | "key_cmd") */
  keySource: "key" | "key_cmd";
}
export type ResolvedEnvEntry =
  | (ResolvedEnvEntryBase & { mode: "set"; separator?: undefined })
  | (ResolvedEnvEntryBase & { mode: "prefix" | "suffix"; separator: string });

/** MountStage が必要とする全ての I/O 結果 */
export interface MountProbes {
  /** エージェント固有の probe 結果 */
  agentProbes: ClaudeProbes | CopilotProbes | CodexProbes;
  /** /etc/nix/nix.conf の実体パス (readlink -f の結果, 存在しなければ null) */
  nixConfRealPath: string | null;
  /** nix バイナリの実体パス */
  nixBinPath: string | null;
  /** git 設定ディレクトリ ($HOME/.config/git) が存在するか */
  gitConfigExists: boolean;
  /** gcloud 設定ディレクトリ ($HOME/.config/gcloud) が存在するか */
  gcloudConfigExists: boolean;
  /** GPG ソケットが存在するか (probes.gpgAgentSocket のパス) */
  gpgSocketExists: boolean;
  /** GPG 関連ファイルの存在チェック */
  gpgConfExists: boolean;
  gpgAgentConfExists: boolean;
  gpgPubringExists: boolean;
  gpgTrustdbExists: boolean;
  /** AWS 設定ディレクトリ ($HOME/.aws) が存在するか */
  awsConfigExists: boolean;
  /** X11 ソケットディレクトリ (/tmp/.X11-unix) が存在するか */
  x11SocketDirExists: boolean;
  /** Xauthority ファイルが存在するか */
  xauthorityExists: boolean;
  /** Xauthority ファイルパス (ホスト上) */
  xauthorityPath: string;
  /** 追加マウントの事前解決結果 */
  resolvedExtraMounts: ResolvedExtraMount[];
  /** 環境変数エントリの事前解決結果 */
  resolvedEnvEntries: ResolvedEnvEntry[];
}

// ---------------------------------------------------------------------------
// resolveMountProbes — side-effectful I/O resolver
// ---------------------------------------------------------------------------

/**
 * MountStage が必要とする全ての I/O を事前解決する。
 *
 * plan() が純粋関数になるよう、全てのファイル存在チェック・コマンド実行・
 * stat 呼び出しをここで行い、結果をデータとして返す。
 */
export async function resolveMountProbes(
  hostEnv: HostEnv,
  profile: Profile,
  workDir: string,
  gpgAgentSocket: string | null,
): Promise<MountProbes> {
  const home = hostEnv.home;

  // エージェント probe
  const agentProbes = resolveAgentProbes(profile.agent, home);

  // Nix 関連
  const [nixConfRealPath, nixBinPath] = await Promise.all([
    resolveRealPath("/etc/nix/nix.conf"),
    resolveNixBinPath(),
  ]);

  // ファイル存在チェックを並列実行
  const gitConfigDir = `${home}/.config/git`;
  const gcloudConfigDir = `${home}/.config/gcloud`;
  const awsConfigDir = `${home}/.aws`;
  const gpgConf = `${home}/.gnupg/gpg.conf`;
  const gpgAgentConf = `${home}/.gnupg/gpg-agent.conf`;
  const pubring = `${home}/.gnupg/pubring.kbx`;
  const trustdb = `${home}/.gnupg/trustdb.gpg`;
  const xauthorityPath = hostEnv.env.get("XAUTHORITY") ?? `${home}/.Xauthority`;

  const [
    gitConfigExists,
    gcloudConfigExists,
    awsConfigExists,
    gpgConfExists,
    gpgAgentConfExists,
    gpgPubringExists,
    gpgTrustdbExists,
    x11SocketDirExists,
    xauthorityExists,
  ] = await Promise.all([
    fileExists(gitConfigDir),
    fileExists(gcloudConfigDir),
    fileExists(awsConfigDir),
    fileExists(gpgConf),
    fileExists(gpgAgentConf),
    fileExists(pubring),
    fileExists(trustdb),
    fileExists("/tmp/.X11-unix"),
    fileExists(xauthorityPath),
  ]);

  // GPG ソケット存在チェック
  const gpgSocketExists = gpgAgentSocket
    ? await fileExists(gpgAgentSocket)
    : false;

  // 追加マウントの解決
  const resolvedExtraMounts = await resolveExtraMounts(
    profile.extraMounts,
    workDir,
    home,
  );

  // 環境変数エントリの解決 (val_cmd / key_cmd の実行)
  const resolvedEnvEntries = await resolveEnvEntries(profile.env);

  return {
    agentProbes,
    nixConfRealPath,
    nixBinPath,
    gitConfigExists,
    gcloudConfigExists,
    gpgSocketExists,
    gpgConfExists,
    gpgAgentConfExists,
    gpgPubringExists,
    gpgTrustdbExists,
    awsConfigExists,
    x11SocketDirExists,
    xauthorityExists,
    xauthorityPath,
    resolvedExtraMounts,
    resolvedEnvEntries,
  };
}

// ---------------------------------------------------------------------------
// I/O helper functions
// ---------------------------------------------------------------------------

function resolveAgentProbes(
  agent: string,
  hostHome: string,
): ClaudeProbes | CopilotProbes | CodexProbes {
  switch (agent) {
    case "claude":
      return resolveClaudeProbes(hostHome);
    case "copilot":
      return resolveCopilotProbes(hostHome);
    case "codex":
      return resolveCodexProbes(hostHome);
    default:
      throw new Error(`Unknown agent: ${agent}`);
  }
}

function expandHostPath(rawPath: string, hostHome: string): string {
  if (rawPath === "~") return hostHome;
  if (rawPath.startsWith("~/")) return path.join(hostHome, rawPath.slice(2));
  return rawPath;
}

export function resolveHostMountPath(
  rawPath: string,
  baseDir: string,
  hostHome: string,
): string {
  const expandedPath = expandHostPath(rawPath, hostHome);
  return path.normalize(
    path.isAbsolute(expandedPath)
      ? path.resolve(expandedPath)
      : path.resolve(baseDir, expandedPath),
  );
}

async function resolveExtraMounts(
  extraMounts: ExtraMountConfig[],
  workDir: string,
  hostHome: string,
): Promise<ResolvedExtraMount[]> {
  return await Promise.all(
    extraMounts.map(async (mount, index) => {
      const normalizedSrc = resolveHostMountPath(mount.src, workDir, hostHome);
      const srcExists = await fileExists(normalizedSrc);
      let srcIsDirectory = false;
      if (srcExists) {
        try {
          const s = await stat(normalizedSrc);
          srcIsDirectory = s.isDirectory();
        } catch {
          srcIsDirectory = false;
        }
      }
      return {
        normalizedSrc,
        srcExists,
        srcIsDirectory,
        mode: mount.mode,
        index,
      };
    }),
  );
}

async function resolveEnvEntries(
  envEntries: EnvConfig[],
): Promise<ResolvedEnvEntry[]> {
  const results: ResolvedEnvEntry[] = [];
  for (const [index, entry] of envEntries.entries()) {
    const key =
      "key" in entry
        ? entry.key
        : await runCommandForEnv(entry.keyCmd, `profile.env[${index}].key_cmd`);
    const keySource: "key" | "key_cmd" = "key" in entry ? "key" : "key_cmd";
    const value =
      "val" in entry
        ? entry.val
        : await runCommandForEnv(entry.valCmd, `profile.env[${index}].val_cmd`);
    if (entry.mode === "set") {
      results.push({ key, value, mode: "set", index, keySource });
    } else {
      if (entry.separator === undefined) {
        throw new Error(
          `profile.env[${index}]: separator is required when mode is "${entry.mode}"`,
        );
      }
      results.push({
        key,
        value,
        mode: entry.mode,
        separator: entry.separator,
        index,
        keySource,
      });
    }
  }
  return results;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRealPath(targetPath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["readlink", "-f", targetPath], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const resolved = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code === 0) {
      if (resolved) return resolved;
    }
  } catch {
    // readlink not available
  }
  return null;
}

async function resolveNixBinPath(): Promise<string | null> {
  // NixOS: /run/current-system/sw/bin/nix → /nix/store/.../bin/nix
  const resolved = await resolveRealPath("/run/current-system/sw/bin/nix");
  if (resolved?.startsWith("/nix/store/")) return resolved;

  // fallback: check common profile paths
  for (const p of [
    "/nix/var/nix/profiles/default/bin/nix",
    "/root/.nix-profile/bin/nix",
  ]) {
    if (await fileExists(p)) return p;
  }
  return null;
}

async function runCommandForEnv(
  command: string,
  sourceName: string,
): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `[nas] Failed to execute ${sourceName}: ${
        stderrText.trim() || `exit code ${code}`
      }`,
    );
  }

  const output = stdoutText.trim();
  if (!output) {
    throw new Error(`[nas] ${sourceName} returned empty output`);
  }
  return output;
}
