import { connect, createServer, type Server, type Socket } from "node:net";
import { safeRemove } from "../lib/fs_utils.ts";
import {
  createUnixServer,
  readJsonLine,
  writeJsonLine,
} from "../lib/unix_socket.ts";
import { logDebug } from "../log.ts";
import {
  type ControlErrorKind,
  type ControlRequest,
  type ControlResponse,
  type HostProbeResult,
  isReachableScope,
  type ListenerWatchState,
  MAX_CONTROL_BYTES,
  type PortBindCandidate,
  type PortBinding,
  type PortForward,
  type ProbeResult,
  projectPortForwards,
} from "./port_bind_protocol.ts";
import {
  pipeSockets,
  type RelayGateway,
  RelayNotReadyError,
} from "./port_bind_relay.ts";

import {
  type AddForwardResult,
  copyManagedForward,
  createsForwardCycle,
  type ForwardOwner,
  type ForwardSpec,
  type ForwardState,
  forwardKey,
  type InitialForward,
  type ManagedForward,
  type RemoveForwardResult,
  removeUserOwners,
} from "./port_forward_model.ts";

const HOST = "127.0.0.1";
const MAX_CANDIDATES = 65;
const MAX_PORT = 65_535;
const HOST_PROBE_TIMEOUT_MS = 1_000;
/**
 * How long one `candidates` request keeps the container-side scan running.
 * Interest is expressed by asking, not by an explicit subscription, so a
 * client that dies simply stops renewing and the scan stops on its own.
 */
const WATCH_LEASE_MS = 30_000;

export class ControlError extends Error {
  constructor(
    readonly kind: ControlErrorKind,
    message: string,
  ) {
    super(`${kind}: ${message}`);
    this.name = "ControlError";
  }
}

export function hostPortCandidates(
  containerPort: number,
  requested: number | null,
): number[] {
  if (requested !== null) return [requested];
  const candidates = [containerPort];
  let next = Math.max(containerPort + 1, 1024);
  while (candidates.length < MAX_CANDIDATES && next <= MAX_PORT) {
    candidates.push(next);
    next += 1;
  }
  return candidates;
}

/** Everything the session registry records about open ports. */
export interface PersistedPorts {
  portForwards: ManagedForward[];
  bindings: PortBinding[];
  forwards: PortForward[];
}

export interface PortBindBroker {
  readonly controlSocketPath: string;
  listPortForwards(): ManagedForward[];
  prepareInitial(entries: readonly InitialForward[]): Promise<void>;
  onRelayConnected(): void;
  onForwardState(
    containerPort: number,
    state: ForwardState,
    error?: string,
  ): void;
  addPortForward(
    spec: ForwardSpec,
    owner: ForwardOwner,
  ): Promise<AddForwardResult>;
  removePortForward(
    key: Pick<ForwardSpec, "direction" | "containerPort">,
  ): Promise<RemoveForwardResult>;
  bind(req: {
    containerPort: number;
    hostPort: number | null;
  }): Promise<{ hostPort: number; probe: ProbeResult }>;
  unbind(key: { containerPort?: number; hostPort?: number }): Promise<void>;
  listBindings(): PortBinding[];
  /**
   * Make a host loopback port reachable inside the container. Unlike `bind`,
   * this needs the relay: the listener lives in the container, so a session
   * whose container is not running cannot forward yet.
   */
  forward(req: { containerPort: number; hostPort: number }): Promise<{
    containerPort: number;
    hostPort: number;
    hostProbe: HostProbeResult;
  }>;
  unforward(containerPort: number): Promise<void>;
  listForwards(): PortForward[];
  /**
   * Container ports seen listening that no binding covers yet. Asking also
   * starts (and renews the lease on) the container-side scan.
   */
  candidates(): Promise<{
    candidates: PortBindCandidate[];
    watch: ListenerWatchState;
  }>;
  close(): Promise<void>;
}

interface OpenBinding {
  binding: PortBinding;
  server: Server;
  connections: Set<Socket>;
}

function validPort(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_PORT
  );
}

function hasKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    expected.every((key, index) => actual[index] === key)
  );
}

