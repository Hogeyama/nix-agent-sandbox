/**
 * ContainerPlan compiler helpers.
 *
 * Pure functions for creating, patching, and compiling ContainerPlan values.
 * LaunchStage is the sole caller of compileLaunchOpts in production (C10).
 * Defining the compiler here in C2 allows parity tests to validate correctness
 * independently of the full pipeline wiring.
 *
 * Effect-separation note: imports from src/services/ are type-only.
 */

import type { LaunchOpts } from "../services/container_launch.ts";
import { encodeDynamicEnvOps } from "./env_ops.ts";
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

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * Compile a ContainerPlan into LaunchOpts (the Docker CLI encoding).
 *
 * This is the canonical ContainerPlan → Docker CLI compiler.  LaunchStage is
 * its sole production caller; no other stage should produce Docker args
 * directly from a ContainerPlan.
 *
 * @param plan          The declarative container description to compile.
 * @param containerName The `docker run --name` value (e.g. `nas-agent-<id>`).
 */
export function compileLaunchOpts(
  plan: ContainerPlan,
  containerName: string,
): LaunchOpts {
  const args: string[] = [];

  // Working directory
  args.push("-w", plan.workDir);

  // Bind mounts
  for (const mount of plan.mounts) {
    const suffix = mount.readOnly ? ":ro" : "";
    args.push("-v", `${mount.source}:${mount.target}${suffix}`);
  }

  // Network attachment
  if (plan.network) {
    args.push("--network", plan.network.name);
    if (plan.network.alias) {
      args.push("--network-alias", plan.network.alias);
    }
  }

  // Extra run args (verbatim passthrough)
  args.push(...plan.extraRunArgs);

  // Env vars: static entries plus encoded dynamic ops
  const envVars: Record<string, string> = { ...plan.env.static };
  if (plan.env.dynamicOps.length > 0) {
    envVars.NAS_ENV_OPS = encodeDynamicEnvOps(plan.env.dynamicOps);
  }

  // Command
  const command = [
    ...plan.command.agentCommand,
    ...plan.command.extraArgs,
  ];

  return {
    image: plan.image,
    name: containerName,
    args,
    envVars,
    command,
    labels: { ...plan.labels },
  };
}
