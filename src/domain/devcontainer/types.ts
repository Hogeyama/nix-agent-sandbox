import { createHash } from "node:crypto";
import type { AgentType } from "../../agents/types.ts";
import type { Profile } from "../../config/types.ts";
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
  /**
   * The profile's agent at init time. The generated devcontainer.json bakes
   * in agent-specific VS Code settings, so `up` compares this against the
   * current profile instead of silently booting a mismatched container.
   * Registrations written before Codex support have no field and are claude.
   */
  readonly agent: AgentType;
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
    agent: "claude",
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
  readonly command: readonly string[];
}