function parseControlRequest(line: string): ControlRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ControlError("invalid-request", "request must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlError("invalid-request", "request must be an object");
  }

  const request = value as Record<string, unknown>;
  if (
    request.type === "bind" &&
    hasKeys(request, ["containerPort", "hostPort", "type"]) &&
    validPort(request.containerPort) &&
    (request.hostPort === null ||
      request.hostPort === 0 ||
      validPort(request.hostPort))
  ) {
    return request as ControlRequest;
  }
  if (
    request.type === "unbind" &&
    hasKeys(request, ["containerPort", "type"]) &&
    validPort(request.containerPort)
  ) {
    return request as ControlRequest;
  }
  if (
    request.type === "unbind" &&
    hasKeys(request, ["hostPort", "type"]) &&
    validPort(request.hostPort)
  ) {
    return request as ControlRequest;
  }
  if (request.type === "candidates" && hasKeys(request, ["type"])) {
    return request as ControlRequest;
  }
  if (
    request.type === "forward" &&
    hasKeys(request, ["containerPort", "hostPort", "type"]) &&
    validPort(request.containerPort) &&
    validPort(request.hostPort)
  ) {
    return request as ControlRequest;
  }
  if (
    request.type === "unforward" &&
    hasKeys(request, ["containerPort", "type"]) &&
    validPort(request.containerPort)
  ) {
    return request as ControlRequest;
  }
  throw new ControlError("invalid-request", "request shape is invalid");
}

/** One dial of the host port, so the user learns now if nothing is there. */
function probeHostPort(hostPort: number): Promise<HostProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port: hostPort });
    const finish = (result: HostProbeResult) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("no-answer"), HOST_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish("ok"));
    socket.once("error", () => finish("no-answer"));
  });
}

