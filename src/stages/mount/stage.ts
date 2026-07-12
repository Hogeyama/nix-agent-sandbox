/**
 * マウント構成の組み立てステージ
 *
 * resolveMountProbes() で全ての I/O を事前解決し、
 * planMount() は純粋関数として MountPlan を返す。
 * run() は MountSetupService を使ってディレクトリ作成等を実行する。
 */

import * as path from "node:path";
import { Effect } from "effect";
import { configureAgent } from "../../agents/registry.ts";
import { expandTilde } from "../../lib/fs_utils.ts";
import { logWarn } from "../../log.ts";
import {
  type ContainerPatch,
  mergeContainerPlan,
} from "../../pipeline/container_plan.ts";
import { encodeDynamicEnvOps } from "../../pipeline/env_ops.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type {
  ContainerPlan,
  DbusState,
  DisplayState,
  DynamicEnvOp,
  MountSpec,
  NixState,
  PipelineState,
  WorkspaceState,
} from "../../pipeline/state.ts";
import type { StageInput, StageResult } from "../../pipeline/types.ts";
import type { MountProbes } from "./mount_probes.ts";
import { MountSetupService } from "./mount_setup_service.ts";

export type {
  MountProbes,
  ResolvedEnvEntry,
  ResolvedExtraMount,
} from "./mount_probes.ts";
// Re-export probe types and resolver for backward compatibility
export { resolveMountProbes } from "./mount_probes.ts";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const DEFAULT_CONTAINER_USER = "nas";

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
  "workspace" | "nix" | "dbus" | "display" | "container"
>;
type MountStageInput = StageInput & MountStageState;

// ---------------------------------------------------------------------------
// EffectStage factory
// ---------------------------------------------------------------------------

export function createMountStage(
  shared: StageInput,
  mountProbes: MountProbes,
): Stage<
  "workspace" | "nix" | "dbus" | "display" | "container",
  { container: ContainerPlan },
  MountSetupService,
  unknown
