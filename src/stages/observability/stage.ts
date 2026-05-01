/**
 * ObservabilityStage — materializes the `observability` slice of PipelineState.
 *
 * What this stage does:
 *   - Produces the disabled fast-path slice `{ enabled: false }`.
 *   - Holds no resources; the run effect is pure.
 *
 * What this stage does not do:
 *   - Does not read `config.observability` values.
 *   - Does not acquire listeners, allocate ports, or inject OTLP env.
 *     The enabled branch is not implemented here.
 *
 * Pipeline placement: after `HostExecStage`. At this position the slice is
 * materialized before any downstream stage that consumes observability runs,
 * so consumers can rely on the slice being present.
 */

import { Effect } from "effect";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { StageResult } from "../../pipeline/types.ts";

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

/**
 * Compute the observability slice.
 *
 * Returns the disabled fast-path. The function takes no inputs: the slice
 * shape and discriminant are fixed at this stage and do not depend on config.
 */
export function planObservability(): { readonly enabled: false } {
  return { enabled: false };
}

// ---------------------------------------------------------------------------
// EffectStage
// ---------------------------------------------------------------------------

export function createObservabilityStage(): Stage<
  never,
  Pick<StageResult, "observability">
> {
  return {
    name: "ObservabilityStage",
    needs: [],
    run: () =>
      Effect.succeed({
        observability: planObservability(),
      }),
  };
}
