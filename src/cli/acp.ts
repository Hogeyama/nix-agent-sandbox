import type { Profile } from "../config/types.ts";

export function validateAcpInvocation(
  profile: Profile,
  extraArgs: readonly string[],
  env: NodeJS.ProcessEnv,
  stdinIsTTY: boolean,
): void {
  if (profile.mode !== "acp") return;
  if (env.NAS_INSIDE_DTACH)
    throw new Error(
      "ACP profiles cannot run inside dtach or the web terminal. Launch nas directly from an ACP client.",
    );
  if (stdinIsTTY)
    throw new Error(
      "ACP requires piped stdin. Launch nas as a subprocess of an ACP client.",
    );
  if (extraArgs.length > 0)
    throw new Error(
      "ACP does not accept CLI agent arguments. Configure the ACP client or Claude settings instead.",
    );
  if (profile.worktree)
    throw new Error(
      "ACP does not support --worktree. Start nas in an existing workspace or worktree.",
    );
}
