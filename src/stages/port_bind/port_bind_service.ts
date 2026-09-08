import { readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import { resolveAsset } from "../../lib/asset.ts";
import { ensureDir, safeRemove } from "../../lib/fs_utils.ts";
import {
  type PersistedPorts,
  type PortBindBroker,
  startPortBindBroker,
} from "../../network/port_bind_broker.ts";
import { PORT_BIND_PROTOCOL_VERSION } from "../../network/port_bind_protocol.ts";
import {
  relayScriptPath,
  removeSessionRegistry,
  resolvePortsRuntimePaths,
  sessionRelayDir,
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
    readonly start: (
      plan: PortBindPlan,
    ) => Effect.Effect<PortBindHandle, Error>;
  }
>() {}

async function copyRelayScript(target: string): Promise<void> {
  const sourcePath = resolveAsset(
    "docker/embed/port-relay.mjs",
    import.meta.url,
    "../../docker/embed/port-relay.mjs",
  );
  await ensureDir(path.dirname(target));
  const tempPath = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    const source = await readFile(sourcePath);
    await writeFile(tempPath, source, { mode: 0o644 });
    await rename(tempPath, target);
  } finally {
    await safeRemove(tempPath);
  }
}

type Paths = Awaited<ReturnType<typeof resolvePortsRuntimePaths>>;

/** @internal Startup registry writer shared with the colocated GC regression. */
export async function registerPortBindStartup(
  paths: Paths,
  plan: PortBindPlan,
): Promise<void> {
  await writeSessionRegistry(paths, {
    protocolVersion: PORT_BIND_PROTOCOL_VERSION,
    sessionId: plan.sessionId,
    pid: process.pid,
    // The control socket does not exist until broker startup. The copied
    // script is the existing per-session liveness path that keeps concurrent
    // runtime GC from deleting startup resources.
    brokerSocket: relayScriptPath(paths, plan.sessionId),
    bindings: [],
    forwards: [],
    portForwards: [],
  });
}

type GatewayOptions = Parameters<typeof startRelayGateway>[0];
type BrokerOptions = Parameters<typeof startPortBindBroker>[0];

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });

/** @internal Primitive seam for the colocated lifecycle tests. */
export class PortBindOps extends Context.Tag("nas/PortBindOps")<
  PortBindOps,
  {
    paths: (runtimeDir: string) => Effect.Effect<Paths, Error>;
    copyScript: (target: string) => Effect.Effect<void, Error>;
    registerStartup: (
      paths: Paths,
      plan: PortBindPlan,
    ) => Effect.Effect<void, Error>;
    persist: (
      paths: Paths,
      plan: PortBindPlan,
      ports: PersistedPorts,
    ) => Effect.Effect<void, Error>;
    gateway: (options: GatewayOptions) => Effect.Effect<RelayGateway, Error>;
    broker: (options: BrokerOptions) => Effect.Effect<PortBindBroker, Error>;
    prepare: (
      broker: PortBindBroker,
      entries: PortBindPlan["initialForwards"],
    ) => Effect.Effect<void, Error>;
    waitForControl: (
      isConnected: () => boolean,
      register: (done: (connected: boolean) => void) => void,
      timeoutMs: number,
    ) => Effect.Effect<boolean, Error>;
    execRelay: (
      plan: PortBindPlan,
      command: string[],
    ) => Effect.Effect<{ code: number; stderr: string }, Error>;
    closeBroker: (broker: PortBindBroker) => Effect.Effect<void, Error>;
    closeGateway: (gateway: RelayGateway) => Effect.Effect<void, Error>;
    removeRegistry: (
      paths: Paths,
      sessionId: string,
    ) => Effect.Effect<void, Error>;
    removeRelay: (
      paths: Paths,
      sessionId: string,
    ) => Effect.Effect<void, Error>;
  }
>() {}

