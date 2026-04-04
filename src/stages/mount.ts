/**
 * マウント構成の組み立てステージ (PlanStage)
 *
 * resolveMountProbes() で全ての I/O を事前解決し、
 * plan() は純粋関数として dockerArgs/envVars/effects を返す。
 */

import * as path from "@std/path";
import type {
  DirectoryCreateEffect,
  HostEnv,
  PlanStage,
  ResourceEffect,
  StageInput,
  StagePlan,
} from "../pipeline/types.ts";
import type { EnvConfig, ExtraMountConfig, Profile } from "../config/types.ts";
import { logWarn } from "../log.ts";
import { configureClaude, resolveClaudeProbes } from "../agents/claude.ts";
import { configureCopilot, resolveCopilotProbes } from "../agents/copilot.ts";
import { configureCodex, resolveCodexProbes } from "../agents/codex.ts";
import type { ClaudeProbes } from "../agents/claude.ts";
import type { CopilotProbes } from "../agents/copilot.ts";
import type { CodexProbes } from "../agents/codex.ts";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shell-safe single-quoting (escape embedded single quotes) */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Encode prefix/suffix ops as shell commands for container-runtime evaluation */
export function encodeDynamicEnvOps(
  ops: ReadonlyArray<{
    mode: "prefix" | "suffix";
    key: string;
    value: string;
    separator: string;
  }>,
): string {
  return ops.map((op) => {
    const fn = op.mode === "prefix" ? "__nas_pfx" : "__nas_sfx";
    return `${fn} ${shellQuote(op.key)} ${shellQuote(op.value)} ${
      shellQuote(op.separator)
    }`;
  }).join("\n");
}

const DEFAULT_CONTAINER_USER = "nas";
const RESERVED_EXTRA_MOUNT_DESTINATIONS = ["/nix"] as const;

type MountDestinationKind = "file" | "directory";

interface RegisteredMountDestination {
  path: string;
  kind: MountDestinationKind;
  allowNestedFiles: boolean;
}

