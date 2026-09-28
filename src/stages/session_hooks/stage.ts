import * as path from "node:path";
import { Effect } from "effect";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { StageInput, StageResult } from "../../pipeline/types.ts";
import { SessionHooksService } from "./hooks_service.ts";
import { SESSION_HOOKS_DIR } from "./settings.ts";

export function createSessionHooksStage(
  shared: StageInput,
): Stage<"container", Pick<StageResult, "container">, SessionHooksService> {
  return {
    name: "SessionHooksStage",
    needs: ["container"],
    run(input) {
      if (!shared.profile.hook.enable) return Effect.succeed({});
      return Effect.gen(function* () {
        const service = yield* SessionHooksService;
        const sessionDir = path.join(
          resolveRuntimeSubdir(shared.host, "session-hooks"),
          shared.sessionId,
        );
        yield* service.prepare({
          sessionDir,
          agents: [shared.profile.agent, ...shared.profile.extraAgents],
        });
        return {
          container: mergeContainerPlan(input.container, {
            mounts: [
              {
                source: path.join(sessionDir, "assets"),
                target: SESSION_HOOKS_DIR,
                readOnly: true,
              },
            ],
            env: { static: { NAS_SESSION_HOOKS: "1" } },
          }),
        };
      });
    },
  };
}
