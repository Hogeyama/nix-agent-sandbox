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
import {
  type ContainerPatch,
  emptyContainerPlan,
  mergeContainerPlan,
} from "../pipeline/container_plan.ts";
import { encodeDynamicEnvOps } from "../pipeline/env_ops.ts";
import type { Stage } from "../pipeline/stage_builder.ts";
import type {
  ContainerPlan,
  DbusState,
  DynamicEnvOp,
  MountSpec,
  NixState,
  PipelineState,
  WorkspaceState,
} from "../pipeline/state.ts";
import type { StageInput, StageResult } from "../pipeline/types.ts";
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
  readonly containerPatch: ContainerPatch;
  readonly outputOverrides: Partial<StageResult>;
}

type MountStageState = Pick<
  PipelineState,
  "workspace" | "nix" | "dbus" | "container"
>;
type MountStageInput = StageInput & MountStageState;

// ---------------------------------------------------------------------------
// EffectStage factory
// ---------------------------------------------------------------------------

export function createMountStage(
  shared: StageInput,
  mountProbes: MountProbes,
): Stage<
  "workspace" | "nix" | "dbus" | "container",
  { container: ContainerPlan },
  MountSetupService,
  unknown
> {
  return {
    name: "MountStage",
    needs: ["workspace", "nix", "dbus", "container"],

    run(input) {
      const stageInput: MountStageInput = {
        ...shared,
        ...input,
      };
      const plan = planMount(stageInput, mountProbes);
      const workspace = resolveWorkspace(input);
      const container = mergeContainerPlan(
        resolveContainerBase(input, workspace),
        plan.containerPatch,
      );

      return Effect.gen(function* () {
        const mountSetupService = yield* MountSetupService;

        yield* mountSetupService.ensureDirectories(plan.directories);

        return {
          container,
          ...plan.outputOverrides,
        } satisfies { container: ContainerPlan };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Pure plan function
// ---------------------------------------------------------------------------

export function planMount(
  input: MountStageInput,
  probes: MountProbes,
): MountPlan {
  const { host, profile } = input;
  const workspace = resolveWorkspace(input);
  const dbus = resolveDbusRuntime(input);
  const directories: MountPlanDirectory[] = [];
  const args: string[] = [];
  const mounts: MountSpec[] = [];
  const extraRunArgs: string[] = [];
  const envVars: Record<string, string> = {};

  const containerUser = resolveContainerUser(host.user);
  const containerHome = `/home/${containerUser}`;
  envVars.NAS_USER = containerUser;
  envVars.NAS_HOME = containerHome;
  // NAS_LOG_LEVEL is set in initialPrior.envVars by cli.ts

  // ワークスペースマウント
  // git worktree 内の場合は本体リポジトリルートをマウントソースに広げる
  const baseMountSource = path.resolve(workspace.mountDir ?? workspace.workDir);
  const mountSource = probes.gitWorktreeMainRoot ?? baseMountSource;
  const containerWorkDir = path.resolve(workspace.workDir);
  addMount(args, mounts, mountSource, mountSource);
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
  if (dbus.enabled) {
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
  if (resolveNixEnabled(input) && profile.nix.mountSocket) {
    if (input.probes.hasHostNix) {
      addMount(args, mounts, "/nix", "/nix");

      // nix.conf の実体パス
      if (probes.nixConfRealPath) {
        if (!probes.nixConfRealPath.startsWith("/nix/")) {
          const containerNixConfPath = "/tmp/nas-host-nix.conf";
          addMount(
            args,
            mounts,
            probes.nixConfRealPath,
            containerNixConfPath,
            true,
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
      addMount(args, mounts, nasCacheDir, `${containerHome}/.cache/nas`);

      // ホストの ~/.cache/nix
      const hostNixCache = `${xdgCache}/nix`;
      directories.push({
        path: hostNixCache,
        mode: 0o755,
        removeOnTeardown: false,
      });
      addMount(args, mounts, hostNixCache, `${containerHome}/.cache/nix`);

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
    addMount(
      args,
      mounts,
      `${host.home}/.config/git`,
      `${containerHome}/.config/git`,
      true,
    );
  }

  // gcloud 設定マウント
  if (profile.gcloud.mountConfig && probes.gcloudConfigExists) {
    addMount(
      args,
      mounts,
      `${host.home}/.config/gcloud`,
      `${containerHome}/.config/gcloud`,
    );
  }

  // GPG ソケットマウント
  if (profile.gpg.forwardAgent) {
    const gpgSocketPath = input.probes.gpgAgentSocket;
    if (gpgSocketPath && probes.gpgSocketExists) {
      addMount(
        args,
        mounts,
        gpgSocketPath,
        `${containerHome}/.gnupg/S.gpg-agent`,
      );
      envVars.GPG_AGENT_INFO = `${containerHome}/.gnupg/S.gpg-agent`;
    }
    if (probes.gpgConfExists) {
      addMount(
        args,
        mounts,
        `${host.home}/.gnupg/gpg.conf`,
        `${containerHome}/.gnupg/gpg.conf`,
        true,
      );
    }
    if (probes.gpgAgentConfExists) {
      addMount(
        args,
        mounts,
        `${host.home}/.gnupg/gpg-agent.conf`,
        `${containerHome}/.gnupg/gpg-agent.conf`,
        true,
      );
    }
    if (probes.gpgPubringExists) {
      addMount(
        args,
        mounts,
        `${host.home}/.gnupg/pubring.kbx`,
        `${containerHome}/.gnupg/pubring.kbx`,
        true,
      );
    }
    if (probes.gpgTrustdbExists) {
      addMount(
        args,
        mounts,
        `${host.home}/.gnupg/trustdb.gpg`,
        `${containerHome}/.gnupg/trustdb.gpg`,
        true,
      );
    }
  }

  // AWS 設定マウント
  if (profile.aws.mountConfig && probes.awsConfigExists) {
    addMount(args, mounts, `${host.home}/.aws`, `${containerHome}/.aws`);
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

    addMount(
      args,
      mounts,
      resolvedMount.normalizedSrc,
      normalizedDst,
      resolvedMount.mode === "ro",
    );
  }

  // プロファイルの環境変数
  const dynamicEnvOps: DynamicEnvOp[] = [];

  // Merge prior envVars for prefix/suffix resolution
  const mergedEnvVars = { ...resolvePriorEnvVars(input), ...envVars };

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
  if (dbus.enabled) {
    if (uid === null || !dbus.runtimeDir) {
      throw new Error(
        "[nas] dbus.session.enable requires an initialized DBus proxy runtime",
      );
    }
    const containerRuntimeDir = `/run/user/${uid}`;
    addMount(args, mounts, dbus.runtimeDir, containerRuntimeDir);
    envVars.XDG_RUNTIME_DIR = containerRuntimeDir;
    envVars.DBUS_SESSION_BUS_ADDRESS = `unix:path=${containerRuntimeDir}/bus`;
  }

  // X11 ディスプレイ転送
  if (profile.display.enable) {
    const hostDisplay = host.env.get("DISPLAY");
    if (hostDisplay) {
      if (probes.x11SocketDirExists) {
        addMount(args, mounts, "/tmp/.X11-unix", "/tmp/.X11-unix", true);
        envVars.DISPLAY = hostDisplay;

        // Xauthority
        if (probes.xauthorityExists) {
          const containerXauthority = `${containerHome}/.Xauthority`;
          addMount(
            args,
            mounts,
            probes.xauthorityPath,
            containerXauthority,
            true,
          );
          envVars.XAUTHORITY = containerXauthority;
        }

        addRunArgs(args, extraRunArgs, "--shm-size", "2g");
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
  const priorDockerArgs = [...args];
  const priorEnvVars = { ...resolvePriorEnvVars(input), ...envVars };
  let agentCommand: readonly string[] = resolvePriorAgentCommand(input);

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
    appendStructuredArgs(agentArgs, mounts, extraRunArgs);
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

  const staticEnvVars = { ...envVars };
  delete staticEnvVars.NAS_ENV_OPS;

  return {
    directories,
    dockerArgs: args,
    envVars,
    containerPatch: {
      workDir: containerWorkDir,
      mounts,
      env: {
        static: staticEnvVars,
        dynamicOps: dynamicEnvOps,
      },
      extraRunArgs,
      command: {
        agentCommand,
        extraArgs: resolvePriorCommandExtraArgs(input),
      },
    },
    outputOverrides: {},
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

function resolveWorkspace(input: {
  workspace: WorkspaceState;
}): WorkspaceState {
  return input.workspace;
}

function resolveNixEnabled(input: { nix: NixState }): boolean {
  return input.nix.enabled;
}

function resolveDbusRuntime(input: { dbus: DbusState }): {
  readonly enabled: boolean;
  readonly runtimeDir?: string;
} {
  const dbus = input.dbus;
  return dbus.enabled
    ? { enabled: true, runtimeDir: dbus.runtimeDir }
    : { enabled: false };
}

function resolvePriorEnvVars(input: {
  container: ContainerPlan;
}): Readonly<Record<string, string>> {
  return input.container.env.static;
}

function resolvePriorAgentCommand(input: {
  container: ContainerPlan;
}): readonly string[] {
  return input.container.command.agentCommand;
}

function resolvePriorCommandExtraArgs(input: {
  container: ContainerPlan;
}): readonly string[] {
  return input.container.command.extraArgs;
}

function resolveContainerBase(
  input: { container: ContainerPlan },
  _workspace: WorkspaceState,
): ContainerPlan {
  return input.container;
}

function addMount(
  dockerArgs: string[],
  mounts: MountSpec[],
  source: string,
  target: string,
  readOnly = false,
): void {
  const suffix = readOnly ? ":ro" : "";
  dockerArgs.push("-v", `${source}:${target}${suffix}`);
  mounts.push(
    readOnly ? { source, target, readOnly: true } : { source, target },
  );
}

function addRunArgs(
  dockerArgs: string[],
  extraRunArgs: string[],
  ...values: string[]
): void {
  dockerArgs.push(...values);
  extraRunArgs.push(...values);
}

function appendStructuredArgs(
  dockerArgs: readonly string[],
  mounts: MountSpec[],
  extraRunArgs: string[],
): void {
  for (let i = 0; i < dockerArgs.length; i++) {
    const arg = dockerArgs[i];
    if (arg === "-v" && i + 1 < dockerArgs.length) {
      const mount = parseMountSpec(dockerArgs[i + 1]);
      mounts.push(mount);
      i += 1;
      continue;
    }
    extraRunArgs.push(arg);
  }
}

function parseMountSpec(rawMount: string): MountSpec {
  const readOnly = rawMount.endsWith(":ro");
  const mountValue = readOnly ? rawMount.slice(0, -3) : rawMount;
  const separatorIndex = mountValue.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`[nas] Invalid mount arg: ${rawMount}`);
  }
  const source = mountValue.slice(0, separatorIndex);
  const target = mountValue.slice(separatorIndex + 1);
  return readOnly ? { source, target, readOnly: true } : { source, target };
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