// ---------------------------------------------------------------------------
// MountProbes — pre-resolved I/O results
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
export interface ResolvedEnvEntry {
  /** 解決済みキー */
  key: string;
  /** 解決済み値 */
  value: string;
  /** モード */
  mode: "set" | "prefix" | "suffix";
  /** separator (prefix/suffix モード用) */
  separator?: string;
  /** 元の index (エラーメッセージ用) */
  index: number;
  /** key の出典 ("key" | "key_cmd") */
  keySource: "key" | "key_cmd";
}

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
          const stat = await Deno.stat(normalizedSrc);
          srcIsDirectory = stat.isDirectory;
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
    const key = "key" in entry ? entry.key : await runCommandForEnv(
      entry.keyCmd,
      `profile.env[${index}].key_cmd`,
    );
    const keySource: "key" | "key_cmd" = "key" in entry ? "key" : "key_cmd";
    const value = "val" in entry ? entry.val : await runCommandForEnv(
      entry.valCmd,
      `profile.env[${index}].val_cmd`,
    );
    results.push({
      key,
      value,
      mode: entry.mode,
      separator: entry.separator,
      index,
      keySource,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// PlanStage factory
// ---------------------------------------------------------------------------

/**
 * MountStage の PlanStage を作成する。
 *
 * mountProbes は cli.ts で事前解決された I/O 結果。
 * plan() は純粋関数。
 */
export function createMountStage(mountProbes: MountProbes): PlanStage {
  return {
    kind: "plan",
    name: "MountStage",

    plan(input: StageInput): StagePlan {
      return planMount(input, mountProbes);
    },
  };
}

// ---------------------------------------------------------------------------
// Pure plan function
// ---------------------------------------------------------------------------

function planMount(input: StageInput, probes: MountProbes): StagePlan {
  const { host, profile, prior } = input;
  const effects: ResourceEffect[] = [];
  const args: string[] = [];
  const envVars: Record<string, string> = {};

  const containerUser = resolveContainerUser(host.user);
  const containerHome = `/home/${containerUser}`;
  envVars["NAS_USER"] = containerUser;
  envVars["NAS_HOME"] = containerHome;
  // NAS_LOG_LEVEL is set in initialPrior.envVars by cli.ts

  // ワークスペースマウント
  const mountSource = path.resolve(prior.mountDir ?? prior.workDir);
  const containerWorkDir = path.resolve(prior.workDir);
  args.push("-v", `${mountSource}:${mountSource}`);
  args.push("-w", containerWorkDir);
  envVars["WORKSPACE"] = containerWorkDir;

  const extraMountDestinations: RegisteredMountDestination[] = [
    ...RESERVED_EXTRA_MOUNT_DESTINATIONS.map((reservedPath) => ({
      path: path.normalize(reservedPath),
      kind: "directory" as const,
      allowNestedFiles: false,
    })),
    {
      path: path.normalize(mountSource),
      kind: "directory",
      allowNestedFiles: true,
    },
  ];

  // UID/GID
  const uid = host.uid;
  const gid = host.gid;
  if (uid !== null && gid !== null) {
    envVars["NAS_UID"] = String(uid);
    envVars["NAS_GID"] = String(gid);
  }
  if (prior.dbusProxyEnabled) {
    if (uid === null) {
      throw new Error(
        "[nas] dbus.session.enable requires a host UID to mount /run/user/$UID",
      );
    }
    extraMountDestinations.push({
      path: path.normalize(`/run/user/${uid}`),
      kind: "directory",
      allowNestedFiles: false,
    });
  }

  // Nix ソケットマウント
  if (prior.nixEnabled && profile.nix.mountSocket) {
    if (input.probes.hasHostNix) {
      args.push("-v", "/nix:/nix");

      // nix.conf の実体パス
      if (probes.nixConfRealPath) {
        if (!probes.nixConfRealPath.startsWith("/nix/")) {
          const containerNixConfPath = "/tmp/nas-host-nix.conf";
          args.push(
            "-v",
            `${probes.nixConfRealPath}:${containerNixConfPath}:ro`,
          );
          envVars["NIX_CONF_PATH"] = containerNixConfPath;
        } else {
          envVars["NIX_CONF_PATH"] = probes.nixConfRealPath;
        }
      }
      envVars["NIX_REMOTE"] = "daemon";
      envVars["NIX_ENABLED"] = "true";

      // nix print-dev-env キャッシュ用ディレクトリ
      const xdgCache = host.env.get("XDG_CACHE_HOME") || `${host.home}/.cache`;
      const nasCacheDir = `${xdgCache}/nas`;
      effects.push(
        {
          kind: "directory-create",
          path: nasCacheDir,
          mode: 0o755,
          removeOnTeardown: false,
        } satisfies DirectoryCreateEffect,
      );
      args.push("-v", `${nasCacheDir}:${containerHome}/.cache/nas`);

      // ホストの ~/.cache/nix
      const hostNixCache = `${xdgCache}/nix`;
      effects.push(
        {
          kind: "directory-create",
          path: hostNixCache,
          mode: 0o755,
          removeOnTeardown: false,
        } satisfies DirectoryCreateEffect,
      );
      args.push("-v", `${hostNixCache}:${containerHome}/.cache/nix`);

      const nixExtraPackages = serializeNixExtraPackages(
        profile.nix.extraPackages,
      );
      if (nixExtraPackages) {
        envVars["NIX_EXTRA_PACKAGES"] = nixExtraPackages;
      }

      // nix バイナリの実体パス
      if (probes.nixBinPath) {
        envVars["NIX_BIN_PATH"] = probes.nixBinPath;
      }
    }
  }

  // git 設定マウント
  if (probes.gitConfigExists) {
    args.push("-v", `${host.home}/.config/git:${containerHome}/.config/git:ro`);
  }

  // gcloud 設定マウント
  if (profile.gcloud.mountConfig && probes.gcloudConfigExists) {
    args.push(
      "-v",
      `${host.home}/.config/gcloud:${containerHome}/.config/gcloud`,
    );
  }

  // GPG ソケットマウント
  if (profile.gpg.forwardAgent) {
    const gpgSocketPath = input.probes.gpgAgentSocket;
    if (gpgSocketPath && probes.gpgSocketExists) {
      args.push("-v", `${gpgSocketPath}:${containerHome}/.gnupg/S.gpg-agent`);
      envVars["GPG_AGENT_INFO"] = `${containerHome}/.gnupg/S.gpg-agent`;
    }
    if (probes.gpgConfExists) {
      args.push(
        "-v",
        `${host.home}/.gnupg/gpg.conf:${containerHome}/.gnupg/gpg.conf:ro`,
      );
    }
    if (probes.gpgAgentConfExists) {
      args.push(
        "-v",
        `${host.home}/.gnupg/gpg-agent.conf:${containerHome}/.gnupg/gpg-agent.conf:ro`,
      );
    }
    if (probes.gpgPubringExists) {
      args.push(
        "-v",
        `${host.home}/.gnupg/pubring.kbx:${containerHome}/.gnupg/pubring.kbx:ro`,
      );
    }
    if (probes.gpgTrustdbExists) {
      args.push(
        "-v",
        `${host.home}/.gnupg/trustdb.gpg:${containerHome}/.gnupg/trustdb.gpg:ro`,
      );
    }
  }

  // AWS 設定マウント
  if (profile.aws.mountConfig && probes.awsConfigExists) {
    args.push("-v", `${host.home}/.aws:${containerHome}/.aws`);
  }

  // 追加マウント
  for (const resolvedMount of probes.resolvedExtraMounts) {
    if (!resolvedMount.srcExists) {
      logWarn(
        `[nas] Skipping profile.extra-mounts[${resolvedMount.index}] because src does not exist: ${resolvedMount.normalizedSrc}`,
      );
      continue;
    }

    const normalizedDst = resolveContainerMountPath(
      profile.extraMounts[resolvedMount.index].dst,
      containerHome,
      containerWorkDir,
    );

    const conflict = findConflictingMountDestination(
      extraMountDestinations,
      normalizedDst,
      resolvedMount.srcIsDirectory ? "directory" : "file",
    );
    if (conflict) {
      throw new Error(
        `[nas] profile.extra-mounts[${resolvedMount.index}].dst conflicts with existing mount destination: ${normalizedDst}`,
      );
    }
    extraMountDestinations.push({
      path: normalizedDst,
      kind: resolvedMount.srcIsDirectory ? "directory" : "file",
      allowNestedFiles: false,
    });

    const modeSuffix = resolvedMount.mode === "ro" ? ":ro" : "";
    args.push(
      "-v",
      `${resolvedMount.normalizedSrc}:${normalizedDst}${modeSuffix}`,
    );
  }

  // プロファイルの環境変数
  const dynamicEnvOps: Array<{
    mode: "prefix" | "suffix";
    key: string;
    value: string;
    separator: string;
  }> = [];

  // Merge prior envVars for prefix/suffix resolution
  const mergedEnvVars = { ...input.prior.envVars, ...envVars };

  for (const resolved of probes.resolvedEnvEntries) {
    if (!ENV_VAR_NAME_RE.test(resolved.key)) {
      throw new Error(
        `[nas] Invalid env var name from profile.env[${resolved.index}].${resolved.keySource}: ${resolved.key}`,
      );
    }
    const value = expandContainerPath(resolved.value, containerHome);
    switch (resolved.mode) {
      case "prefix":
        if (resolved.key in mergedEnvVars) {
          envVars[resolved.key] = `${value}${resolved.separator}${
            mergedEnvVars[resolved.key]
          }`;
          mergedEnvVars[resolved.key] = envVars[resolved.key];
        } else {
          dynamicEnvOps.push({
            mode: "prefix",
            key: resolved.key,
            value,
            separator: resolved.separator!,
          });
        }
        break;
      case "suffix":
        if (resolved.key in mergedEnvVars) {
          envVars[resolved.key] = `${
            mergedEnvVars[resolved.key]
          }${resolved.separator}${value}`;
          mergedEnvVars[resolved.key] = envVars[resolved.key];
        } else {
          dynamicEnvOps.push({
            mode: "suffix",
            key: resolved.key,
            value,
            separator: resolved.separator!,
          });
        }
        break;
      default: { // "set"
        envVars[resolved.key] = value;
        mergedEnvVars[resolved.key] = value;
        // set はそれ以前の dynamic ops を上書きする
        for (let i = dynamicEnvOps.length - 1; i >= 0; i--) {
          if (dynamicEnvOps[i].key === resolved.key) {
            dynamicEnvOps.splice(i, 1);
          }
        }
        break;
      }
    }
  }

  if (dynamicEnvOps.length > 0) {
    envVars["NAS_ENV_OPS"] = encodeDynamicEnvOps(dynamicEnvOps);
  }

  // DBus proxy runtime マウント
  if (prior.dbusProxyEnabled) {
    if (uid === null || !prior.dbusSessionRuntimeDir) {
      throw new Error(
        "[nas] dbus.session.enable requires an initialized DBus proxy runtime",
      );
    }
    const containerRuntimeDir = `/run/user/${uid}`;
    args.push("-v", `${prior.dbusSessionRuntimeDir}:${containerRuntimeDir}`);
    envVars["XDG_RUNTIME_DIR"] = containerRuntimeDir;
    envVars["DBUS_SESSION_BUS_ADDRESS"] =
      `unix:path=${containerRuntimeDir}/bus`;
  }

  // X11 ディスプレイ転送
  if (profile.display.enable) {
    const hostDisplay = host.env.get("DISPLAY");
    if (hostDisplay) {
      if (probes.x11SocketDirExists) {
        args.push("-v", "/tmp/.X11-unix:/tmp/.X11-unix:ro");
        envVars["DISPLAY"] = hostDisplay;

        // Xauthority
        if (probes.xauthorityExists) {
          const containerXauthority = `${containerHome}/.Xauthority`;
          args.push(
            "-v",
            `${probes.xauthorityPath}:${containerXauthority}:ro`,
          );
          envVars["XAUTHORITY"] = containerXauthority;
        }

        args.push("--shm-size", "2g");
      } else {
        logWarn(
          "[nas] display.enable is true but /tmp/.X11-unix not found; skipping X11 forwarding",
        );
      }
    } else {
      logWarn(
        "[nas] display.enable is true but DISPLAY is not set on host; skipping X11 forwarding",
      );
    }
  }

  // tmux 検出
  const hostTmux = host.env.get("TMUX");
  if (hostTmux) {
    envVars["NAS_HOST_TMUX"] = "1";
  }

  // エージェント固有の設定
  // Build priorDockerArgs and priorEnvVars by combining prior + current stage's args
  const priorDockerArgs = [...prior.dockerArgs, ...args];
  const priorEnvVars = { ...prior.envVars, ...envVars };
  let agentCommand: readonly string[] = prior.agentCommand;

  const applyAgentResult = (agentResult: {
    dockerArgs: string[];
    envVars: Record<string, string>;
    agentCommand: string[];
  }) => {
    const agentArgs = agentResult.dockerArgs.slice(priorDockerArgs.length);
    const agentEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(agentResult.envVars)) {
      if (priorEnvVars[k] !== v) {
        agentEnv[k] = v;
      }
    }
    args.push(...agentArgs);
    Object.assign(envVars, agentEnv);
    agentCommand = agentResult.agentCommand;
  };

  switch (profile.agent) {
    case "claude":
      applyAgentResult(configureClaude({
        containerHome,
        hostHome: host.home,
        probes: probes.agentProbes as ClaudeProbes,
        priorDockerArgs,
        priorEnvVars,
      }));
      break;
    case "copilot":
      applyAgentResult(configureCopilot({
        containerHome,
        hostHome: host.home,
        probes: probes.agentProbes as CopilotProbes,
        priorDockerArgs,
        priorEnvVars,
      }));
      break;
    case "codex":
      applyAgentResult(configureCodex({
        containerHome,
        hostHome: host.home,
        probes: probes.agentProbes as CodexProbes,
        priorDockerArgs,
        priorEnvVars,
      }));
      break;
  }

  return {
    effects,
    dockerArgs: args,
    envVars,
    outputOverrides: { agentCommand },
  };
}

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

function expandContainerPath(rawPath: string, containerHome: string): string {
  if (rawPath === "~") return containerHome;
  if (rawPath.startsWith("~/")) {
    return path.join(containerHome, rawPath.slice(2));
  }
  return rawPath;
}

function expandHostPath(rawPath: string, hostHome: string): string {
  if (rawPath === "~") return hostHome;
  if (rawPath.startsWith("~/")) return path.join(hostHome, rawPath.slice(2));
  return rawPath;
}

function resolveHostMountPath(
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

function resolveContainerMountPath(
  rawPath: string,
  containerHome: string,
  containerWorkDir: string,
): string {
  const expandedPath = expandContainerPath(rawPath, containerHome);
  return path.normalize(
    path.isAbsolute(expandedPath)
      ? path.resolve(expandedPath)
      : path.resolve(containerWorkDir, expandedPath),
  );
}

function resolveContainerUser(hostUser: string): string {
  const user = hostUser.trim();
  if (user) return user;
  return DEFAULT_CONTAINER_USER;
}

function findConflictingMountDestination(
  existingDestinations: RegisteredMountDestination[],
  candidatePath: string,
  candidateKind: MountDestinationKind,
): RegisteredMountDestination | null {
  for (const existing of existingDestinations) {
    if (existing.path === candidatePath) {
      return existing;
    }
    if (isParentPath(existing.path, candidatePath)) {
      if (!(existing.allowNestedFiles && candidateKind === "file")) {
        return existing;
      }
    }
    if (isParentPath(candidatePath, existing.path)) {
      return existing;
    }
  }
  return null;
}

function isParentPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative !== "" && relative !== "." && !relative.startsWith("..") &&
    !path.isAbsolute(relative);
}

export function serializeNixExtraPackages(packages: string[]): string | null {
  const normalized = packages
    .map((pkg) => pkg.trim())
    .filter((pkg) => pkg.length > 0);
  if (normalized.length === 0) return null;
  return normalized.join("\n");
}

// ---------------------------------------------------------------------------
// I/O helpers (used only by resolveMountProbes)
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await Deno.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRealPath(targetPath: string): Promise<string | null> {
  try {
    const cmd = new Deno.Command("readlink", {
      args: ["-f", targetPath],
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const resolved = new TextDecoder().decode(stdout).trim();
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
  for (
    const p of [
      "/nix/var/nix/profiles/default/bin/nix",
      "/root/.nix-profile/bin/nix",
    ]
  ) {
    if (await fileExists(p)) return p;
  }
  return null;
}

async function runCommandForEnv(
  command: string,
  sourceName: string,
): Promise<string> {
  const cmd = new Deno.Command("sh", {
    args: ["-c", command],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const stderrText = new TextDecoder().decode(stderr).trim();
    throw new Error(
      `[nas] Failed to execute ${sourceName}: ${
        stderrText || `exit code ${code}`
      }`,
    );
  }

  const output = new TextDecoder().decode(stdout).trim();
  if (!output) {
    throw new Error(`[nas] ${sourceName} returned empty output`);
  }
  return output;
}
