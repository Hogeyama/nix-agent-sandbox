import type { DevcontainerRegistration } from "./types.ts";

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
        },
      },
    },
  };
}