export async function startPortBindBroker(opts: {
  controlSocketPath: string;
  gateway: RelayGateway;
  persist: (ports: PersistedPorts) => Promise<void>;
  now?: () => Date;
  /**
   * Ports nas itself binds inside the container's network namespace (the DinD
   * daemon and the local proxy). They are always listening and
   * are never something the user wants exposed, so they never get suggested.
   */
  reservedPorts?: readonly number[];
  watchLeaseMs?: number;
  onInitialComplete?: (error?: string) => void;
}): Promise<PortBindBroker> {
  const now = opts.now ?? (() => new Date());
  const reserved = new Set(opts.reservedPorts ?? []);
  const watchLeaseMs = opts.watchLeaseMs ?? WATCH_LEASE_MS;
  const open = new Map<number, OpenBinding>();
  const managed = new Map<string, ManagedForward>();
  const generations = new Map<string, symbol>();
  let watchLease: ReturnType<typeof setTimeout> | undefined;
  let mutationTail = Promise.resolve();
  let closing = false;
  let initial: "idle" | "pending" | "ready" | "failed" = "idle";

  const listPortForwards = (): ManagedForward[] =>
    [...managed.values()].map(copyManagedForward);
  const snapshot = (): PortBinding[] =>
    projectPortForwards(listPortForwards()).bindings;
  const persist = () => {
    const portForwards = listPortForwards();
    return opts.persist({ portForwards, ...projectPortForwards(portForwards) });
  };
  // Registry failures never become authority to restore revoked connections.
  const persistRevocation = async () => {
    try {
      await persist();
    } catch (error) {
      await persist().catch((retryError) =>
        logDebug(`[nas] port-forward registry retry failed: ${retryError}`),
      );
      throw error;
    }
  };

  const mutate = <T>(action: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error("broker is closed"));
    const result = mutationTail.then(action);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const mutateUser = <T>(action: () => Promise<T>): Promise<T> => {
    if (initial === "pending" || initial === "failed") {
      return Promise.reject(
        new ControlError(
          "relay-unavailable",
          "initial forwarding is not ready",
        ),
      );
    }
    return mutate(action);
  };

  // Runs on the mutation queue, never inside gateway ACK processing.
  const failInitial = async (error: unknown) => {
    if (initial !== "pending") return;
    initial = "failed";
    const entries = [...managed.values()];
    managed.clear();
    generations.clear();
    const locals = [...open.values()];
    open.clear();
    await Promise.allSettled([
      ...locals.map(closeBinding),
      ...entries
        .filter((entry) => entry.direction === "remote")
        .map((entry) => opts.gateway.unforward(entry.containerPort)),
    ]);
    await persist().catch((persistError) =>
      logDebug(`[nas] initial forwarding rollback: ${persistError}`),
    );
    const reason = error instanceof Error ? error.message : String(error);
    if (opts.gateway.isRelayConnected()) {
      try {
        opts.gateway.completeInitialForwards(reason);
      } catch (notifyError) {
        // The relay can disconnect between the readiness check and write.
        logDebug(`[nas] initial failure notification: ${notifyError}`);
      }
    }
    opts.onInitialComplete?.(reason);
  };

  const completeInitial = () => {
    if (initial !== "pending" || !opts.gateway.isRelayConnected()) return;
    if ([...managed.values()].some((entry) => entry.state !== "active")) return;
    initial = "ready";
    opts.gateway.completeInitialForwards();
    opts.onInitialComplete?.();
  };

  const onRelayConnected = () => {
    if (initial !== "pending") return;
    void mutate(async () => completeInitial()).catch((error) =>
      logDebug(`[nas] initial connection: ${error}`),
    );
  };

  const onForwardState: PortBindBroker["onForwardState"] = (
    containerPort,
    state,
    error,
  ) => {
    const key = forwardKey({ direction: "remote", containerPort });
    const generation = generations.get(key);
    if (!generation || closing) return;
    void mutate(async () => {
      const entry = managed.get(key);
      // Capture before queueing: remove/re-add may run ahead of this event.
      if (!entry || generations.get(key) !== generation) return;
      entry.state = state;
      if (error === undefined) delete entry.error;
      else entry.error = error;
      if (initial === "pending") {
        if (state === "failed" || state === "unavailable") {
          await failInitial(
            new Error(error ?? `initial forwarding ${containerPort} ${state}`),
          );
          return;
        }
        try {
          await persist();
          completeInitial();
        } catch (error) {
          await failInitial(error);
        }
      } else await persistRevocation();
    }).catch((error) => logDebug(`[nas] port-forward state: ${error}`));
  };

  const listenOn = (
    hostPort: number,
    containerPort: number,
    connections: Set<Socket>,
  ): Promise<Server> =>
    new Promise((resolve, reject) => {
      const server = createServer({ allowHalfOpen: true }, (browser) => {
        let pendingChunk: Buffer | undefined;
        const holdFirstChunk = (chunk: Buffer) => {
          pendingChunk = chunk;
          browser.pause();
        };
        browser.once("data", holdFirstChunk);
        connections.add(browser);
        browser.on("close", () => connections.delete(browser));
        browser.on("error", () => browser.destroy());
        const abort = new AbortController();
        browser.once("close", () => abort.abort());
        opts.gateway
          .openStream(containerPort, abort.signal)
          .then((stream) => {
            browser.off("data", holdFirstChunk);
            if (browser.destroyed) stream.destroy();
            else {
              pipeSockets(browser, stream);
              if (pendingChunk) stream.write(pendingChunk);
              browser.resume();
            }
          })
          .catch((error) => {
            logDebug(`[nas] port-bind: ${containerPort} unreachable: ${error}`);
            browser.destroy();
          });
      });
      server.once("error", reject);
      server.listen(hostPort, HOST, () => {
        server.removeListener("error", reject);
        server.on("error", (error) =>
          logDebug(`[nas] port-bind listener ${hostPort}: ${error}`),
        );
        resolve(server);
      });
    });

  const closeBinding = async (entry: OpenBinding): Promise<void> => {
    for (const socket of entry.connections) socket.destroy();
    entry.connections.clear();
    await new Promise<void>((resolve, reject) => {
      entry.server.close((error) => (error ? reject(error) : resolve()));
    });
  };

  const validateSpec = (spec: ForwardSpec) => {
    if (
      (spec.direction !== "local" && spec.direction !== "remote") ||
      !validPort(spec.containerPort) ||
      !validPort(spec.hostPort)
    ) {
      throw new ControlError(
        "invalid-request",
        "direction and ports are invalid",
      );
    }
  };

  const probe = async (spec: ForwardSpec): Promise<ProbeResult> => {
    try {
      return spec.direction === "local"
        ? await opts.gateway.probe(spec.containerPort)
        : await probeHostPort(spec.hostPort);
    } catch (error) {
      if (error instanceof RelayNotReadyError) {
        return error.reason === "container-not-running"
          ? "container-not-running"
          : "relay-unreachable";
      }
      return "no-answer";
    }
  };

  // Called only under mutationTail, including the legacy automatic-port adapter.
  const add = async (
    spec: ForwardSpec,
    owner: ForwardOwner,
    prepared?: OpenBinding,
  ): Promise<AddForwardResult> => {
    let acquired = prepared;
    let inserted = false;
    const key = forwardKey(spec);
    try {
      validateSpec(spec);
      if (!["config", "dynamic", "internal"].includes(owner)) {
        throw new ControlError("invalid-request", "invalid forward owner");
      }
      const existing = managed.get(key);
      if (existing) {
        if (existing.hostPort !== spec.hostPort) {
          throw new ControlError(
            "binding-conflict",
            `container port ${spec.containerPort} already maps to host port ${existing.hostPort}`,
          );
        }
        if (!existing.owners.includes(owner)) {
          const updated = { ...existing, owners: [...existing.owners, owner] };
          managed.set(key, updated);
          try {
            await persist();
          } catch (error) {
            managed.set(key, existing);
            throw error;
          }
        }
        return {
          entry: copyManagedForward(managed.get(key) ?? existing),
          probe: await probe(spec),
        };
      }
      if (spec.direction === "remote" && reserved.has(spec.containerPort)) {
        throw new ControlError(
          "container-port-taken",
          `container port ${spec.containerPort} is used by nas itself`,
        );
      }
      if (
        spec.direction === "local" &&
        [...managed.values()].some(
          (entry) =>
            entry.direction === "local" && entry.hostPort === spec.hostPort,
        )
      ) {
        throw new ControlError(
          "binding-conflict",
          `host port ${spec.hostPort} already has a local forward`,
        );
      }
      if (createsForwardCycle([...managed.values()], spec)) {
        throw new ControlError(
          "binding-conflict",
          "the forwarding mapping creates a cycle",
        );
      }
      const entry: ManagedForward = {
        direction: spec.direction,
        containerPort: spec.containerPort,
        hostPort: spec.hostPort,
        owners: [owner],
        createdAt: now().toISOString(),
        state: "pending",
      };
      managed.set(key, entry);
      generations.set(key, Symbol(key));
      inserted = true;
      if (spec.direction === "local") {
        if (!acquired) {
          const connections = new Set<Socket>();
          try {
            const server = await listenOn(
              spec.hostPort,
              spec.containerPort,
              connections,
            );
            acquired = { binding: entry, server, connections };
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
            throw new ControlError(
              "host-port-taken",
              `host port ${spec.hostPort} is unavailable`,
            );
          }
        }
        open.set(spec.containerPort, acquired);
      } else {
        try {
          await opts.gateway.forward(spec.containerPort, spec.hostPort);
        } catch (error) {
          if (error instanceof RelayNotReadyError) {
            throw new ControlError(
              "relay-unavailable",
              error.reason === "container-not-running"
                ? "the container is not running"
                : error.reason === "unsupported"
                  ? "the relay lacks secure forwarding support; restart the session"
                  : "the relay could not be started",
            );
          }
          throw new ControlError(
            "container-port-taken",
            `container port ${spec.containerPort} could not be opened: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      entry.state = "active";
      await persist();
      // Probe describes the target, independently of the established listener.
      return { entry: copyManagedForward(entry), probe: await probe(spec) };
    } catch (error) {
      if (inserted) {
        managed.delete(key);
        generations.delete(key);
        if (spec.direction === "local") open.delete(spec.containerPort);
        else await opts.gateway.unforward(spec.containerPort);
      }
      if (acquired) await closeBinding(acquired);
      throw error;
    }
  };

  const prepareInitial: PortBindBroker["prepareInitial"] = (entries) => {
    if (initial !== "idle" || managed.size > 0)
      return Promise.reject(new Error("initial forwarding already prepared"));
    const requested = entries.map((entry) => ({
      ...entry,
      owners: [...entry.owners],
    }));
    initial = "pending";
    return mutate(async () => {
      try {
        for (const spec of requested) {
          validateSpec(spec);
          if (
            spec.owners.length === 0 ||
            spec.owners.some(
              (owner) => owner !== "config" && owner !== "internal",
            )
          )
            throw new Error("invalid initial owners");
          const key = forwardKey(spec);
          if (
            managed.has(key) ||
            createsForwardCycle([...managed.values()], spec)
          )
            throw new Error("conflicting initial forwarding");
          if (spec.direction === "remote" && reserved.has(spec.containerPort))
            throw new Error(
              `container port ${spec.containerPort} is used by nas itself`,
            );
          if (
            spec.direction === "local" &&
            [...managed.values()].some(
              (entry) =>
                entry.direction === "local" && entry.hostPort === spec.hostPort,
            )
          )
            throw new Error(
              `host port ${spec.hostPort} already has a local forward`,
            );
          const entry: ManagedForward = {
            ...spec,
            createdAt: now().toISOString(),
            state: "pending",
          };
          if (entry.direction === "local") {
            const connections = new Set<Socket>();
            const server = await listenOn(
              entry.hostPort,
              entry.containerPort,
              connections,
            );
            open.set(entry.containerPort, {
              binding: entry,
              server,
              connections,
            });
            entry.state = "active";
          }
          managed.set(key, entry);
          generations.set(key, Symbol(key));
        }
        await persist();
        if (requested.length === 0) initial = "ready";
      } catch (error) {
        await failInitial(error);
        throw error;
      }
    });
  };

  const addPortForward: PortBindBroker["addPortForward"] = (spec, owner) => {
    const requested = { ...spec };
    return mutateUser(() => add(requested, owner));
  };

  const remove = async (
    key: Pick<ForwardSpec, "direction" | "containerPort">,
  ): Promise<RemoveForwardResult> => {
    const id = forwardKey(key);
    const entry = managed.get(id);
    if (!entry)
      throw new ControlError(
        "no-such-binding",
        "no forwarding matches that key",
      );
    const retained = removeUserOwners(entry);
    if (retained) {
      const removed = retained.owners.length !== entry.owners.length;
      if (removed) {
        managed.set(id, retained);
        await persistRevocation();
      }
      return { removed, retainedInternal: true, listenerClosed: false };
    }
    managed.delete(id);
    generations.delete(id);
    let listenerClosed = false;
    if (entry.direction === "local") {
      const binding = open.get(entry.containerPort);
      open.delete(entry.containerPort);
      if (binding) {
        await closeBinding(binding);
        listenerClosed = true;
      }
    } else {
      // Gateway revokes permission synchronously before awaiting listener ACK.
      const result = await opts.gateway.unforward(entry.containerPort);
      listenerClosed = result.listenerClosed;
    }
    await persistRevocation();
    return { removed: true, retainedInternal: false, listenerClosed };
  };

  const removePortForward: PortBindBroker["removePortForward"] = (key) => {
    const requested = { ...key };
    return mutateUser(() => remove(requested));
  };

  const bind: PortBindBroker["bind"] = (req) => {
    const requested = { ...req };
    return mutateUser(async () => {
      const existing = managed.get(
        forwardKey({
          direction: "local",
          containerPort: requested.containerPort,
        }),
      );
      let result: AddForwardResult;
      if (
        existing ||
        (requested.hostPort !== null && requested.hostPort !== 0)
      ) {
        result = await add(
          {
            direction: "local",
            containerPort: requested.containerPort,
            hostPort:
              requested.hostPort ||
              existing?.hostPort ||
              requested.containerPort,
          },
          "dynamic",
        );
      } else {
        if (!validPort(requested.containerPort))
          throw new ControlError("invalid-request", "invalid container port");
        let acquired: OpenBinding | undefined;
        for (const candidate of hostPortCandidates(
          requested.containerPort,
          requested.hostPort,
        )) {
          const connections = new Set<Socket>();
          try {
            const server = await listenOn(
              candidate,
              requested.containerPort,
              connections,
            );
            const hostPort = (server.address() as { port: number }).port;
            acquired = {
              server,
              connections,
              binding: {
                containerPort: requested.containerPort,
                hostPort,
                createdAt: now().toISOString(),
              },
            };
            break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
          }
        }
        if (!acquired)
          throw new ControlError(
            "host-port-taken",
            `no free host port near ${requested.containerPort}`,
          );
        result = await add(
          { direction: "local", ...acquired.binding },
          "dynamic",
          acquired,
        );
      }
      return { hostPort: result.entry.hostPort, probe: result.probe };
    });
  };

  const unbind: PortBindBroker["unbind"] = (key) => {
    const requested = { ...key };
    return mutateUser(async () => {
      const entry = [...managed.values()].find(
        (entry) =>
          entry.direction === "local" &&
          ((requested.containerPort !== undefined &&
            entry.containerPort === requested.containerPort) ||
            (requested.hostPort !== undefined &&
              entry.hostPort === requested.hostPort)),
      );
      if (!entry)
        throw new ControlError(
          "no-such-binding",
          "no binding matches that key",
        );
      await remove(entry);
    });
  };

  const forward: PortBindBroker["forward"] = async (req) => {
    const result = await addPortForward(
      { direction: "remote", ...req },
      "dynamic",
    );
    return {
      containerPort: result.entry.containerPort,
      hostPort: result.entry.hostPort,
      hostProbe: result.probe === "ok" ? "ok" : "no-answer",
    };
  };

  const unforward: PortBindBroker["unforward"] = async (containerPort) => {
    await removePortForward({ direction: "remote", containerPort });
  };

  const watchState = (
    ensured: Awaited<ReturnType<RelayGateway["watchListeners"]>>,
  ): ListenerWatchState => {
    if (ensured === "ready") return "watching";
    if (ensured === "container-not-running") return "container-not-running";
    return "relay-unreachable";
  };

  const candidates: PortBindBroker["candidates"] = async () => {
    const ensured = await opts.gateway.watchListeners(true);
    if (watchLease) clearTimeout(watchLease);
    watchLease = closing
      ? undefined
      : setTimeout(() => {
          watchLease = undefined;
          void opts.gateway.watchListeners(false).catch(() => {});
        }, watchLeaseMs);
    return {
      candidates: opts.gateway
        .listeners()
        .filter(
          (listener) =>
            !open.has(listener.containerPort) &&
            !reserved.has(listener.containerPort) &&
            ![...managed.values()].some(
              (entry) =>
                entry.direction === "remote" &&
                entry.containerPort === listener.containerPort &&
                (entry.state === "active" ||
                  entry.state === "pending" ||
                  entry.owners.includes("internal")),
            ),
        )
        .map((listener) => ({
          ...listener,
          reachable: isReachableScope(listener.scope),
        })),
      watch: watchState(ensured),
    };
  };

  async function handleControl(socket: Socket): Promise<void> {
    socket.on("error", () => socket.destroy());
    try {
      let request: ControlRequest;
      try {
        const line = await readJsonLine(socket, MAX_CONTROL_BYTES);
        if (line === null) return;
        request = parseControlRequest(line);
      } catch (error) {
        if (error instanceof ControlError) throw error;
        throw new ControlError("invalid-request", "request could not be read");
      }

      let response: ControlResponse;
      if (request.type === "bind") {
        response = { ok: true, ...(await bind(request)) };
      } else if (request.type === "candidates") {
        response = { ok: true, ...(await candidates()) };
      } else if (request.type === "forward") {
        response = { ok: true, ...(await forward(request)) };
      } else if (request.type === "unforward") {
        await unforward(request.containerPort);
        response = { ok: true };
      } else {
        await unbind(
          "containerPort" in request
            ? { containerPort: request.containerPort }
            : { hostPort: request.hostPort },
        );
        response = { ok: true };
      }
      await writeJsonLine(socket, response);
    } catch (error) {
      const response: ControlResponse = {
        ok: false,
        error: error instanceof ControlError ? error.kind : "internal",
        message: error instanceof Error ? error.message : String(error),
      };
      await writeJsonLine(socket, response).catch(() => {});
    } finally {
      socket.end();
    }
  }

  await safeRemove(opts.controlSocketPath);
  const controlConnections = new Set<Socket>();
  const control = await createUnixServer(opts.controlSocketPath, (socket) => {
    controlConnections.add(socket);
    socket.once("close", () => controlConnections.delete(socket));
    void handleControl(socket);
  });

  return {
    controlSocketPath: opts.controlSocketPath,
    listPortForwards,
    prepareInitial,
    onRelayConnected,
    onForwardState,
    addPortForward,
    removePortForward,
    bind,
    unbind,
    listBindings: snapshot,
    forward,
    unforward,
    listForwards: () => projectPortForwards(listPortForwards()).forwards,
    candidates,
    close: async () => {
      closing = true;
      if (watchLease) clearTimeout(watchLease);
      watchLease = undefined;
      await mutationTail;
      for (const entry of open.values()) await closeBinding(entry);
      open.clear();
      managed.clear();
      generations.clear();
      const controlClosed = new Promise<void>((resolve, reject) => {
        control.close((error) => (error ? reject(error) : resolve()));
      });
      for (const socket of controlConnections) socket.destroy();
      controlConnections.clear();
      await controlClosed;
      await safeRemove(opts.controlSocketPath);
      await opts.gateway.close();
    },
  };
}