/** @internal Composed lifecycle; all I/O is provided through PortBindOps. */
export function startPortBind(
  plan: PortBindPlan,
): Effect.Effect<PortBindHandle, Error, PortBindOps> {
  return Effect.gen(function* () {
    const ops = yield* PortBindOps;
    const paths = yield* ops.paths(plan.runtimeDir);
    let gateway: RelayGateway | undefined;
    let broker: PortBindBroker | undefined;
    let supervisor: RelaySupervisor;
    // Failed startup keeps exec suppressed until the pipeline tears down.
    let initialRelayStarting = plan.initialForwards.length > 0;
    let controlWaiter: ((connected: boolean) => void) | undefined;
    const waitForControl = (timeoutMs: number): Promise<boolean> =>
      Effect.runPromise(
        ops.waitForControl(
          () => gateway?.isRelayConnected() ?? false,
          (done) => {
            controlWaiter = done;
          },
          timeoutMs,
        ),
      );
    const cleanup = Effect.gen(function* () {
      controlWaiter?.(false);
      if (broker)
        yield* ops.closeBroker(broker).pipe(
          Effect.onError(() =>
            gateway
              ? ops.closeGateway(gateway).pipe(Effect.ignoreLogged)
              : Effect.void,
          ),
          Effect.ignoreLogged,
        );
      else if (gateway)
        yield* ops.closeGateway(gateway).pipe(Effect.ignoreLogged);
      yield* ops
        .removeRegistry(paths, plan.sessionId)
        .pipe(Effect.ignoreLogged);
      yield* ops.removeRelay(paths, plan.sessionId).pipe(Effect.ignoreLogged);
    });
    return yield* Effect.gen(function* () {
      yield* ops.copyScript(relayScriptPath(paths, plan.sessionId));
      yield* ops.registerStartup(paths, plan);
      gateway = yield* ops.gateway({
        socketPath: plan.relaySocketSource,
        ensureRelay: () => supervisor.ensure(),
        onRelayConnected: () => {
          controlWaiter?.(true);
          broker?.onRelayConnected();
        },
        onRelayUnsupported: () => controlWaiter?.(false),
        currentForwards: () =>
          broker
            ?.listPortForwards()
            .filter((entry) => entry.direction === "remote") ?? [],
        onForwardState: (port, state, error) =>
          broker?.onForwardState(port, state, error),
      });
      supervisor = makeRelaySupervisor({
        exec: (command) => Effect.runPromise(ops.execRelay(plan, command)),
        command: ["/usr/local/bin/bun", CONTAINER_RELAY_SCRIPT],
        isRelayConnected: gateway.isRelayConnected,
        isInitialRelayStarting: () => initialRelayStarting,
        waitForControl,
      });
      broker = yield* ops.broker({
        controlSocketPath: plan.controlSocket,
        gateway,
        persist: (ports) => Effect.runPromise(ops.persist(paths, plan, ports)),
        reservedPorts: plan.reservedPorts,
        onInitialComplete: (error) => {
          if (error === undefined) initialRelayStarting = false;
        },
      });
      yield* ops.prepare(broker, plan.initialForwards);
      return { close: () => cleanup };
    }).pipe(Effect.onError(() => cleanup));
  });
}

export const PortBindServiceLive: Layer.Layer<
  PortBindService,
  never,
  DockerService
> = Layer.effect(
  PortBindService,
  Effect.gen(function* () {
    const docker = yield* DockerService;
    const ops = Layer.succeed(PortBindOps, {
      paths: (runtimeDir) =>
        attempt(() => resolvePortsRuntimePaths(runtimeDir)),
      copyScript: (target) => attempt(() => copyRelayScript(target)),
      registerStartup: (paths, plan) =>
        attempt(() => registerPortBindStartup(paths, plan)),
      persist: (paths, plan, ports) =>
        attempt(() =>
          writeSessionRegistry(paths, {
            sessionId: plan.sessionId,
            pid: process.pid,
            brokerSocket: plan.controlSocket,
            ...ports,
          }),
        ),
      gateway: (options) => attempt(() => startRelayGateway(options)),
      broker: (options) => attempt(() => startPortBindBroker(options)),
      prepare: (broker, entries) =>
        attempt(() => broker.prepareInitial(entries)),
      waitForControl: (isConnected, register, timeoutMs) =>
        attempt(
          () =>
            new Promise((resolve) => {
              const finish = (connected: boolean) => {
                clearTimeout(timer);
                resolve(connected);
              };
              const timer = setTimeout(() => finish(false), timeoutMs);
              register(finish);
              if (isConnected()) finish(true);
            }),
        ),
      execRelay: (plan, command) =>
        docker.execDetached(plan.containerName, command, {
          user: plan.relayUser,
          env: { NAS_PORT_RELAY_SOCKET: CONTAINER_RELAY_SOCKET },
        }),
      closeBroker: (broker) => attempt(() => broker.close()),
      closeGateway: (gateway) => attempt(() => gateway.close()),
      removeRegistry: (paths, sessionId) =>
        attempt(() => removeSessionRegistry(paths, sessionId)),
      removeRelay: (paths, sessionId) =>
        attempt(() =>
          safeRemove(sessionRelayDir(paths, sessionId), { recursive: true }),
        ),
    });
    return PortBindService.of({
      start: (plan) => startPortBind(plan).pipe(Effect.provide(ops)),
    });
  }),
);

export interface PortBindServiceFakeConfig {
  readonly start?: (plan: PortBindPlan) => Effect.Effect<PortBindHandle, Error>;
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
