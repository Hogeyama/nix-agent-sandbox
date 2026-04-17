/**
 * コンテナ起動ステージ (EffectStage)
 *
 * DockerService.runInteractive を呼び出してコンテナを起動する。
 * session.enable が有効な場合、CLI 層が dtach でラップ済みなので
 * このステージは常に直接実行する。
 */

import { Effect } from "effect";
import {
  containerNameForSession,
  NAS_KIND_AGENT,
  NAS_KIND_LABEL,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
  NAS_PWD_LABEL,
  NAS_SESSION_ID_LABEL,
} from "../docker/nas_resources.ts";
import { logInfo } from "../log.ts";
import { mergeContainerPlan } from "../pipeline/container_plan.ts";
import { encodeDynamicEnvOps } from "../pipeline/env_ops.ts";
import type { Stage } from "../pipeline/stage_builder.ts";
import type { ContainerPlan, PipelineState } from "../pipeline/state.ts";
import type { StageInput } from "../pipeline/types.ts";
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
  input: StageInput & Pick<PipelineState, "container">,
  extraArgs: string[] = [],
): LaunchPlan {
  const containerName = containerNameForSession(input.sessionId);
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
  input: StageInput & Pick<PipelineState, "container">,
  extraArgs: readonly string[],
): ContainerPlan {
  const base = input.container;

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
  shared: StageInput,
  extraArgs: string[] = [],
  // biome-ignore lint/complexity/noBannedTypes: empty output — this stage adds no pipeline slices.
): Stage<"container", {}, ContainerLaunchService, unknown> {
  return {
    name: "LaunchStage",
    needs: ["container"],

    // biome-ignore lint/complexity/noBannedTypes: empty output — this stage adds no pipeline slices.
    run(input): Effect.Effect<{}, unknown, ContainerLaunchService> {
      const stageInput = {
        ...shared,
        ...input,
      };
      const plan = planLaunch(stageInput, extraArgs);

      return Effect.gen(function* () {
        const containerLaunchService = yield* ContainerLaunchService;
        yield* containerLaunchService.launch(plan.opts);
        return {};
      });
    },
  };
}
