import type { Profile } from "../../config/types.ts";
import type { DevcontainerRegistration } from "./types.ts";

export interface DevcontainerDisclosure {
  readonly topic: string;
  readonly detail: string;
}

export interface DevcontainerInitResult {
  readonly registration: DevcontainerRegistration;
  readonly sharing: readonly DevcontainerDisclosure[];
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
    {
      topic: "Claude credentials",
      detail:
        "host ~/.claude and ~/.claude.json, read-write; kept on the host after down",
    },
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
