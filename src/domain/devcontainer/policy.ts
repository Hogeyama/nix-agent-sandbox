import * as path from "node:path";
import type { Profile } from "../../config/types.ts";
import type { DevcontainerMountPolicy } from "./types.ts";

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

export function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
export function pathsOverlap(a: string, b: string): boolean {
  return pathContains(a, b) || pathContains(b, a);
}

/** Sources must already be canonicalized by the host I/O boundary. */
export function validateDevcontainerMount(
  source: string,
  target: string,
  policy: DevcontainerMountPolicy,
): readonly string[] {
  const errors: string[] = [];
  if (!path.isAbsolute(source) || !path.isAbsolute(target))
    return ["mount source and target must be absolute"];
  if (pathContains(source, policy.home))
    errors.push("mount source exposes host HOME");
  for (const protectedPath of [
    ...policy.hostOnlyPaths,
    ...policy.credentialPaths,
  ]) {
    if (pathsOverlap(source, protectedPath))
      errors.push(`mount source exposes protected host path: ${protectedPath}`);
  }
  const exactDedicated = policy.dedicatedMounts.some(
    (m) => m.source === source && m.target === target,
  );
  if (!exactDedicated) {
    if (
      policy.dedicatedStateRoot &&
      pathsOverlap(source, policy.dedicatedStateRoot)
    )
      errors.push(
        "dedicated state may only be mounted from this workspace at its registered target",
      );
    for (const mount of policy.dedicatedMounts) {
      if (pathsOverlap(source, mount.source))
        errors.push(
          "dedicated state may only be mounted at its registered target",
        );
    }
    for (const protectedTarget of policy.protectedTargets) {
      if (pathsOverlap(target, protectedTarget))
        errors.push(`mount target overlaps protected path: ${protectedTarget}`);
    }
  }
  return errors;
}
