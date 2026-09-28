import * as path from "node:path";
import { Effect } from "effect";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { StageInput, StageResult } from "../../pipeline/types.ts";
import { AgentHooksService } from "./hooks_service.ts";
import { AGENT_HOOKS_DIR } from "./settings.ts";

export function createAgentHooksStage(
  shared: StageInput,
): Stage<"container", Pick<StageResult, "container">, AgentHooksService> {
  return {
    name: "AgentHooksStage",
    needs: ["container"],
    run(input) {
      const lifecycle = shared.profile.hook.enable;
      // The broker stage only contributes this path when filtering actually
      // started (enabled with at least one applied secret).
      const maskSocketPath = input.container.env.static.NAS_MASK_SOCKET;
      const agents = [
        shared.profile.agent,
        ...shared.profile.extraAgents,
      ].filter((agent) => lifecycle || (maskSocketPath && agent !== "claude"));
      if (agents.length === 0) return Effect.succeed({});
      return Effect.gen(function* () {
        const service = yield* AgentHooksService;
        const sessionDir = path.join(
          resolveRuntimeSubdir(shared.host, "agent-hooks"),
          shared.sessionId,
        );
        yield* service.prepare({
          sessionDir,
          agents: [...new Set(agents)],
          lifecycle,
          maskSocketPath,
        });
        return {
          container: mergeContainerPlan(input.container, {
            mounts: [
              {
                source: path.join(sessionDir, "assets"),
                target: AGENT_HOOKS_DIR,
                readOnly: true,
              },
            ],
            env: { static: { NAS_AGENT_HOOKS: "1" } },
          }),
        };
      });
    },
  };
}
