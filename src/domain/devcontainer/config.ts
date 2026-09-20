import type { AgentType } from "../../agents/types.ts";
import type { DevcontainerRegistration } from "./types.ts";

export function renderDevcontainerConfig(
  registration: DevcontainerRegistration,
  remoteUser: string,
  agent: AgentType,
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
      vscode:
        agent === "codex"
          ? {
              extensions: ["openai.chatgpt"],
              settings: {
                "chatgpt.cliExecutable":
                  "/usr/local/bin/nas-devcontainer-codex",
              },
            }
          : {
              extensions: ["anthropic.claude-code"],
              settings: {
                "claudeCode.claudeProcessWrapper":
                  "/usr/local/bin/nas-devcontainer-claude",
              },
            },
    },
  };
}
