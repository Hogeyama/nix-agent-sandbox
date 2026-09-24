/**
 * コンテナ起動ステージ (EffectStage)
 *
 * DockerService.runInteractive を呼び出してコンテナを起動する。
 * session.multiplex が有効な場合、CLI 層が dtach でラップ済みなので
 * このステージは常に直接実行する。
 */

import { Effect } from "effect";
import { logInfo } from "../../log.ts";
import { encodeDynamicEnvOps } from "../../pipeline/env_ops.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { ContainerPlan, PipelineState } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import {
  ContainerLaunchService,
  type LaunchOpts,
} from "./container_launch_service.ts";
import { agentPrivilegeRunArgs } from "./hardening.ts";
import { finalizeLaunchPlan } from "./plan.ts";

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
  extraArgs: readonly string[] = [],
): LaunchPlan {
  const { containerName, container } = finalizeLaunchPlan(input, extraArgs);
  const opts = compileLaunchOpts(container, containerName, input.profile.mode);

  logInfo(`[nas] Launching container...`);
  logInfo(`[nas]   Image: ${opts.image}`);
  logInfo(`[nas]   Agent: ${input.profile.agent}`);
  if (input.profile.extraAgents.length > 0) {
    logInfo(`[nas]   Extra agents: ${input.profile.extraAgents.join(", ")}`);
  }
  logInfo(`[nas]   Command: ${opts.command.join(" ")}`);

  return {
    containerName,
    container,
    opts,
  };
}

export function compileLaunchOpts(
  plan: ContainerPlan,
  containerName: string,
  mode?: "terminal" | "acp",
): LaunchOpts {
  // The agent TUI redraws constantly; capturing stdout/stderr via the
  // default journald driver dominates host I/O pressure. Nobody reads
  // `docker logs` for agent containers (the user attaches via TTY/dtach),
  // so disable the log driver entirely.
  const args: string[] = ["--log-driver=none", "-w", plan.workDir];

  // Before extraRunArgs so a caller's own --cap-add still takes effect.
  args.push(...agentPrivilegeRunArgs());

  for (const mount of plan.mounts) {
    const suffix = mount.readOnly ? ":ro" : "";
    args.push("-v", `${mount.source}:${mount.target}${suffix}`);
  }

  for (const volume of plan.namedVolumes) {
    const suffix = volume.readOnly ? ":ro" : "";
    args.push("-v", `${volume.name}:${volume.target}${suffix}`);
  }

  if (plan.network) {
    if (plan.network.mode === "container") {
      args.push("--network", `container:${plan.network.containerName}`);
    } else {
      args.push("--network", plan.network.name);
      if (plan.network.alias) {
        args.push("--network-alias", plan.network.alias);
      }
    }
  }

  // Host mappings are meaningless to a container joining another container's
  // namespace (`--network container:<name>`) — Docker rejects --add-host in
  // that mode since the namespace owner already resolves them. Every other
  // case, including no network attachment at all, still needs its mappings.
  if (plan.network?.mode !== "container") {
    for (const entry of plan.extraHosts) {
      args.push(`--add-host=${entry.host}:${entry.ip}`);
    }
  }

  if (plan.shmSize !== undefined) {
    args.push("--shm-size", plan.shmSize);
  }

  args.push(...plan.extraRunArgs);

  const envVars: Record<string, string> = { ...plan.env.static };
  if (plan.env.dynamicOps.length > 0) {
    envVars.NAS_ENV_OPS = encodeDynamicEnvOps(plan.env.dynamicOps);
  }

  if (mode === "acp") envVars.NAS_EXECUTION_MODE = "acp";

  return {
    ...(mode === "acp" ? { mode } : {}),
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
