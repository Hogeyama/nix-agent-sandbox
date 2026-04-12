/** Handle returned by executeEffect for teardown */
export interface ResourceHandle {
  kind: string;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Readiness checks
// ---------------------------------------------------------------------------

import type { AgentType, HostExecConfig } from "../../config/types.ts";
import type { HostExecRuntimePaths } from "../../hostexec/registry.ts";
import type { ResolvedNotifyBackend } from "../../lib/notify_utils.ts";
import type { ApprovalScope } from "../../network/protocol.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";

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
