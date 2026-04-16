import { emptyContainerPlan } from "../pipeline/container_plan.ts";
import type { PipelineState, SliceKey } from "../pipeline/state.ts";

export function createCliInitialState(
  workDir: string,
  imageName: string,
  envVars: Readonly<Record<string, string>> = {},
): Pick<PipelineState, "workspace" | "container"> {
  return {
    workspace: {
      workDir,
      imageName,
    },
    container: {
      ...emptyContainerPlan(imageName, workDir),
      env: { static: { ...envVars }, dynamicOps: [] },
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
