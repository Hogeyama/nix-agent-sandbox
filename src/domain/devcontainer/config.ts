import type { HostEnv } from "../../pipeline/types.ts";
import type { DevcontainerRegistration } from "./types.ts";
import { type DevcontainerInputs, devcontainerWorkspaceId } from "./types.ts";

/** Forwarding protections beyond these keys require target-version IDE verification. */
export function renderDevcontainerConfig(
  registration: DevcontainerRegistration,
  remoteUser: string,
) {
  return {
    name: "nas",
    initializeCommand: [
      ...registration.command,
      "devcontainer",
      "up",
      "--workspace",
      registration.workspace,
    ],
    dockerComposeFile: [registration.composePath],
    service: "agent",
    workspaceFolder: registration.workspace,
    remoteUser,
    updateRemoteUserUID: false,
    overrideCommand: false,
    userEnvProbe: "loginInteractiveShell",
    shutdownAction: "none",
    customizations: {
      vscode: {
        extensions: ["anthropic.claude-code"],
        settings: {
          "claudeCode.claudeProcessWrapper":
            "/usr/local/bin/nas-devcontainer-claude",
          "remote.autoForwardPorts": false,
        },
      },
    },
  };
}

export function computeDevcontainerFingerprint(
  configBytes: string,
  inputs: DevcontainerInputs,
  host: HostEnv,
): string {
  return devcontainerWorkspaceId(
    JSON.stringify({
      generator: 1,
      configBytes,
      trustHash: inputs.trustHash,
      configDir: inputs.configDir,
      profileName: inputs.profileName,
      profile: inputs.profile,
      implementation: inputs.implementation,
      embedHash: inputs.embedHash,
      uid: host.uid,
      gid: host.gid,
      command: inputs.command,
    }),
  );
}
