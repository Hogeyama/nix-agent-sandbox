import type { Profile } from "../../config/types.ts";
import * as defaults from "../../config/types.ts";
import type { DevcontainerRegistration } from "./types.ts";
export function devcontainerProfile(): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    extraAgents: [],
    agentState: defaults.DEFAULT_AGENT_STATE_CONFIG,
    nix: { enable: false, mountSocket: false },
    direnv: defaults.DEFAULT_DIRENV_CONFIG,
    docker: defaults.DEFAULT_DOCKER_CONFIG,
    network: defaults.DEFAULT_NETWORK_CONFIG,
    session: defaults.DEFAULT_SESSION_CONFIG,
    dbus: defaults.DEFAULT_DBUS_CONFIG,
    display: defaults.DEFAULT_DISPLAY_CONFIG,
    extraMounts: [],
    env: [],
    hook: defaults.DEFAULT_HOOK_CONFIG,
    secrets: {},
    guide: defaults.DEFAULT_GUIDE_CONFIG,
  };
}
export function registrationFixture(): DevcontainerRegistration {
  return {
    version: 1,
    workspaceId: "a".repeat(64),
    workspace: "/work/a space",
    profileName: "claude",
    agent: "claude",
    configPath: "/work/a space/.devcontainer/devcontainer.json",
    composePath: "/state/compose.json",
    stateRoot: "/state/dedicated",
    command: ["/bin/bun", "run", "/src/a space/main.ts"],
  };
}
