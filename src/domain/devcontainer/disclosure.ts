import type { Profile } from "../../config/types.ts";
import type { DevcontainerRegistration } from "./types.ts";

export interface DevcontainerDisclosure {
  readonly topic: string;
  readonly detail: string;
}

export interface DevcontainerInitResult {
  readonly registration: DevcontainerRegistration;
  readonly sharing: readonly DevcontainerDisclosure[];
  /**
   * Profile agentArgs the IDE session cannot use (Codex app-server accepts
   * only -c/--config pairs). Surfaced at init, the last point nas is on
   * screen before VS Code takes over.
   */
  readonly droppedAgentArgs: readonly string[];
}

/**
 * What the generated Dev Container will do on the user's behalf.
 *
 * VS Code shows a devcontainer.json, not a nas profile, so every decision the
 * profile makes is invisible from the place the container is opened: someone
 * who reopens a folder in a container has no reason to expect that it reads
 * `.envrc`, or that the credentials inside are the ones from their host home.
 * `init` is the last point where nas is still on screen, which makes it the
 * only honest place to say so.
 *
 * Derived from the profile alone, so it cannot drift from a running session
 * the way a hand-written note in the docs would.
 */
export function describeDevcontainerSharing(
  profile: Profile,
): readonly DevcontainerDisclosure[] {
  const disclosures: DevcontainerDisclosure[] = [
    {
      topic: "workspace",
      detail: "shared read-write; .devcontainer and .nas stay read-only",
    },
    profile.agent === "codex"
      ? {
          topic: "Codex credentials",
          detail: profile.agentState.protectSettings
            ? "host ~/.codex shared read-write; config.toml read-only; kept on the host after down"
            : "host ~/.codex, read-write; kept on the host after down",
        }
      : {
          topic: "Claude credentials",
          detail: profile.agentState.protectSettings
            ? "host Claude credentials, history, projects (including auto memory), and ~/.claude.json shared read-write; other host ~/.claude configuration read-only; logs and caches session-private; shared state kept on the host after down"
            : "host ~/.claude and ~/.claude.json, read-write; kept on the host after down",
        },
    // cliExecutable is the only hook OpenAI ships for the Codex extension
    // and it is documented as development-only, so the generated config says
    // so where the user can still see it.
    ...(profile.agent === "codex"
      ? [
          {
            topic: "Codex extension",
            detail:
              "chatgpt.cliExecutable is redirected to nas's wrapper — a development-only hook that extension updates may change",
          },
        ]
      : []),
    {
      topic: "IDE server",
      detail:
        "VS Code Server and extensions are per-workspace, not shared with other projects",
    },
    {
      topic: "direnv",
      detail: profile.direnv.enable
        ? "evaluates the workspace .envrc, but only one already allowed on the host"
        : "does not evaluate the workspace .envrc",
    },
    {
      topic: "network",
      detail:
        profile.network.fallback === "review"
          ? "destinations outside the allowlist wait for approval on the host"
          : "destinations outside the allowlist are denied",
    },
  ];
  // The store mount is decided by the mount probes, which the profile cannot
  // see — "auto" means the disclosure can only promise the conditional form.
  if (profile.nix.enable !== false && profile.nix.mountSocket)
    disclosures.push({
      topic: "nix",
      detail:
        "host /nix store and daemon socket, read-write, when the host has Nix",
    });
  if (profile.docker.enable)
    disclosures.push({
      topic: "docker",
      detail:
        "rootless Docker-in-Docker sidecar shares the session network namespace; inner containers' published ports appear on localhost; the daemon and its data are removed on down",
    });
  const rules = profile.hostexec?.rules.length ?? 0;
  disclosures.push({
    topic: "host commands",
    detail:
      rules === 0
        ? "disabled"
        : `allowed within ${rules} rule${rules === 1 ? "" : "s"} from the profile`,
  });
  for (const mount of profile.extraMounts)
    disclosures.push({
      topic: "extra mount",
      detail: `${mount.src} -> ${mount.dst} (${mount.mode === "ro" ? "read-only" : "read-write"})`,
    });
  return disclosures;
}
