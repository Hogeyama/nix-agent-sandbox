/**
 * Pipeline 実行
 */

import { Effect } from "effect";
import { logInfo } from "../log.ts";
import type {
  EffectStage,
  EffectStageResult,
  PipelineRequirements,
  PriorStageOutputs,
  StageInput,
  StageServices,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Effect-based pipeline runner
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
