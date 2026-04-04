/**
 * Adapter to wrap legacy Stage into ProceduralStage.
 *
 * adaptLegacyStage takes a legacy Stage and an ExecutionContext, and returns
 * a ProceduralStage that delegates to the legacy Stage's execute/teardown.
 */

import type { ExecutionContext } from "./context.ts";
import type { Stage } from "./pipeline.ts";
import type {
  PriorStageOutputs,
  ProceduralResult,
  ProceduralStage,
  StageInput,
} from "./types.ts";

/**
 * Wrap a legacy Stage as a ProceduralStage.
 *
 * The adapter captures a mutable reference to the ExecutionContext.
 * On execute(), it calls stage.execute(ctx), saves the returned ctx,
 * and extracts output overrides by diffing relevant fields.
 * On teardown(), it calls stage.teardown(ctx) if defined.
 */
export function adaptLegacyStage(
  stage: Stage,
  ctx: ExecutionContext,
): ProceduralStage {
  // Mutable ctx reference — updated after each execute()
  let currentCtx = ctx;

  return {
    kind: "procedural",
    name: stage.name,

    async execute(_input: StageInput): Promise<ProceduralResult> {
      const newCtx = await stage.execute(currentCtx);
      const outputOverrides = extractOverrides(currentCtx, newCtx);
      currentCtx = newCtx;
      return { outputOverrides };
    },

    teardown: stage.teardown
      ? async (_input: StageInput): Promise<void> => {
        await stage.teardown!(currentCtx);
      }
      : undefined,
  };
}

/**
 * Extract fields that changed between old and new ExecutionContext
 * as a Partial<PriorStageOutputs>.
 *
 * IMPORTANT: This function must be kept in sync with PriorStageOutputs.
 * When adding a new field to PriorStageOutputs, add it here as well.
 *
 * For dockerArgs and envVars, we compute the diff (new items only) so that
 * runPipelineV2 can uniformly append/merge across both PlanStage and
 * ProceduralStage. Legacy stages replace the entire array/object, so the
 * diff captures the new elements that were added on top of the old ones.
 * Key deletion is not detected -- if a legacy stage removes a key from
 * envVars or shrinks dockerArgs, that change is silently ignored.
 *
 * Note: stages are expected to return new array/object references when they
 * make changes; reference equality is used for the comparison.
 */
function extractOverrides(
  oldCtx: ExecutionContext,
  newCtx: ExecutionContext,
): Partial<PriorStageOutputs> {
  const overrides: Record<string, unknown> = {};

  // dockerArgs: compute diff (new items appended by the stage).
  // Stages return a new array reference when they add args.
  if (newCtx.dockerArgs !== oldCtx.dockerArgs) {
    const oldLen = oldCtx.dockerArgs.length;
    overrides.dockerArgs = newCtx.dockerArgs.slice(oldLen);
  }

  // envVars: compute diff (new or changed keys only).
  if (newCtx.envVars !== oldCtx.envVars) {
    const diff: Record<string, string> = {};
    for (const [k, v] of Object.entries(newCtx.envVars)) {
      if (oldCtx.envVars[k] !== v) {
        diff[k] = v;
      }
    }
    if (Object.keys(diff).length > 0) {
      overrides.envVars = diff;
    }
  }

  // Scalar/optional fields mapping: ExecutionContext field -> PriorStageOutputs field.
  // NOTE: dindContainerName and networkName exist in PriorStageOutputs but not in
  // ExecutionContext; they are only produced by PlanStage effects, not legacy stages.
  const fields: (keyof ExecutionContext & keyof PriorStageOutputs)[] = [
    "workDir",
    "mountDir",
    "imageName",
    "agentCommand",
    "nixEnabled",
    "networkRuntimeDir",
    "networkPromptToken",
    "networkPromptEnabled",
    "networkBrokerSocket",
    "networkProxyEndpoint",
    "hostexecRuntimeDir",
    "hostexecBrokerSocket",
    "hostexecSessionTmpDir",
    "dbusProxyEnabled",
    "dbusSessionRuntimeDir",
    "dbusSessionSocket",
    "dbusSessionSourceAddress",
  ];

  for (const field of fields) {
    if (newCtx[field] !== oldCtx[field]) {
      overrides[field] = newCtx[field];
    }
  }

  return overrides as Partial<PriorStageOutputs>;
}
