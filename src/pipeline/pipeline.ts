/**
 * Pipeline 実行
 */

import { Effect } from "effect";
import { logInfo } from "../log.ts";
import type { ResourceHandle } from "./effects.ts";
import { executePlan, teardownHandles } from "./effects.ts";
import type {
  AnyStage,
  EffectStage,
  EffectStageResult,
  PipelineRequirements,
  PriorStageOutputs,
  StageInput,
  StagePlan,
  StageServices,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Pipeline — AnyStage runner
// ---------------------------------------------------------------------------

/** Merge a StagePlan's outputs into PriorStageOutputs.
 *
 * dockerArgs: If outputOverrides.dockerArgs is set, it replaces prior.dockerArgs
 * (then plan.dockerArgs is appended). This allows stages like ProxyStage to
 * modify existing args (e.g. replace --network) without duplicating the entire
 * prior args in plan.dockerArgs.
 */
export function mergeOutputs(
  prior: PriorStageOutputs,
  plan: StagePlan,
): PriorStageOutputs {
  const baseDockerArgs = plan.outputOverrides.dockerArgs ?? prior.dockerArgs;
  return {
    ...prior,
    ...plan.outputOverrides,
    dockerArgs: [...baseDockerArgs, ...plan.dockerArgs],
    envVars: { ...prior.envVars, ...plan.envVars },
  };
}

/** Teardown entry for tracking completed stages. */
type TeardownEntry =
  | { kind: "plan"; name: string; handles: ResourceHandle[] }
  | {
      kind: "procedural";
      name: string;
      stage: AnyStage & { kind: "procedural" };
      input: StageInput;
    };

/**
 * Run a pipeline of AnyStage[] (PlanStage or ProceduralStage).
 *
 * - PlanStage: calls plan() then executePlan(), merges outputs
 * - ProceduralStage: calls execute(), merges outputOverrides
 * - Teardown: in reverse order on completion or error
 */
export async function runPipeline(
  stages: AnyStage[],
  input: StageInput,
): Promise<PriorStageOutputs> {
  const teardowns: TeardownEntry[] = [];
  let prior = { ...input.prior };

  try {
    for (const stage of stages) {
      logInfo(`[nas] Running stage: ${stage.name}`);

      // Build a fresh input snapshot with the current prior
      const currentInput: StageInput = { ...input, prior };

      if (stage.kind === "plan") {
        const plan = stage.plan(currentInput);
        if (plan === null) {
          logInfo(`[nas] Stage skipped: ${stage.name}`);
          continue;
        }
        const handles = await executePlan(plan);
        teardowns.push({ kind: "plan", name: stage.name, handles });
        prior = mergeOutputs(prior, plan);
      } else if (stage.kind === "procedural") {
        // ProceduralStage
        // NOTE: If execute() throws, the stage is NOT added to teardowns.
        // This matches PlanStage behavior and means partially-executed stages
        // must handle their own cleanup on failure.
        const result = await stage.execute(currentInput);
        // NOTE: teardown receives the input snapshot at execute-time,
        // not the latest accumulated prior.
        teardowns.push({
          kind: "procedural",
          name: stage.name,
          stage,
          input: currentInput,
        });
        // Merge overrides symmetrically with PlanStage:
        // dockerArgs are appended, envVars are merged, others are replaced.
        const overrides = result.outputOverrides ?? {};
        const newDockerArgs = overrides.dockerArgs
          ? [...prior.dockerArgs, ...overrides.dockerArgs]
          : prior.dockerArgs;
        const newEnvVars = overrides.envVars
          ? { ...prior.envVars, ...overrides.envVars }
          : prior.envVars;
        prior = {
          ...prior,
          ...overrides,
          dockerArgs: newDockerArgs,
          envVars: newEnvVars,
        };
      } else {
        // EffectStage should be adapted via adaptStages() before reaching here
        throw new Error(
          `EffectStage "${stage.name}" passed to runPipeline without adaptation. Use adaptStages() first.`,
        );
      }
    }
    return prior;
  } finally {
    // Teardown in reverse order
    for (let i = teardowns.length - 1; i >= 0; i--) {
      const entry = teardowns[i];
      try {
        logInfo(`[nas] Teardown: ${entry.name}`);
        if (entry.kind === "plan") {
          await teardownHandles(entry.handles);
        } else {
          if (entry.stage.teardown) {
            await entry.stage.teardown(entry.input);
          }
        }
      } catch (err) {
        console.error(
          `[nas] Teardown error in ${entry.name}: ${(err as Error).message}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Effect-based pipeline runner (Phase 3 target)
// ---------------------------------------------------------------------------

/**
 * Run a pipeline of EffectStage[] natively using Effect.gen.
 *
 * Teardown is handled by Effect's Scope — stages register finalizers via
 * Effect.acquireRelease / Effect.addFinalizer, and the caller uses
 * Effect.scoped to close the scope when the pipeline finishes.
 */
export function runPipelineEffect<
  const TStages extends readonly EffectStage<StageServices>[],
>(
  stages: TStages,
  input: StageInput,
): Effect.Effect<PriorStageOutputs, unknown, PipelineRequirements<TStages>> {
  // Cast is safe: TStages constrains which services are required at the
  // call site, but inside the loop TypeScript widens R to StageServices.
  const pipeline = Effect.gen(function* () {
    let prior: PriorStageOutputs = { ...input.prior };
    for (const stage of stages) {
      yield* Effect.sync(() => logInfo(`[nas] Running stage: ${stage.name}`));
      const currentInput: StageInput = { ...input, prior };
      const result: EffectStageResult = yield* stage.run(currentInput);
      prior = { ...prior, ...result };
    }
    return prior;
  });
  return pipeline as Effect.Effect<
    PriorStageOutputs,
    unknown,
    PipelineRequirements<TStages>
  >;
}
