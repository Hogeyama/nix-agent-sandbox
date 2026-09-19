import { Effect } from "effect";
import { filterDevcontainerAgentArgs } from "../../domain/devcontainer/agent_args.ts";
import type { DevcontainerRegistration } from "../../domain/devcontainer.ts";
import { logWarn } from "../../log.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import { ComposeSessionService } from "./compose_session_service.ts";
import { finalizeLaunchPlan } from "./plan.ts";

export interface ComposeStageOptions {
  readonly registration: DevcontainerRegistration;
  readonly agentExtraArgs?: readonly string[];
}

export function finalizeDevcontainerPlan(
  shared: StageInput,
  container: ContainerPlan,
  options: ComposeStageOptions,
) {
  const filtered = filterDevcontainerAgentArgs(
    shared.profile.agent,
    shared.profile.agentArgs,
  );
  if (filtered.dropped.length > 0)
    logWarn(
      `[nas] devcontainer dropped agentArgs the IDE session cannot use: ${filtered.dropped.join(" ")}`,
    );
  const finalized = finalizeLaunchPlan(
    {
      ...shared,
      profile: { ...shared.profile, agentArgs: [...filtered.kept] },
      container,
    },
    options.agentExtraArgs ?? [],
  );
  return {
    ...finalized,
    container: mergeContainerPlan(finalized.container, {
      env: {
        static: {
          NAS_DEVCONTAINER: "true",
          NAS_DEVCONTAINER_ENV_KEYS: [
            ...new Set(finalized.container.env.dynamicOps.map((op) => op.key)),
          ].join(" "),
        },
      },
      labels: {
        "devcontainer.local_folder": options.registration.workspace,
        "devcontainer.config_file": options.registration.configPath,
      },
    }),
  };
}

export function createComposeStage(
  shared: StageInput,
  options: ComposeStageOptions,
  // biome-ignore lint/complexity/noBannedTypes: terminal stage adds no slice.
): Stage<"container", {}, ComposeSessionService, Error> {
  return {
    name: "ComposeStage",
    needs: ["container"],
    run({ container }) {
      const plan = finalizeDevcontainerPlan(shared, container, options);
      return Effect.gen(function* () {
        const service = yield* ComposeSessionService;
        yield* service.serve({
          registration: options.registration,
          sessionId: shared.sessionId,
          containerName: plan.containerName,
          container: plan.container,
        });
        return {};
      });
    },
  };
}
