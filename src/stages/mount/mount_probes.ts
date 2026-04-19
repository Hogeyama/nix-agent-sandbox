/**
 * MountStage 用の I/O プローブ解決
 *
 * 全てのファイル存在チェック・コマンド実行・stat 呼び出しをここで行い、
 * plan() が純粋関数になるようにデータとして返す。
 */

import { readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ClaudeProbes } from "../../agents/claude.ts";
import { resolveClaudeProbes } from "../../agents/claude.ts";
import type { CodexProbes } from "../../agents/codex.ts";
import { resolveCodexProbes } from "../../agents/codex.ts";
import type { CopilotProbes } from "../../agents/copilot.ts";
import { resolveCopilotProbes } from "../../agents/copilot.ts";
import type {
  EnvConfig,
  ExtraMountConfig,
  Profile,
} from "../../config/types.ts";
import type { HostEnv } from "../../pipeline/types.ts";
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
  /** 追加マウントの事前解決結果 */
  resolvedExtraMounts: ResolvedExtraMount[];
  /** 環境変数エントリの事前解決結果 */
  resolvedEnvEntries: ResolvedEnvEntry[];
  /** ワークスペースが git worktree 内にある場合、本体リポジトリのルートパス */
  gitWorktreeMainRoot: string | null;
  /** xpra バイナリのパス (PATH 探索の結果)。見つからなければ null */
  xpraBinPath: string | null;
  /** /tmp/.X11-unix/X* で既に使用されている display 番号 */
  takenX11Displays: ReadonlySet<number>;
  /** /tmp/.X11-unix が read-only か (WSL 等で ro マウントされている場合 true) */
  x11UnixDirReadOnly: boolean;
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

  const [
    gitConfigExists,
    gcloudConfigExists,
    awsConfigExists,
    gpgConfExists,
    gpgAgentConfExists,
    gpgPubringExists,
    gpgTrustdbExists,
  ] = await Promise.all([
    fileExists(gitConfigDir),
    fileExists(gcloudConfigDir),
    fileExists(awsConfigDir),
    fileExists(gpgConf),
    fileExists(gpgAgentConf),
    fileExists(pubring),
    fileExists(trustdb),
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

  // git worktree 検出: ワークスペースが worktree 内にある場合、本体リポジトリルートを取得
  const gitWorktreeMainRoot = await resolveGitWorktreeMainRoot(workDir);

  // display: xpra サンドボックス用のバイナリ探索と X11 display 採番
  const [xpraBinPath, takenX11Displays, x11UnixDirReadOnly] = await Promise.all(
    [
      resolveBinaryPath("xpra"),
      resolveTakenX11Displays(),
      resolveX11UnixDirReadOnly(),
    ],
  );

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
    resolvedExtraMounts,
    resolvedEnvEntries,
    gitWorktreeMainRoot,
    xpraBinPath,
    takenX11Displays,
    x11UnixDirReadOnly,
  };
}

/** PATH から任意のバイナリを which 相当で解決する */
async function resolveBinaryPath(binary: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["which", binary], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code !== 0) return null;
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** /tmp/.X11-unix/X<N> を列挙して使用済みの display 番号集合を返す */
async function resolveTakenX11Displays(): Promise<ReadonlySet<number>> {
  const taken = new Set<number>();
  try {
    const entries = await readdir("/tmp/.X11-unix");
    for (const entry of entries) {
      const match = /^X(\d+)$/.exec(entry);
      if (match) {
        const n = Number.parseInt(match[1], 10);
        if (Number.isFinite(n)) {
          taken.add(n);
        }
      }
    }
  } catch {
    // /tmp/.X11-unix が無い環境 (Wayland のみ等) は空集合
  }
  return taken;
}

const X11_UNIX_DIR = "/tmp/.X11-unix";

/**
 * /tmp/.X11-unix が read-only かどうかを判定する。
 * WSL では /tmp/.X11-unix がカーネルにより ro マウントされているため、
 * Xvfb がソケットを作成できない。tmpfile 作成→即削除で判定する。
 */
async function resolveX11UnixDirReadOnly(): Promise<boolean> {
  const testFile = `${X11_UNIX_DIR}/.nas-probe-${process.pid}`;
  try {
    await writeFile(testFile, "");
    await unlink(testFile);
    return false;
  } catch {
    return true;
  }
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

/**
 * Resolve a user-supplied host mount path to its canonical host path.
 *
 * Performs tilde expansion and turns the path into an absolute, normalized
 * path. This is a purely logical transformation — symlinks are NOT followed
 * here. Callers that will hand the result to Docker as a bind-mount source
 * MUST additionally canonicalize via `fs.realpath` (see `resolveExtraMounts`)
 * so that a symlink inside the workspace cannot redirect the mount to an
 * unrelated host path.
 */
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
      const logicalSrc = resolveHostMountPath(mount.src, workDir, hostHome);
      // Canonicalize via realpath so that a symlink inside `src` cannot be
      // used to bind-mount an arbitrary host path (e.g. a committed
      // `evil-link -> /etc/passwd` in the workspace). Docker resolves
      // symlinks on the host at bind time, so the plan must reflect what
      // will actually be mounted. If realpath fails (e.g. ENOENT because
      // the target does not yet exist — which the downstream code tolerates
      // via `srcExists`), fall back to the logical path so the "skip
      // missing src" warning in MountStage still surfaces the user-written
      // location.
      let normalizedSrc = logicalSrc;
      let srcExists = false;
      try {
        normalizedSrc = await realpath(logicalSrc);
        srcExists = true;
      } catch {
        srcExists = false;
      }
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

/**
 * git worktree 内で実行されている場合、本体リポジトリのルートパスを返す。
 * 通常のリポジトリ (worktree でない) の場合は null を返す。
 *
 * --git-common-dir は共有 .git ディレクトリを返すので、その親が本体リポジトリルート。
 */
async function resolveGitWorktreeMainRoot(
  workDir: string,
): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["git", "-C", workDir, "rev-parse", "--git-common-dir", "--git-dir"],
      { stdout: "pipe", stderr: "ignore" },
    );

    const [output, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    if (code !== 0) return null;

    const [commonDirRaw, gitDirRaw] = output.trim().split("\n");
    const commonDir = path.resolve(workDir, commonDirRaw);
    const gitDir = path.resolve(workDir, gitDirRaw);

    // commonDir と gitDir が異なる場合は worktree 内にいる
    if (commonDir !== gitDir) {
      return path.dirname(commonDir);
    }
    return null;
  } catch {
    return null;
  }
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
