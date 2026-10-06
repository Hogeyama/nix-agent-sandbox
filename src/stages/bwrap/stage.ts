import * as path from "node:path";
import { Effect } from "effect";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { PipelineState } from "../../pipeline/state.ts";
import type { StageInput, StageResult } from "../../pipeline/types.ts";
import { BwrapService } from "./bwrap_service.ts";
import { bwrapSeccompProfile } from "./seccomp_profile.ts";

export type BwrapStageInput = StageInput & Pick<PipelineState, "container">;

export interface BwrapPlan {
  /** Session directory: `<runtime>/bwrap/<sessionId>`. */
  readonly sessionDir: string;
  readonly seccompProfile: string;
}

export function planBwrap(input: BwrapStageInput): BwrapPlan | null {
  if (!input.profile.bwrap.support) return null;
  return {
    sessionDir: path.join(
      resolveRuntimeSubdir(input.host, "bwrap"),
      input.sessionId,
    ),
    seccompProfile: bwrapSeccompProfile(),
  };
}

export function createBwrapStage(
  shared: StageInput,
): Stage<"container", Pick<StageResult, "container">, BwrapService, unknown> {
  return {
    name: "BwrapStage",
    needs: ["container"],
    run(input) {
      return Effect.gen(function* () {
        const plan = planBwrap({ ...shared, ...input });
        if (plan === null) return { container: input.container };

        const service = yield* BwrapService;
        const handle = yield* Effect.acquireRelease(
          service.write(plan),
          (handle) =>
            handle
              .close()
              .pipe(
                Effect.catchAll(() =>
                  Effect.logWarning("bwrap cleanup failed"),
                ),
              ),
        );

        return {
          container: mergeContainerPlan(input.container, {
            seccompProfile: handle.seccompProfilePath,
            // Docker's docker-default AppArmor profile denies mount, which
            // bubblewrap needs, on hosts that enable AppArmor (Debian, Ubuntu).
            apparmorProfile: "unconfined",
          }),
        };
      });
    },
  };
}
