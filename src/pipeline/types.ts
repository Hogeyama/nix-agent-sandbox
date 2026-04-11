/**
 * 新 Stage アーキテクチャの型定義
 *
 * PlanStage: 純粋な plan() でデータ記述を返す（デフォルト）
 * ProceduralStage: 副作用を含む execute() を持つ（例外的）
 */

import type {
  AgentType,
  Config,
  HostExecConfig,
  Profile,
} from "../config/types.ts";
import type { ResolvedNotifyBackend } from "../lib/notify_utils.ts";
import type { ApprovalScope } from "../network/protocol.ts";
import type { NetworkRuntimePaths } from "../network/registry.ts";
import type { HostExecRuntimePaths } from "../hostexec/registry.ts";

// ---------------------------------------------------------------------------
// Host environment & probes
// ---------------------------------------------------------------------------

/** CLI 層が起動時に 1 回解決するホスト環境情報 */
export interface HostEnv {
  readonly home: string;
  readonly user: string;
  readonly uid: number | null;
  readonly gid: number | null;
  readonly isWSL: boolean;
  readonly env: ReadonlyMap<string, string>;
}

/** pipeline 開始時に並列解決される probe 結果 */
export interface ProbeResults {
  readonly hasHostNix: boolean;
  readonly xdgDbusProxyPath: string | null;
  readonly dbusSessionAddress: string | null;
  readonly gpgAgentSocket: string | null;
  readonly auditDir: string;
}

// ---------------------------------------------------------------------------
// Stage input & output
// ---------------------------------------------------------------------------

/** 各 stage に渡される不変の入力 */
export interface StageInput {
  readonly config: Config;
  readonly profile: Profile;
  readonly profileName: string;
  readonly sessionId: string;
  readonly host: HostEnv;
  readonly probes: ProbeResults;
  readonly prior: PriorStageOutputs;
}

/** stage 間で蓄積される出力 */
export interface PriorStageOutputs {
  readonly dockerArgs: readonly string[];
  readonly envVars: Readonly<Record<string, string>>;
  readonly workDir: string;
  readonly mountDir?: string;
  readonly nixEnabled: boolean;
  readonly imageName: string;
  readonly agentCommand: readonly string[];
  readonly dindContainerName?: string;
  readonly networkName?: string;
  readonly networkRuntimeDir?: string;
  readonly networkPromptToken?: string;
  readonly networkPromptEnabled: boolean;
  readonly networkBrokerSocket?: string;
  readonly networkProxyEndpoint?: string;
  readonly hostexecRuntimeDir?: string;
  readonly hostexecBrokerSocket?: string;
  readonly hostexecSessionTmpDir?: string;
  readonly dbusProxyEnabled: boolean;
  readonly dbusSessionRuntimeDir?: string;
  readonly dbusSessionSocket?: string;
  readonly dbusSessionSourceAddress?: string;
}

// ---------------------------------------------------------------------------
// Stage plan
// ---------------------------------------------------------------------------

/** PlanStage.plan() の返り値 */
export interface StagePlan {
  effects: ResourceEffect[];
  dockerArgs: string[];
  envVars: Record<string, string>;
  outputOverrides: Partial<PriorStageOutputs>;
}

/** ProceduralStage.execute() の返り値 */
export interface ProceduralResult {
  outputOverrides: Partial<PriorStageOutputs>;
}

// ---------------------------------------------------------------------------
// Readiness checks
// ---------------------------------------------------------------------------

export type ReadinessCheck =
  | { kind: "tcp-port"; host: string; port: number }
  | { kind: "http-ok"; url: string }
  | { kind: "docker-healthy"; container: string }
  | { kind: "file-exists"; path: string };

// ---------------------------------------------------------------------------
// Listener specs
// ---------------------------------------------------------------------------

export type ListenerSpec =
  | {
      kind: "session-broker";
      paths: NetworkRuntimePaths;
      sessionId: string;
      allowlist: string[];
      denylist: string[];
      promptEnabled: boolean;
    }
  | {
      kind: "hostexec-broker";
      paths: HostExecRuntimePaths;
      sessionId: string;
      profileName: string;
      workspaceRoot: string;
      sessionTmpDir: string;
      hostexec: HostExecConfig;
      notify: ResolvedNotifyBackend;
      uiEnabled: boolean;
      uiPort: number;
      uiIdleTimeout: number;
      auditDir: string;
      agent: AgentType;
    };

