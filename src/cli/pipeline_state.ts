import { Effect } from "effect";
import type { PipelineState, SliceKey } from "../pipeline/state.ts";
import type { Stage as PipelineStateStage } from "../pipeline/stage_builder.ts";
import type {
  EffectStage,
  EffectStageResult,
  PriorStageOutputs,
  StageInput,
  StageServices,
} from "../pipeline/types.ts";

export function createCliInitialState(
  workDir: string,
  imageName: string,
): Pick<PipelineState, "workspace"> {
  return {
    workspace: {
      workDir,
      imageName,
    },
  };
}

export function pickPipelineStateSlices<Keys extends SliceKey>(
  result: Partial<PipelineState>,
  ...keys: readonly Keys[]
): Pick<PipelineState, Keys> {
  const slices = {} as Pick<PipelineState, Keys>;

  for (const key of keys) {
    const value = result[key];
    if (value === undefined) {
      throw new Error(
        `[nas] Legacy stage did not produce required pipeline slice "${key}"`,
      );
    }
    slices[key] = value;
  }

  return slices;
}

export function pickDindStageSlices(
  result: EffectStageResult,
  prior: Partial<PipelineState>,
): Pick<PipelineState, "container"> & Partial<Pick<PipelineState, "dind">> {
  const container = pickPipelineStateSlices(prior, "container");

  if (result.dind === undefined) {
    return container;
  }

  return {
    ...container,
    ...pickPipelineStateSlices(prior, "dind"),
  };
}

export function pickProxyStageSlices(
  result: EffectStageResult,
  prior: Partial<PipelineState>,
): Pick<PipelineState, "container"> &
  Partial<Pick<PipelineState, "network" | "prompt" | "proxy">> {
  const container = pickPipelineStateSlices(prior, "container");

  if (
    result.network === undefined &&
    result.prompt === undefined &&
    result.proxy === undefined
  ) {
    return container;
  }

  return {
    ...container,
    ...pickPipelineStateSlices(prior, "network", "prompt", "proxy"),
  };
}

export interface EffectStagePipelineAdapter<
  Needs extends SliceKey,
  Adds extends Partial<PipelineState>,
  R extends StageServices = never,
> {
  readonly stage: EffectStage<R>;
  readonly needs: readonly Needs[];
  readonly pickAdds: (
    result: EffectStageResult,
    prior: PriorStageOutputs & Partial<PipelineState>,
  ) => Adds;
}

export function adaptEffectStageToPipelineStateStage<
  Needs extends SliceKey,
  Adds extends Partial<PipelineState>,
  R extends StageServices = never,
>(
  config: EffectStagePipelineAdapter<Needs, Adds, R>,
  shared: Omit<StageInput, "prior">,
  priorRef: { current: PriorStageOutputs & Partial<PipelineState> },
): PipelineStateStage<Needs, Adds, R, unknown> {
  return {
    name: config.stage.name,
    needs: config.needs,
    run(input) {
      priorRef.current = { ...priorRef.current, ...input };

      return config.stage.run({ ...shared, prior: priorRef.current }).pipe(
        Effect.map((result) => {
          priorRef.current = { ...priorRef.current, ...result };
          return config.pickAdds(result, priorRef.current);
        }),
      );
    },
  };
}
