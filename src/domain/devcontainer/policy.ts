import type { Profile } from "../../config/types.ts";

/** The only Dev Container profile gate: `devcontainer init`, `up`, and the
 * Dev Container branch of planMount all reject through this list. */
export function validateDevcontainerProfile(
  profile: Profile,
): readonly string[] {
  const errors: string[] = [];
  if (profile.agent !== "claude")
    errors.push("agent must be claude for devcontainer sessions");
  if (profile.nix.enable !== false)
    errors.push("nix.enable must be false for devcontainer sessions");
  if (profile.docker.enable)
    errors.push("docker.enable must be false for devcontainer sessions");
  if (profile.worktree)
    errors.push(
      "worktree is unsupported; create the worktree first, then run init there",
    );
  if (profile.gpg.forwardAgent)
    errors.push("gpg.forwardAgent must be false for devcontainer sessions");
  if (profile.aws.mountConfig)
    errors.push("aws.mountConfig must be false for devcontainer sessions");
  if (profile.gcloud.mountConfig)
    errors.push("gcloud.mountConfig must be false for devcontainer sessions");
  if (
    profile.network.fallback !== undefined &&
    !["deny", "review"].includes(profile.network.fallback)
  )
    errors.push(
      "network.fallback must be deny or review for devcontainer sessions",
    );
  return errors;
}
