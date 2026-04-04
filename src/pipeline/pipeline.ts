/**
 * Stage インターフェースとパイプライン実行
 */

import type { ExecutionContext } from "./context.ts";
import { logInfo } from "../log.ts";
import type {
  AnyStage,
  PriorStageOutputs,
  StageInput,
  StagePlan,
} from "./types.ts";
import { executePlan, teardownHandles } from "./effects.ts";
import type { ResourceHandle } from "./effects.ts";

/** 各ステージが実装するインターフェース */
export interface Stage {
  name: string;
  execute(ctx: ExecutionContext): Promise<ExecutionContext>;
  teardown?(ctx: ExecutionContext): Promise<void>;
}

/** ステージを順次実行するパイプライン。完了済みステージの teardown を逆順で呼ぶ。 */
export async function runPipeline(
  stages: Stage[],
  ctx: ExecutionContext,
): Promise<ExecutionContext> {
  const completed: Stage[] = [];
  let current = ctx;
  try {
    for (const stage of stages) {
      logInfo(`[nas] Running stage: ${stage.name}`);
      current = await stage.execute(current);
      completed.push(stage);
    }
    return current;
  } finally {
    for (const stage of completed.reverse()) {
      if (stage.teardown) {
        try {
          logInfo(`[nas] Teardown: ${stage.name}`);
          await stage.teardown(current);
        } catch (err) {
          console.error(
            `[nas] Teardown error in ${stage.name}: ${(err as Error).message}`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pipeline V2 — AnyStage runner
// ---------------------------------------------------------------------------

/** Merge a StagePlan's outputs into PriorStageOutputs. */
export function mergeOutputs(
  prior: PriorStageOutputs,
  plan: StagePlan,
): PriorStageOutputs {
  return {
    ...prior,
    ...plan.outputOverrides,
    dockerArgs: [...prior.dockerArgs, ...plan.dockerArgs],
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
export async function runPipelineV2(
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
      } else {
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
