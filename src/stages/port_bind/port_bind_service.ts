import { readFile, rename, writeFile } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";
import { resolveAsset } from "../../lib/asset.ts";
import { safeRemove } from "../../lib/fs_utils.ts";
import { startPortBindBroker } from "../../network/port_bind_broker.ts";
import type { PortBinding } from "../../network/port_bind_protocol.ts";
import {
  relayScriptPath,
  removeSessionRegistry,
  resolvePortsRuntimePaths,
  writeSessionRegistry,
} from "../../network/port_bind_registry.ts";
import {
  type RelayGateway,
  startRelayGateway,
} from "../../network/port_bind_relay.ts";
import {
  makeRelaySupervisor,
  type RelaySupervisor,
} from "../../network/port_bind_supervisor.ts";
import { DockerService } from "../../services/docker.ts";
import type { PortBindPlan } from "./stage.ts";
import { CONTAINER_RELAY_SCRIPT, CONTAINER_RELAY_SOCKET } from "./stage.ts";

export interface PortBindHandle {
  readonly close: () => Effect.Effect<void>;
}

export class PortBindService extends Context.Tag("nas/PortBindStageService")<
  PortBindService,
  {
    readonly start: (plan: PortBindPlan) => Effect.Effect<PortBindHandle>;
  }
>() {}

async function copyRelayScript(target: string): Promise<void> {
  const sourcePath = resolveAsset(
    "docker/embed/port-relay.mjs",
    import.meta.url,
    "../../docker/embed/port-relay.mjs",
  );
  const tempPath = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    const source = await readFile(sourcePath);
    await writeFile(tempPath, source, { mode: 0o644 });
    await rename(tempPath, target);
  } finally {
    await safeRemove(tempPath);
  }
}

export const PortBindServiceLive: Layer.Layer<
  PortBindService,
  never,
  DockerService
> = Layer.effect(
  PortBindService,
  Effect.gen(function* () {
    const docker = yield* DockerService;

    return PortBindService.of({
      start: (plan) =>
        Effect.tryPromise({
          try: async () => {
            const paths = await resolvePortsRuntimePaths(plan.runtimeDir);
            await copyRelayScript(relayScriptPath(paths));

            let gateway: RelayGateway | undefined;
            let supervisor: RelaySupervisor;
            let controlWaiter:
              | { resolve: (connected: boolean) => void }
              | undefined;

            const waitForControl = (timeoutMs: number): Promise<boolean> => {
              if (gateway?.isRelayConnected()) return Promise.resolve(true);

              return new Promise((resolve) => {
                let settled = false;
                const finish = (connected: boolean) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  if (controlWaiter?.resolve === finish) {
                    controlWaiter = undefined;
                  }
                  resolve(connected);
                };
                const timer = setTimeout(() => finish(false), timeoutMs);
                controlWaiter = { resolve: finish };
                if (gateway?.isRelayConnected()) finish(true);
              });
            };

            try {
              gateway = await startRelayGateway({
                socketPath: plan.relaySocketSource,
                ensureRelay: () => supervisor.ensure(),
                onRelayConnected: () => controlWaiter?.resolve(true),
              });
              supervisor = makeRelaySupervisor({
                exec: (command) =>
                  Effect.runPromise(
                    docker.execDetached(plan.containerName, command, {
                      user: plan.relayUser,
                      env: {
                        NAS_PORT_RELAY_SOCKET: CONTAINER_RELAY_SOCKET,
                      },
                    }),
                  ),
                command: ["/usr/local/bin/bun", CONTAINER_RELAY_SCRIPT],
                isRelayConnected: gateway.isRelayConnected,
                waitForControl,
              });

              const persist = (bindings: PortBinding[]) =>
                writeSessionRegistry(paths, {
                  sessionId: plan.sessionId,
                  pid: process.pid,
                  brokerSocket: plan.controlSocket,
                  bindings,
                });
              const broker = await startPortBindBroker({
                controlSocketPath: plan.controlSocket,
                gateway,
                persist,
              });
              try {
                await persist([]);
              } catch (error) {
                await broker.close();
                throw error;
              }

              return {
                close: () =>
                  Effect.tryPromise({
                    try: async () => {
                      try {
                        await broker.close();
                      } finally {
                        await removeSessionRegistry(paths, plan.sessionId);
                      }
                    },
                    catch: (error) =>
                      new Error(
                        `PortBindService close failed: ${error instanceof Error ? error.message : String(error)}`,
                      ),
                  }).pipe(Effect.ignoreLogged),
              };
            } catch (error) {
              if (gateway) await gateway.close();
              throw error;
            }
          },
          catch: (error) =>
            new Error(
              `PortBindService start failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
        }).pipe(Effect.orDie),
    });
  }),
);

export interface PortBindServiceFakeConfig {
  readonly start?: (plan: PortBindPlan) => Effect.Effect<PortBindHandle>;
}

export function makePortBindServiceFake(
  overrides: PortBindServiceFakeConfig = {},
): Layer.Layer<PortBindService> {
  return Layer.succeed(
    PortBindService,
    PortBindService.of({
      start:
        overrides.start ?? (() => Effect.succeed({ close: () => Effect.void })),
    }),
  );
}
