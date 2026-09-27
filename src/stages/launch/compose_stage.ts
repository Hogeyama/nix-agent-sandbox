import { Effect } from "effect";
import { filterDevcontainerAgentArgs } from "../../domain/devcontainer/agent_args.ts";
import {
  type DevcontainerRegistration,
  renderDevcontainerMetadata,
} from "../../domain/devcontainer.ts";
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
          NAS_DEVCONTAINER_PRIMARY_AGENT: shared.profile.agent,
          NAS_DEVCONTAINER_ENV_KEYS: [
            ...new Set(finalized.container.env.dynamicOps.map((op) => op.key)),
          ].join(" "),
        },
      },
      labels: {
        "devcontainer.local_folder": options.registration.workspace,
        "devcontainer.config_file": options.registration.configPath,
        // Dev Containers CLI reads effective config (customizations,
        // remoteUser, ...) from this label once the container is already
        // running under nas's identifying labels, in place of
        // devcontainer.json — see renderDevcontainerMetadata. Compiling it
        // from the live profile on every launch is what lets a primary
        // agent or extraAgents change take effect on the next down/up
        // without a re-init.
        "devcontainer.metadata": JSON.stringify([
          renderDevcontainerMetadata(
            shared.profile,
            shared.host.user.trim() || "nas",
          ),
        ]),
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
