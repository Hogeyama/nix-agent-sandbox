/**
 * Pipeline 実行
 */

import { Effect, type Scope } from "effect";
import { logInfo } from "../log.ts";
import type { Stage as PipelineStateStage } from "./stage_builder.ts";
import type { PipelineState, SliceKey } from "./state.ts";
import type { StageServices } from "./types.ts";

type AnyPipelineStateStage = PipelineStateStage<
  SliceKey,
  Partial<PipelineState>,
  StageServices,
  unknown
>;

type PipelineStateStageServicesOf<TStage extends AnyPipelineStateStage> =
  TStage extends PipelineStateStage<
    SliceKey,
    Partial<PipelineState>,
    infer R extends StageServices,
    unknown
  >
    ? R
    : never;

type PipelineStateStageErrorOf<TStage extends AnyPipelineStateStage> =
  TStage extends PipelineStateStage<
    SliceKey,
    Partial<PipelineState>,
    StageServices,
    infer E
  >
    ? E
    : never;

export type PipelineStateRequirements<
  TStages extends readonly AnyPipelineStateStage[],
> = Scope.Scope | PipelineStateStageServicesOf<TStages[number]>;

export type PipelineStateErrors<
  TStages extends readonly AnyPipelineStateStage[],
> = PipelineStateStageErrorOf<TStages[number]>;

function pickPipelineStateInput<Needs extends SliceKey>(
  stage: PipelineStateStage<
    Needs,
    Partial<PipelineState>,
    StageServices,
    unknown
  >,
  current: Partial<PipelineState>,
): Pick<PipelineState, Needs> {
  const input = {} as Pick<PipelineState, Needs>;

  for (const need of stage.needs) {
    const value = current[need];
    if (value === undefined) {
      throw new Error(
        `Stage "${stage.name}" requires missing pipeline slice "${need}"`,
      );
    }

    input[need] = value;
  }

  return input;
}

export function runPipelineState<
  const TStages extends readonly AnyPipelineStateStage[],
  TInitial extends Partial<PipelineState>,
>(
  stages: TStages,
  initial: TInitial,
): Effect.Effect<
  TInitial & Partial<PipelineState>,
  PipelineStateErrors<TStages>,
  PipelineStateRequirements<TStages>
> {
  const pipeline = Effect.gen(function* () {
    let current: Partial<PipelineState> = { ...initial };

    for (const stage of stages) {
      yield* Effect.sync(() => logInfo(`[nas] Running stage: ${stage.name}`));
      const stageInput = pickPipelineStateInput(stage, current);
      const result = yield* stage.run(stageInput);
      current = { ...current, ...result };
    }

    return current;
  });

  return pipeline as Effect.Effect<
    TInitial & Partial<PipelineState>,
    PipelineStateErrors<TStages>,
    PipelineStateRequirements<TStages>
  >;
}
