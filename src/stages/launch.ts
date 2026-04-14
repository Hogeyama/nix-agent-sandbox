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
  readonly image: string;
  readonly args: string[];
  readonly envVars: Record<string, string>;
  readonly command: string[];
  readonly labels: Record<string, string>;
}

export function planLaunch(
  input: StageInput,
  extraArgs: string[] = [],
): LaunchPlan {
  const command = [
    ...input.prior.agentCommand,
    ...input.profile.agentArgs,
    ...extraArgs,
  ];

  logInfo(`[nas] Launching container...`);
  logInfo(`[nas]   Image: ${input.prior.imageName}`);
  logInfo(`[nas]   Agent: ${input.profile.agent}`);
  logInfo(`[nas]   Command: ${command.join(" ")}`);

  return {
    containerName: `nas-agent-${input.sessionId}`,
    image: input.prior.imageName,
    args: [...input.prior.dockerArgs],
    envVars: { ...input.prior.envVars },
    command,
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_AGENT,
      [NAS_PWD_LABEL]: input.prior.workDir,
      [NAS_SESSION_ID_LABEL]: input.sessionId,
    },
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

      const opts: LaunchOpts = {
        image: plan.image,
        name: plan.containerName,
        args: plan.args,
        envVars: plan.envVars,
        command: plan.command,
        labels: plan.labels,
      };

      return Effect.gen(function* () {
        const containerLaunchService = yield* ContainerLaunchService;
        yield* containerLaunchService.launch(opts);
        return {};
      });
    },
  };
}
