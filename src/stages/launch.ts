/**
 * コンテナ起動ステージ (PlanStage)
 *
 * docker-run-interactive effect を返す。
 */

import type {
  DockerRunInteractiveEffect,
  PlanStage,
  StageInput,
  StagePlan,
} from "../pipeline/types.ts";
import {
  NAS_KIND_AGENT,
  NAS_KIND_LABEL,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
  NAS_PWD_LABEL,
} from "../docker/nas_resources.ts";
import { logInfo } from "../log.ts";

// ---------------------------------------------------------------------------
// LaunchStage (PlanStage)
// ---------------------------------------------------------------------------

export function createLaunchStage(
  extraArgs: string[] = [],
): PlanStage {
  return {
    kind: "plan",
    name: "LaunchStage",

    plan(input: StageInput): StagePlan | null {
      const command = [
        ...input.prior.agentCommand,
        ...input.profile.agentArgs,
        ...extraArgs,
      ];

      logInfo(`[nas] Launching container...`);
      logInfo(`[nas]   Image: ${input.prior.imageName}`);
      logInfo(`[nas]   Agent: ${input.profile.agent}`);
      logInfo(`[nas]   Command: ${command.join(" ")}`);

      const runEffect: DockerRunInteractiveEffect = {
        kind: "docker-run-interactive",
        image: input.prior.imageName,
        name: `nas-agent-${input.sessionId}`,
        args: [...input.prior.dockerArgs],
        envVars: { ...input.prior.envVars },
        command,
        labels: {
          [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
          [NAS_KIND_LABEL]: NAS_KIND_AGENT,
          [NAS_PWD_LABEL]: input.prior.workDir,
        },
      };

      return {
        effects: [runEffect],
        dockerArgs: [],
        envVars: {},
        outputOverrides: {},
      };
    },
  };
}
