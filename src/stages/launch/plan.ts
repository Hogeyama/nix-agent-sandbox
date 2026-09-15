import {
  containerNameForSession,
  NAS_KIND_AGENT,
  NAS_KIND_LABEL,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
  NAS_PWD_LABEL,
  NAS_SESSION_ID_LABEL,
} from "../../docker/nas_resources.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { ContainerPlan, PipelineState } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";

export interface FinalizedLaunchPlan {
  readonly containerName: string;
  readonly container: ContainerPlan;
}

/** Finalizes the launch data shared by Docker CLI and Compose compilers. */
export function finalizeLaunchPlan(
  input: StageInput & Pick<PipelineState, "container">,
  extraArgs: readonly string[] = [],
): FinalizedLaunchPlan {
  const base = input.container;
  const container = mergeContainerPlan(base, {
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

  return {
    containerName: containerNameForSession(input.sessionId),
    container,
  };
}
