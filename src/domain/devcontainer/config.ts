import type { Profile } from "../../config/types.ts";
import {
  type DevcontainerIdeAgent,
  resolveDevcontainerIdeAgents,
} from "./agents.ts";
import type { DevcontainerRegistration } from "./types.ts";

/**
 * `devcontainer.json` written to disk at init. It continues to provide the
 * Compose and initialize configuration; it does not depend on the agent, so
 * a later profile change does not make it stale.
 *
 * Current-profile IDE customizations come from the already-running
 * container's `devcontainer.metadata` label (see `renderDevcontainerMetadata`
 * and `compose_stage.ts`), allowing an agent change without a re-init.
 */
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
  };
}

const IDE_AGENT_EXTENSION: Record<
  DevcontainerIdeAgent,
  { extension: string; settingKey: string; settingValue: string }
> = {
  claude: {
    extension: "anthropic.claude-code",
    settingKey: "claudeCode.claudeProcessWrapper",
    settingValue: "/usr/local/bin/nas-devcontainer-claude",
  },
  codex: {
    extension: "openai.chatgpt",
    settingKey: "chatgpt.cliExecutable",
    settingValue: "/usr/local/bin/nas-devcontainer-codex",
  },
};

export interface DevcontainerMetadata {
  readonly remoteUser: string;
  readonly updateRemoteUserUID: false;
  readonly overrideCommand: false;
  readonly userEnvProbe: "loginInteractiveShell";
  readonly shutdownAction: "none";
  readonly customizations: {
    readonly vscode: {
      readonly extensions: readonly string[];
      readonly settings: Readonly<Record<string, string>>;
    };
  };
}

/**
 * The effective, agent-dependent launch config, compiled from the *current*
 * profile at every launch and written to Compose's `devcontainer.metadata`
 * label (see `compose_stage.ts`). Dev Containers CLI reads this label from
 * an already-running container carrying nas's identifying labels in place of
 * `devcontainer.json`'s customizations, so a profile change since init is
 * picked up on the next `down`/`up` without regenerating the registration.
 *
 * Repeats the shared contract fields (`remoteUser`, `shutdownAction`, ...)
 * from `renderDevcontainerConfig` because Dev Containers CLI's container
 * metadata read replaces the whole set of updatable config, not just
 * `customizations` — see the "confirmation" links in the design doc.
 */
export function renderDevcontainerMetadata(
  profile: Pick<Profile, "agent" | "extraAgents">,
  remoteUser: string,
): DevcontainerMetadata {
  const ideAgents = resolveDevcontainerIdeAgents(profile);
  return {
    remoteUser,
    updateRemoteUserUID: false,
    overrideCommand: false,
    userEnvProbe: "loginInteractiveShell",
    shutdownAction: "none",
    customizations: {
      vscode: {
        extensions: ideAgents.map(
          (agent) => IDE_AGENT_EXTENSION[agent].extension,
        ),
        settings: Object.fromEntries(
          ideAgents.map((agent) => [
            IDE_AGENT_EXTENSION[agent].settingKey,
            IDE_AGENT_EXTENSION[agent].settingValue,
          ]),
        ),
      },
    },
  };
}
