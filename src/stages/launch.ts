/**
 * コンテナ起動ステージ (EffectStage)
 *
 * DockerService.runInteractive を呼び出してコンテナを起動する。
 * session.enable が有効な場合、CLI 層が dtach でラップ済みなので
 * このステージは常に直接実行する。
 */

import { Effect } from "effect";
import {
  NAS_KIND_AGENT,
  NAS_KIND_LABEL,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
  NAS_PWD_LABEL,
  NAS_SESSION_ID_LABEL,
} from "../docker/nas_resources.ts";
import { logInfo } from "../log.ts";
import { emptyContainerPlan, mergeContainerPlan } from "../pipeline/container_plan.ts";
import { encodeDynamicEnvOps } from "../pipeline/env_ops.ts";
import type { ContainerPlan } from "../pipeline/state.ts";
import type {
  EffectStage,
  EffectStageResult,
  StageInput,
} from "../pipeline/types.ts";
import {
  ContainerLaunchService,
  type LaunchOpts,
} from "../services/container_launch.ts";

// ---------------------------------------------------------------------------
// LaunchPlan
// ---------------------------------------------------------------------------

export interface LaunchPlan {
  readonly containerName: string;
  readonly container: ContainerPlan;
  readonly opts: LaunchOpts;
}

export function planLaunch(
  input: StageInput,
  extraArgs: string[] = [],
): LaunchPlan {
  const containerName = `nas-agent-${input.sessionId}`;
  const container = buildLaunchContainerPlan(input, extraArgs);
  const opts = compileLaunchOpts(container, containerName);

  logInfo(`[nas] Launching container...`);
  logInfo(`[nas]   Image: ${opts.image}`);
  logInfo(`[nas]   Agent: ${input.profile.agent}`);
  logInfo(`[nas]   Command: ${opts.command.join(" ")}`);

  return {
    containerName,
    container,
    opts,
  };
}

function buildLaunchContainerPlan(
  input: StageInput,
  extraArgs: readonly string[],
): ContainerPlan {
  const base =
    input.prior.container ??
    buildLegacyContainerPlan(input);

  return mergeContainerPlan(base, {
    command: {
      agentCommand: [...base.command.agentCommand],
      extraArgs: [
        ...base.command.extraArgs,
        ...input.profile.agentArgs,
        ...extraArgs,
      ],
    },
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_AGENT,
      [NAS_PWD_LABEL]: base.workDir,
      [NAS_SESSION_ID_LABEL]: input.sessionId,
    },
  });
}

function buildLegacyContainerPlan(input: StageInput): ContainerPlan {
  const mounts: Array<ContainerPlan["mounts"][number]> = [];
  const extraRunArgs: string[] = [];
  let workDir = input.prior.workDir;
  let networkName: string | undefined;
  let networkAlias: string | undefined;

  for (let i = 0; i < input.prior.dockerArgs.length; i += 1) {
    const arg = input.prior.dockerArgs[i];
    if (arg === "-v" && i + 1 < input.prior.dockerArgs.length) {
      const mountArg = input.prior.dockerArgs[i + 1];
      if (mountArg !== undefined) {
        mounts.push(parseMountSpec(mountArg));
      }
      i += 1;
      continue;
    }
    if (arg === "-w" && i + 1 < input.prior.dockerArgs.length) {
      const workDirArg = input.prior.dockerArgs[i + 1];
      if (workDirArg !== undefined) {
        workDir = workDirArg;
      }
      i += 1;
      continue;
    }
    if (arg === "--network" && i + 1 < input.prior.dockerArgs.length) {
      const networkArg = input.prior.dockerArgs[i + 1];
      if (networkArg !== undefined) {
        networkName = networkArg;
      }
      i += 1;
      continue;
    }
    if (arg === "--network-alias" && i + 1 < input.prior.dockerArgs.length) {
      const aliasArg = input.prior.dockerArgs[i + 1];
      if (aliasArg !== undefined) {
        networkAlias = aliasArg;
      }
      i += 1;
      continue;
    }
    extraRunArgs.push(arg);
  }

  return mergeContainerPlan(emptyContainerPlan(input.prior.imageName, workDir), {
    mounts,
    env: { static: { ...input.prior.envVars } },
    ...(networkName
      ? { network: { name: networkName, alias: networkAlias } }
      : {}),
    extraRunArgs,
    command: {
      agentCommand: [...input.prior.agentCommand],
      extraArgs: [],
    },
  });
}

function parseMountSpec(rawMount: string): ContainerPlan["mounts"][number] {
  const readOnly = rawMount.endsWith(":ro");
  const mountValue = readOnly ? rawMount.slice(0, -3) : rawMount;
  const separatorIndex = mountValue.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`[nas] Invalid mount arg: ${rawMount}`);
  }
  const source = mountValue.slice(0, separatorIndex);
  const target = mountValue.slice(separatorIndex + 1);
  return readOnly ? { source, target, readOnly: true } : { source, target };
}

export function compileLaunchOpts(
  plan: ContainerPlan,
  containerName: string,
): LaunchOpts {
  const args: string[] = ["-w", plan.workDir];

  for (const mount of plan.mounts) {
    const suffix = mount.readOnly ? ":ro" : "";
    args.push("-v", `${mount.source}:${mount.target}${suffix}`);
  }

  if (plan.network) {
    args.push("--network", plan.network.name);
    if (plan.network.alias) {
      args.push("--network-alias", plan.network.alias);
    }
  }

  args.push(...plan.extraRunArgs);

  const envVars: Record<string, string> = { ...plan.env.static };
  if (plan.env.dynamicOps.length > 0) {
    envVars.NAS_ENV_OPS = encodeDynamicEnvOps(plan.env.dynamicOps);
  }

  return {
    image: plan.image,
    name: containerName,
    args,
    envVars,
    command: [...plan.command.agentCommand, ...plan.command.extraArgs],
    labels: { ...plan.labels },
  };
}

// ---------------------------------------------------------------------------
// LaunchStage (EffectStage<ContainerLaunchService>)
// ---------------------------------------------------------------------------

export function createLaunchStage(
  extraArgs: string[] = [],
): EffectStage<ContainerLaunchService> {
  return {
    kind: "effect",
    name: "LaunchStage",

    run(
      input: StageInput,
    ): Effect.Effect<EffectStageResult, unknown, ContainerLaunchService> {
      const plan = planLaunch(input, extraArgs);

      return Effect.gen(function* () {
        const containerLaunchService = yield* ContainerLaunchService;
        yield* containerLaunchService.launch(plan.opts);
        return {};
      });
    },
  };
}
