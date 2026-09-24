import type { Profile } from "../../config/types.ts";

/** The only Dev Container profile gate: `devcontainer init`, `up`, and the
 * Dev Container branch of planMount all reject through this list. */
export function validateDevcontainerProfile(
  profile: Profile,
): readonly string[] {
  const errors: string[] = [];
  if (profile.agent !== "claude" && profile.agent !== "codex")
    errors.push("agent must be claude or codex for devcontainer sessions");
  if (profile.extraAgents.length > 0)
    errors.push("extraAgents is unsupported for devcontainer sessions");
  if (profile.worktree)
    errors.push(
      "worktree is unsupported; create the worktree first, then run init there",
    );
  return errors;
}
