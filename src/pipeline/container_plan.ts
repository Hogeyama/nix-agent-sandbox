/**
 * ContainerPlan helpers.
 *
 * Pure functions for creating and patching ContainerPlan values.
 */

import type {
  CommandSpec,
  ContainerPlan,
  DynamicEnvOp,
  MountSpec,
  NetworkAttachment,
} from "./state.ts";

// ---------------------------------------------------------------------------
// ContainerPatch
// ---------------------------------------------------------------------------

/**
 * A partial update to a ContainerPlan.
 *
 * Merge semantics (applied by mergeContainerPlan):
 *   - mounts, env.dynamicOps, extraRunArgs  → append
 *   - env.static, labels                    → key-merge (patch wins)
 *   - network, command, image, workDir      → replace (undefined = keep base)
 */
export interface ContainerPatch {
  readonly image?: string;
  readonly workDir?: string;
  readonly mounts?: readonly MountSpec[];
  readonly env?: {
    readonly static?: Readonly<Record<string, string>>;
    readonly dynamicOps?: readonly DynamicEnvOp[];
  };
  readonly network?: NetworkAttachment;
  readonly extraRunArgs?: readonly string[];
  readonly command?: CommandSpec;
  readonly labels?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Returns a zero-value ContainerPlan for the given image and workDir. */
export function emptyContainerPlan(
  image: string,
  workDir: string,
): ContainerPlan {
  return {
    image,
    workDir,
    mounts: [],
    env: { static: {}, dynamicOps: [] },
    extraRunArgs: [],
    command: { agentCommand: [], extraArgs: [] },
    labels: {},
  };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge a ContainerPatch into a ContainerPlan and return the new plan.
 *
 * The base plan is never mutated.
 */
export function mergeContainerPlan(
  base: ContainerPlan,
  patch: ContainerPatch,
): ContainerPlan {
  return {
    image: patch.image ?? base.image,
    workDir: patch.workDir ?? base.workDir,
    mounts:
      patch.mounts !== undefined
        ? [...base.mounts, ...patch.mounts]
        : base.mounts,
    env: {
      static:
        patch.env?.static !== undefined
          ? { ...base.env.static, ...patch.env.static }
          : base.env.static,
      dynamicOps:
        patch.env?.dynamicOps !== undefined
          ? [...base.env.dynamicOps, ...patch.env.dynamicOps]
          : base.env.dynamicOps,
    },
    network: patch.network !== undefined ? patch.network : base.network,
    extraRunArgs:
      patch.extraRunArgs !== undefined
        ? [...base.extraRunArgs, ...patch.extraRunArgs]
        : base.extraRunArgs,
    command: patch.command !== undefined ? patch.command : base.command,
    labels:
      patch.labels !== undefined
        ? { ...base.labels, ...patch.labels }
        : base.labels,
  };
}
