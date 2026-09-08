import { Effect } from "effect";
import { containerNameForSession } from "../../docker/nas_resources.ts";
import {
  brokerSocketPath,
  portsRuntimeDir,
  relayScriptPath,
  relaySocketPath,
} from "../../network/port_bind_registry.ts";
import type { InitialForward } from "../../network/port_forward_model.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { MountSpec, PipelineState } from "../../pipeline/state.ts";
import type { StageInput, StageResult } from "../../pipeline/types.ts";
import { reservedNamespacePorts } from "../dind.ts";
import { buildInitialForwards } from "./initial_forwards.ts";
import { PortBindService } from "./port_bind_service.ts";

export const CONTAINER_RELAY_SOCKET = "/run/nas-ports/relay.sock";
export const CONTAINER_RELAY_SCRIPT = "/usr/local/lib/nas/port-relay.mjs";

export type PortBindStageInput = StageInput &
  Pick<PipelineState, "container" | "observability">;

export interface PortBindPlan {
  readonly sessionId: string;
  readonly containerName: string;
  readonly runtimeDir: string;
  readonly relaySocketSource: string;
  readonly relayScriptSource: string;
  readonly controlSocket: string;
  readonly relayUser: string | undefined;
  readonly initialForwards: InitialForward[];
  /** Actual nas process listeners, separate from the initial forward mappings. */
  readonly reservedPorts: readonly number[];
  readonly mounts: readonly MountSpec[];
}

export function planPortBind(input: PortBindStageInput): PortBindPlan {
  const runtimeDir = portsRuntimeDir(
    input.host.env.get("XDG_RUNTIME_DIR"),
    input.host.uid ?? "unknown",
  );
  const paths = {
    runtimeDir,
    sessionsDir: `${runtimeDir}/sessions`,
    pendingDir: `${runtimeDir}/pending`,
    brokersDir: `${runtimeDir}/brokers`,
    relayDir: `${runtimeDir}/relay`,
  };
  const relaySocketSource = relaySocketPath(paths, input.sessionId);
  const relayScriptSource = relayScriptPath(paths, input.sessionId);

  return {
    sessionId: input.sessionId,
    containerName: containerNameForSession(input.sessionId),
    runtimeDir,
    relaySocketSource,
    relayScriptSource,
    controlSocket: brokerSocketPath(paths, input.sessionId),
    relayUser: input.host.uid === null ? undefined : String(input.host.uid),
    reservedPorts: reservedNamespacePorts([], input.profile.docker.enable),
    initialForwards: buildInitialForwards(
      [
        ...input.profile.network.localForwards.map((pair) => ({
          ...pair,
          direction: "local" as const,
        })),
        ...input.profile.network.remoteForwards.map((pair) => ({
          ...pair,
          direction: "remote" as const,
        })),
      ],
      input.observability.enabled ? input.observability.receiverPort : null,
    ),
    mounts: [
      {
        source: relaySocketSource,
        target: CONTAINER_RELAY_SOCKET,
        readOnly: true,
      },
      {
        source: relayScriptSource,
        target: CONTAINER_RELAY_SCRIPT,
        readOnly: true,
      },
    ],
  };
}

export function createPortBindStage(
  shared: StageInput,
): Stage<
  "container" | "observability",
  Pick<StageResult, "container">,
  PortBindService,
  unknown
> {
  return {
    name: "PortBindStage",
    needs: ["container", "observability"],
    run(input) {
      return Effect.gen(function* () {
        const plan = yield* Effect.try({
          try: () => planPortBind({ ...shared, ...input }),
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        });
        const service = yield* PortBindService;
        yield* Effect.acquireRelease(service.start(plan), (handle) =>
          handle.close(),
        );
        return {
          container: mergeContainerPlan(input.container, {
            mounts: plan.mounts,
            ...(plan.initialForwards.length > 0
              ? {
                  env: {
                    static: {
                      NAS_PORT_RELAY_STARTUP: "1",
                      NAS_PORT_RELAY_SOCKET: CONTAINER_RELAY_SOCKET,
                    },
                  },
                }
              : {}),
          }),
        };
      });
    },
  };
}
