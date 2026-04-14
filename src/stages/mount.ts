/**
 * マウント構成の組み立てステージ (EffectStage<MountSetupService>)
 *
 * resolveMountProbes() で全ての I/O を事前解決し、
 * planMount() は純粋関数として MountPlan を返す。
 * run() は MountSetupService を使ってディレクトリ作成等を実行する。
 */

import * as path from "node:path";
import { Effect } from "effect";
import type { ClaudeProbes } from "../agents/claude.ts";
import { configureClaude } from "../agents/claude.ts";
import type { CodexProbes } from "../agents/codex.ts";
import { configureCodex } from "../agents/codex.ts";
import type { CopilotProbes } from "../agents/copilot.ts";
import { configureCopilot } from "../agents/copilot.ts";
import { logWarn } from "../log.ts";
import type {
  EffectStage,
  EffectStageResult,
  StageInput,
} from "../pipeline/types.ts";
import { MountSetupService } from "../services/mount_setup.ts";
import type { MountProbes } from "./mount_probes.ts";

export type {
  MountProbes,
  ResolvedEnvEntry,
  ResolvedExtraMount,
} from "./mount_probes.ts";
// Re-export probe types and resolver for backward compatibility
export { resolveMountProbes } from "./mount_probes.ts";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shell-safe single-quoting (escape embedded single quotes) */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
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
  return ops
    .map((op) => {
      const fn = op.mode === "prefix" ? "__nas_pfx" : "__nas_sfx";
      return `${fn} ${shellQuote(op.key)} ${shellQuote(op.value)} ${shellQuote(
        op.separator,
      )}`;
    })
    .join("\n");
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
// MountPlan — pure data description returned by planMount()
// ---------------------------------------------------------------------------

export interface MountPlanDirectory {
  readonly path: string;
  readonly mode: number;
  readonly removeOnTeardown: boolean;
}

export interface MountPlan {
  readonly directories: readonly MountPlanDirectory[];
  readonly dockerArgs: readonly string[];
  readonly envVars: Readonly<Record<string, string>>;
  readonly outputOverrides: Partial<EffectStageResult>;
}

// ---------------------------------------------------------------------------
// EffectStage factory
// ---------------------------------------------------------------------------

export function createMountStage(
  mountProbes: MountProbes,
): EffectStage<MountSetupService> {
  return {
    kind: "effect",
    name: "MountStage",

    run(input: StageInput) {
      const plan = planMount(input, mountProbes);

      return Effect.gen(function* () {
        const mountSetupService = yield* MountSetupService;

        yield* mountSetupService.ensureDirectories(plan.directories);

        return {
          dockerArgs: [...input.prior.dockerArgs, ...plan.dockerArgs],
          envVars: { ...input.prior.envVars, ...plan.envVars },
          ...plan.outputOverrides,
        } satisfies EffectStageResult;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Pure plan function
// ---------------------------------------------------------------------------

export function planMount(input: StageInput, probes: MountProbes): MountPlan {
  const { host, profile, prior } = input;
  const directories: MountPlanDirectory[] = [];
  const args: string[] = [];
  const envVars: Record<string, string> = {};

  const containerUser = resolveContainerUser(host.user);
  const containerHome = `/home/${containerUser}`;
  envVars.NAS_USER = containerUser;
  envVars.NAS_HOME = containerHome;
  // NAS_LOG_LEVEL is set in initialPrior.envVars by cli.ts

  // ワークスペースマウント
  // git worktree 内の場合は本体リポジトリルートをマウントソースに広げる
  const baseMountSource = path.resolve(prior.mountDir ?? prior.workDir);
  const mountSource = probes.gitWorktreeMainRoot ?? baseMountSource;
  const containerWorkDir = path.resolve(prior.workDir);
  args.push("-v", `${mountSource}:${mountSource}`);
  args.push("-w", containerWorkDir);
  envVars.WORKSPACE = containerWorkDir;

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
    envVars.NAS_UID = String(uid);
    envVars.NAS_GID = String(gid);
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
          envVars.NIX_CONF_PATH = containerNixConfPath;
        } else {
          envVars.NIX_CONF_PATH = probes.nixConfRealPath;
        }
      }
      envVars.NIX_REMOTE = "daemon";
      envVars.NIX_ENABLED = "true";

      // nix print-dev-env キャッシュ用ディレクトリ
      const xdgCache = host.env.get("XDG_CACHE_HOME") || `${host.home}/.cache`;
      const nasCacheDir = `${xdgCache}/nas`;
      directories.push({
        path: nasCacheDir,
        mode: 0o755,
        removeOnTeardown: false,
      });
      args.push("-v", `${nasCacheDir}:${containerHome}/.cache/nas`);

      // ホストの ~/.cache/nix
      const hostNixCache = `${xdgCache}/nix`;
      directories.push({
        path: hostNixCache,
        mode: 0o755,
        removeOnTeardown: false,
      });
      args.push("-v", `${hostNixCache}:${containerHome}/.cache/nix`);

      const nixExtraPackages = serializeNixExtraPackages(
        profile.nix.extraPackages,
      );
      if (nixExtraPackages) {
        envVars.NIX_EXTRA_PACKAGES = nixExtraPackages;
      }

      // nix バイナリの実体パス
      if (probes.nixBinPath) {
        envVars.NIX_BIN_PATH = probes.nixBinPath;
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
      envVars.GPG_AGENT_INFO = `${containerHome}/.gnupg/S.gpg-agent`;
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
            separator: resolved.separator,
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
            separator: resolved.separator,
          });
        }
        break;
      default: {
        // "set"
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
    envVars.NAS_ENV_OPS = encodeDynamicEnvOps(dynamicEnvOps);
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
    envVars.XDG_RUNTIME_DIR = containerRuntimeDir;
    envVars.DBUS_SESSION_BUS_ADDRESS = `unix:path=${containerRuntimeDir}/bus`;
  }

  // X11 ディスプレイ転送
  if (profile.display.enable) {
    const hostDisplay = host.env.get("DISPLAY");
    if (hostDisplay) {
      if (probes.x11SocketDirExists) {
        args.push("-v", "/tmp/.X11-unix:/tmp/.X11-unix:ro");
        envVars.DISPLAY = hostDisplay;

        // Xauthority
        if (probes.xauthorityExists) {
          const containerXauthority = `${containerHome}/.Xauthority`;
          args.push("-v", `${probes.xauthorityPath}:${containerXauthority}:ro`);
          envVars.XAUTHORITY = containerXauthority;
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
      applyAgentResult(
        configureClaude({
          containerHome,
          hostHome: host.home,
          probes: probes.agentProbes as ClaudeProbes,
          priorDockerArgs,
          priorEnvVars,
        }),
      );
      break;
    case "copilot":
      applyAgentResult(
        configureCopilot({
          containerHome,
          hostHome: host.home,
          probes: probes.agentProbes as CopilotProbes,
          priorDockerArgs,
          priorEnvVars,
        }),
      );
      break;
    case "codex":
      applyAgentResult(
        configureCodex({
          containerHome,
          hostHome: host.home,
          probes: probes.agentProbes as CodexProbes,
          priorDockerArgs,
          priorEnvVars,
        }),
      );
      break;
  }

  return {
    directories,
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
  return (
    relative !== "" &&
    relative !== "." &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export function serializeNixExtraPackages(packages: string[]): string | null {
  const normalized = packages
    .map((pkg) => pkg.trim())
    .filter((pkg) => pkg.length > 0);
  if (normalized.length === 0) return null;
  return normalized.join("\n");
}
