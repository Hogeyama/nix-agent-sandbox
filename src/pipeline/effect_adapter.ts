import { Effect, Exit, type Layer, Scope } from "effect";
import type {
  AnyStage,
  EffectStage,
  PlanStage,
  ProceduralStage,
  StageInput,
  StageServices,
} from "./types.ts";

/**
 * Wraps an EffectStage as a ProceduralStage so it can be used with the
 * existing runPipeline during the migration period.
 *
 * A manually-managed Scope is created in execute() and closed in teardown(),
 * so that resources acquired via Effect.acquireRelease survive until
 * the pipeline calls teardown().
 */
export function effectStageAdapter(
  stage: EffectStage<StageServices>,
  layer: Layer.Layer<StageServices>,
): ProceduralStage {
  let closeScope: Effect.Effect<void> | undefined;

  return {
    kind: "procedural",
    name: stage.name,
    async execute(input: StageInput) {
      const scope = Effect.runSync(Scope.make());
      closeScope = Scope.close(scope, Exit.void);

      const effect = stage
        .run(input)
        .pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(layer));
      const outputOverrides = await Effect.runPromise(effect);
      return { outputOverrides };
    },
    async teardown() {
      if (closeScope) {
        await Effect.runPromise(closeScope);
        closeScope = undefined;
      }
    },
  };
}

/**
 * Adapts a mixed array of AnyStage[] so that EffectStages are wrapped
 * as ProceduralStages, letting the existing runPipeline execute them.
 */
export function adaptStages(
  stages: readonly AnyStage[],
  layer: Layer.Layer<StageServices>,
): (PlanStage | ProceduralStage)[] {
  return stages.map((s) =>
    s.kind === "effect" ? effectStageAdapter(s, layer) : s,
  );
}
