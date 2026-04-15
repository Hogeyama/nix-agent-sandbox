/**
 * PipelineState — domain-slice based pipeline state types.
 *
 * This module defines the per-domain slice types and the PipelineState
 * aggregate.  It is pure type scaffolding with no runtime behaviour.
 *
 * Companion pure helpers (ContainerPatch, mergeContainerPlan) are added in C2.
 * The runner that consumes PipelineState is wired in C11.
 */

// ---------------------------------------------------------------------------
// Slice types
// ---------------------------------------------------------------------------

/** Workspace paths resolved by the worktree stage. */
export interface WorkspaceState {
  readonly workDir: string;
  readonly mountDir?: string;
  readonly imageName: string;
}

/** Stable session identity provided by the session-store stage. */
export interface SessionState {
  readonly sessionId: string;
  readonly sessionName?: string;
}

/** Nix availability detected by the nix-detect stage. */
export interface NixState {
  readonly enabled: boolean;
}

/**
 * D-Bus proxy state.  Uses a discriminated union so that `enabled: true`
 * without path data is a type error.
 */
export type DbusState =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly runtimeDir: string;
      readonly socket: string;
      readonly sourceAddress: string;
    };

/** Host-exec broker paths resolved by the hostexec stage. */
export interface HostExecState {
  readonly runtimeDir: string;
  readonly brokerSocket: string;
  readonly sessionTmpDir: string;
}

/** Docker-in-Docker sidecar identity. */
export interface DindState {
  readonly containerName: string;
}

/** Network runtime identity (name + ephemeral runtime directory). */
export interface NetworkState {
  readonly networkName: string;
  readonly runtimeDir: string;
}

/** Prompt-service token issued for the network session. */
export interface PromptState {
  readonly promptToken: string;
  readonly promptEnabled: boolean;
}

/** Session-broker / auth-router endpoints. */
export interface ProxyState {
  readonly brokerSocket: string;
  readonly proxyEndpoint: string;
}

// ---------------------------------------------------------------------------
// ContainerPlan slice
//
// Full shape is defined here in C1.  ContainerPatch + mergeContainerPlan are
// added in C2.  LaunchStage is the sole compiler of ContainerPlan → LaunchOpts.
// ---------------------------------------------------------------------------

/** A single bind-mount specification.
 *
 * `kind` is intentionally absent: production only uses bind mounts and adding
 * `kind` would allow a silent encoding fallback bug (volume treated as bind).
 * Re-introduce with a matching encoder if named volumes are ever needed.
 */
export interface MountSpec {
  readonly source: string;
  readonly target: string;
  /** `true` to mount read-only (camelCase avoids clash with TS keyword). */
  readonly readOnly?: boolean;
}

/** Static env vars plus ordered dynamic ops for PATH-style patching. */
export interface EnvPlan {
  readonly static: Readonly<Record<string, string>>;
  readonly dynamicOps: readonly DynamicEnvOp[];
}

/** A single prefix/suffix operation applied to an env-var value at launch. */
export interface DynamicEnvOp {
  readonly mode: "prefix" | "suffix";
  readonly key: string;
  readonly value: string;
  readonly separator: string;
}

/** Container network attachment (name + optional DNS alias). */
export interface NetworkAttachment {
  readonly name: string;
  readonly alias?: string;
}

/** Agent command with optional extra args. */
export interface CommandSpec {
  readonly agentCommand: readonly string[];
  readonly extraArgs: readonly string[];
}

/**
 * Declarative description of the container to launch.
 *
 * LaunchStage compiles this into LaunchOpts (the Docker CLI encoding).
 * No stage other than LaunchStage should produce DockerArgs directly.
 */
export interface ContainerPlan {
  readonly image: string;
  readonly workDir: string;
  readonly mounts: readonly MountSpec[];
  readonly env: EnvPlan;
  readonly network?: NetworkAttachment;
  readonly extraRunArgs: readonly string[];
  readonly command: CommandSpec;
  readonly labels: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// PipelineState aggregate
// ---------------------------------------------------------------------------

/**
 * The full slice-based pipeline state.
 *
 * Each field is a domain slice populated by a dedicated stage.  No field
 * holds raw Docker CLI encoding — that is the responsibility of LaunchStage.
 */
export interface PipelineState {
  readonly workspace: WorkspaceState;
  readonly session: SessionState;
  readonly nix: NixState;
  readonly dbus: DbusState;
  readonly hostexec: HostExecState;
  readonly dind: DindState;
  readonly network: NetworkState;
  readonly prompt: PromptState;
  readonly proxy: ProxyState;
  readonly container: ContainerPlan;
}

/** Union of all slice keys. */
export type SliceKey = keyof PipelineState;