// ---------------------------------------------------------------------------
// Resource effects
// ---------------------------------------------------------------------------

export type ResourceEffect =
  | DockerContainerEffect
  | DockerNetworkEffect
  | DockerVolumeEffect
  | DirectoryCreateEffect
  | FileWriteEffect
  | SymlinkEffect
  | ProcessSpawnEffect
  | UnixListenerEffect
  | WaitForReadyEffect
  | DindSidecarEffect
  | DbusProxyEffect
  | DockerImageBuildEffect
  | DockerRunInteractiveEffect
  | ProxySessionEffect;

export interface DockerContainerEffect {
  kind: "docker-container";
  name: string;
  image: string;
  reuseIfRunning: boolean;
  keepOnTeardown: boolean;
  args: string[];
  envVars: Record<string, string>;
  labels: Record<string, string>;
}

export interface DockerNetworkEffect {
  kind: "docker-network";
  name: string;
  connect: { container: string; aliases?: string[] }[];
}

export interface DockerVolumeEffect {
  kind: "docker-volume";
  name: string;
}

export interface DirectoryCreateEffect {
  kind: "directory-create";
  path: string;
  mode: number;
  removeOnTeardown: boolean;
}

export interface FileWriteEffect {
  kind: "file-write";
  path: string;
  content: string;
  mode: number;
}

export interface SymlinkEffect {
  kind: "symlink";
  target: string;
  path: string;
}

export interface ProcessSpawnEffect {
  kind: "process-spawn";
  id: string;
  command: string;
  args: string[];
}

export interface UnixListenerEffect {
  kind: "unix-listener";
  id: string;
  socketPath: string;
  spec: ListenerSpec;
}

export interface WaitForReadyEffect {
  kind: "wait-for-ready";
  check: ReadinessCheck;
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface DindSidecarEffect {
  kind: "dind-sidecar";
  containerName: string;
  sharedTmpVolume: string;
  networkName: string;
  shared: boolean;
  disableCache: boolean;
  readinessTimeoutMs: number;
}

export interface DbusProxyEffect {
  kind: "dbus-proxy";
  proxyBinaryPath: string;
  runtimeDir: string;
  sessionsDir: string;
  sessionDir: string;
  socketPath: string;
  pidFile: string;
  sourceAddress: string;
  args: string[];
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface DockerImageBuildEffect {
  kind: "docker-image-build";
  imageName: string;
  /** Embedded asset groups to extract to a temp dir before building */
  assetGroups: readonly {
    baseDir: string;
    outputDir: string;
    files: readonly string[];
  }[];
  labels: Record<string, string>;
}

export interface DockerRunInteractiveEffect {
  kind: "docker-run-interactive";
  image: string;
  name: string;
  args: string[];
  envVars: Record<string, string>;
  command: string[];
  labels: Record<string, string>;
}

export interface ProxySessionEffect {
  kind: "proxy-session";
  envoyContainerName: string;
  envoyImage: string;
  envoyAlias: string;
  envoyProxyPort: number;
  envoyReadyTimeoutMs: number;
  sessionId: string;
  sessionNetworkName: string;
  profileName: string;
  agent: AgentType;
  runtimePaths: NetworkRuntimePaths;
  brokerSocket: string;
  token?: string;
  allowlist: string[];
  denylist: string[];
  promptEnabled: boolean;
  timeoutSeconds: number;
  defaultScope: ApprovalScope;
  notify: ResolvedNotifyBackend;
  uiEnabled: boolean;
  uiPort: number;
  uiIdleTimeout: number;
  auditDir: string;
  dindContainerName: string | null;
}

// ---------------------------------------------------------------------------
// Stage interfaces
// ---------------------------------------------------------------------------

/** 純粋な plan() でデータ記述を返す stage（デフォルト） */
export interface PlanStage {
  kind: "plan";
  name: string;
  plan(input: StageInput): StagePlan | null;
}

/** 副作用を含む execute() を持つ stage（例外的） */
export interface ProceduralStage {
  kind: "procedural";
  name: string;
  execute(input: StageInput): Promise<ProceduralResult>;
  teardown?(input: StageInput): Promise<void>;
}

/** すべての stage の union type */
export type AnyStage = PlanStage | ProceduralStage;
