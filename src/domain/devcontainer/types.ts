import { createHash } from "node:crypto";
import type { Profile } from "../../config/types.ts";
import * as defaults from "../../config/types.ts";
export type DevcontainerPhase =
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";
export interface DevcontainerRegistration {
  readonly version: 1;
  readonly workspaceId: string;
  readonly workspace: string;
  readonly profileName: string;
  readonly fingerprint: string;
  readonly configPath: string;
  readonly composePath: string;
  readonly stateRoot: string;
  readonly command: readonly string[];
}
export interface DevcontainerStatus {
  readonly workspaceId: string;
  readonly profileName: string;
  readonly phase: DevcontainerPhase;
  readonly sessionId: string | null;
  readonly containerId: string | null;
  readonly diagnostic: string | null;
}
export interface DevcontainerSessionRecord {
  readonly version: 1;
  readonly workspaceId: string;
  readonly fingerprint: string;
  readonly sessionId: string;
  readonly containerId: string | null;
  readonly phase: DevcontainerPhase;
  /** PID of the process holding the pipeline scope; null until it claims the session. */
  readonly pid: number | null;
  readonly diagnostic: string | null;
}
export interface DevcontainerPaths {
  readonly registrationDir: string;
  readonly registrationFile: string;
  readonly composeFile: string;
  readonly operationLock: string;
  readonly stateRoot: string;
  readonly vscodeDir: string;
}
export interface DevcontainerRuntimePaths {
  readonly runtimeDir: string;
  readonly sessionFile: string;
  readonly lifetimeLock: string;
}
export class DevcontainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevcontainerError";
  }
}
export function projectDevcontainerStatus(
  registration: DevcontainerRegistration,
  session: DevcontainerSessionRecord | null,
): DevcontainerStatus {
  return {
    workspaceId: registration.workspaceId,
    profileName: registration.profileName,
    phase: session?.phase ?? "stopped",
    sessionId: session?.sessionId ?? null,
    containerId: session?.containerId ?? null,
    diagnostic: session?.diagnostic ?? null,
  };
}

export function emptyRegistration(
  workspace: string,
  profileName: string,
): DevcontainerRegistration {
  return {
    version: 1,
    workspaceId: "",
    workspace,
    profileName,
    fingerprint: "",
    configPath: "",
    composePath: "",
    stateRoot: "",
    command: [],
  };
}

export function devcontainerWorkspaceId(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex");
}

export interface DevcontainerInputs {
  readonly profile: Profile;
  readonly profileName: string;
  readonly trustHash: string;
  readonly configDir: string;
  readonly implementation: string;
  readonly embedHash: string;
  readonly command: readonly string[];
}

/** Empty successful D1 fake value; callers can override inputs with a fixture. */
export function emptyDevcontainerInputs(
  workspace: string,
  profileName: string,
): DevcontainerInputs {
  return {
    profileName,
    configDir: `${workspace}/.nas`,
    trustHash: "",
    implementation: "",
    embedHash: "",
    command: [],
    profile: structuredClone({
      agent: "claude",
      agentArgs: [],
      nix: { enable: false, mountSocket: false },
      direnv: defaults.DEFAULT_DIRENV_CONFIG,
      docker: defaults.DEFAULT_DOCKER_CONFIG,
      gcloud: defaults.DEFAULT_GCLOUD_CONFIG,
      aws: defaults.DEFAULT_AWS_CONFIG,
      gpg: defaults.DEFAULT_GPG_CONFIG,
      network: defaults.DEFAULT_NETWORK_CONFIG,
      session: defaults.DEFAULT_SESSION_CONFIG,
      dbus: defaults.DEFAULT_DBUS_CONFIG,
      display: defaults.DEFAULT_DISPLAY_CONFIG,
      extraMounts: [],
      env: [],
      hook: defaults.DEFAULT_HOOK_CONFIG,
      secrets: {},
      guide: defaults.DEFAULT_GUIDE_CONFIG,
    }),
  };
}