> {
  return {
    name: "MountStage",
    needs: ["workspace", "nix", "dbus", "display", "container"],

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

/**
 * MountStage がワークスペースのバインドソース/ターゲットに使う実パスを解決する。
 * MaskFsStage も同じパスをマスク対象のソースディレクトリとして使う。
 */
export function resolveWorkspaceMountSource(
  workspace: WorkspaceState,
  probes: MountProbes,
): string {
  const base = path.resolve(workspace.mountDir ?? workspace.workDir);
  return probes.gitWorktreeMainRoot ?? base;
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

  // Runtime ordering guard: MaskFsStage must run before MountStage when the
  // maskfs view is actually enabled. This must mirror MaskFsStage's skip
  // condition (see stages/maskfs/stage.ts): maskfs is skipped when mask is
  // absent, mask.maskfs is false (e.g. proxy-only masking), or there are no
  // values — in those cases maskedRoot is legitimately unset. The type system
  // cannot enforce ordering because maskedRoot is optional, so we assert here.
  if (
    profile.mask?.maskfs &&
    profile.mask.values.length &&
    !workspace.maskedRoot
  ) {
    throw new Error(
      "[nas] BUG: mask config is set but workspace.maskedRoot is not — MaskFsStage must run before MountStage",
    );
  }

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
  // maskfs 有効時はバインドソースだけマスク済みビューに差し替える
  // (コンテナ内パスは実パスのまま維持する)
  const mountSource = resolveWorkspaceMountSource(workspace, probes);
  const bindSource = workspace.maskedRoot ?? mountSource;
  const containerWorkDir = path.resolve(workspace.workDir);
  addMount(args, mounts, bindSource, mountSource);
  args.push("-w", containerWorkDir);
  envVars.WORKSPACE = containerWorkDir;

  // .nas/config.pkl を RO bind mount で保護する。
  // 親ディレクトリは RW マウントのため agent が個別ファイルを書き換え可能だが、
  // file bind mount の target は mount point 扱いとなり、
  // Linux では unlink/rename/open(O_WRONLY) 全てが EBUSY/EROFS で拒否される。
  // これにより次回起動時に nas が信頼して読み込む設定（特に hostexec.rules）の
  // 改ざんを防ぐ。
  // maskfs 有効時もソースは実パスのまま: config.pkl は mask.values に
  // リテラルを書けない設計のため秘密値を含まず、trust 済み実体を RO で
  // 見せることが改ざん防止として優先される。
  for (const configPath of probes.localConfigPaths) {
    if (isPathWithin(configPath, mountSource)) {
      addMount(args, mounts, configPath, configPath, true);
    }
  }

  // .git/hooks と .git/config を RO bind mount で保護する。
  // workspace は RW だが、これらだけ RO で上書きマウントすることで、
  // コンテナ内のエージェントが git hook を仕込んだり core.fsmonitor を
  // 設定する → ホストで git 操作時に実行される攻撃を防ぐ。
  if (probes.gitHooksDir && isPathWithin(probes.gitHooksDir, mountSource)) {
    addMount(args, mounts, probes.gitHooksDir, probes.gitHooksDir, true);
  }
  if (probes.gitConfigFile && isPathWithin(probes.gitConfigFile, mountSource)) {
    addMount(args, mounts, probes.gitConfigFile, probes.gitConfigFile, true);
  }

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
    const value = expandTilde(resolved.value, containerHome);
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

  // Display (xpra sandbox) マウント
  const display = resolveDisplayRuntime(input);
  if (display.enabled) {
    // xpra が spawn した Xvfb のソケットだけをマウント
    // (ホスト側 /tmp/.X11-unix 全体は渡さない)
    // unshare 方式ではソケットの実体が sessionDir 配下にあるため、
    // コンテナ内では /tmp/.X11-unix/X<N> にマウントし直す必要がある。
    const containerSocketPath = `/tmp/.X11-unix/X${display.displayNumber}`;
    addMount(args, mounts, display.socketPath, containerSocketPath, true);
    // per-session xauthority を ~/.Xauthority へ bind
    addMount(
      args,
      mounts,
      display.xauthorityPath,
      `${containerHome}/.Xauthority`,
      true,
    );
    envVars.DISPLAY = `:${display.displayNumber}`;
    envVars.XAUTHORITY = `${containerHome}/.Xauthority`;
    // playwright/chromium 等が /dev/shm を多用するため拡張
    extraRunArgs.push("--shm-size", "2g");
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

  applyAgentResult(
    configureAgent({
      agent: profile.agent,
      containerHome,
      hostHome: host.home,
      probes: probes.agentProbes,
      priorDockerArgs,
      priorEnvVars,
    }),
  );

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

function resolveContainerMountPath(
  rawPath: string,
  containerHome: string,
  containerWorkDir: string,
): string {
  // `~` / `~/...` は containerHome 配下に限定（`..` による脱出を拒否）。
  if (rawPath === "~" || rawPath.startsWith("~/")) {
    const expandedPath = expandTilde(rawPath, containerHome);
    const resolved = path.normalize(path.resolve(expandedPath));
    assertPathWithin(resolved, containerHome, rawPath, "containerHome");
    return resolved;
  }
  // 絶対パスはそのまま（既存挙動）。
  if (path.isAbsolute(rawPath)) {
    return path.normalize(path.resolve(rawPath));
  }
  // 相対パスは containerWorkDir 配下に限定（`..` による脱出を拒否）。
  const resolved = path.normalize(path.resolve(containerWorkDir, rawPath));
  assertPathWithin(resolved, containerWorkDir, rawPath, "containerWorkDir");
  return resolved;
}

function assertPathWithin(
  resolved: string,
  root: string,
  rawPath: string,
  rootLabel: string,
): void {
  const rel = path.relative(root, resolved);
  if (rel === "") return;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `[nas] extra-mounts.dst "${rawPath}" escapes ${rootLabel} (${root}); ` +
        `resolved to ${resolved}`,
    );
  }
}

function isPathWithin(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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

function resolveDisplayRuntime(input: { display: DisplayState }):
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly displayNumber: number;
      readonly socketPath: string;
      readonly xauthorityPath: string;
    } {
  const display = input.display;
  return display.enabled
    ? {
        enabled: true,
        displayNumber: display.displayNumber,
        socketPath: display.socketPath,
        xauthorityPath: display.xauthorityPath,
      }
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

export function serializeNixExtraPackages(packages: string[]): string | null {
  const normalized = packages
    .map((pkg) => pkg.trim())
    .filter((pkg) => pkg.length > 0);
  if (normalized.length === 0) return null;
  return normalized.join("\n");
}
