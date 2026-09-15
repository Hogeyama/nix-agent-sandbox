import type { Profile } from "../../config/types.ts";
import * as defaults from "../../config/types.ts";
import type { DevcontainerRegistration } from "./types.ts";
export function devcontainerProfile(): Profile {
  return {
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
  };
}
export function registrationFixture(): DevcontainerRegistration {
  return {
    version: 1,
    workspaceId: "a".repeat(64),
    workspace: "/work/a space",
    profileName: "claude",
    fingerprint: "b".repeat(64),
    configPath: "/work/a space/.devcontainer/devcontainer.json",
    composePath: "/state/compose.json",
    stateRoot: "/state/dedicated",
    command: ["/bin/bun", "run", "/src/a space/main.ts"],
  };
}
