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
} from "./port_bind_protocol.ts";
import {
  pipeSockets,
  type RelayGateway,
  RelayNotReadyError,
} from "./port_bind_relay.ts";

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
  bindings: PortBinding[];
  forwards: PortForward[];
}

export interface PortBindBroker {
  readonly controlSocketPath: string;
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
   * daemon, the local proxy, forwarded ports). They are always listening and
   * are never something the user wants exposed, so they never get suggested.
   */
  reservedPorts?: readonly number[];
  watchLeaseMs?: number;
}): Promise<PortBindBroker> {
  const now = opts.now ?? (() => new Date());
  const reserved = new Set(opts.reservedPorts ?? []);
  const watchLeaseMs = opts.watchLeaseMs ?? WATCH_LEASE_MS;
  const open = new Map<number, OpenBinding>();
  let watchLease: ReturnType<typeof setTimeout> | undefined;
  let mutationTail = Promise.resolve();
  let closing = false;

  const snapshot = (): PortBinding[] =>
    [...open.values()].map((entry) => entry.binding);
  const persist = (ports: Partial<PersistedPorts>) =>
    opts.persist({
      bindings: ports.bindings ?? snapshot(),
      forwards: ports.forwards ?? opts.gateway.forwards(),
    });

  const mutate = <T>(action: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error("broker is closed"));
    const result = mutationTail.then(action);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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

  const bind: PortBindBroker["bind"] = (req) =>
    mutate(async () => {
      const existing = open.get(req.containerPort);
      if (existing) {
        if (
          req.hostPort !== null &&
          req.hostPort !== 0 &&
          req.hostPort !== existing.binding.hostPort
        ) {
          throw new ControlError(
            "binding-conflict",
            `container port ${req.containerPort} is already bound to ${existing.binding.hostPort}`,
          );
        }
        return {
          hostPort: existing.binding.hostPort,
          probe: await opts.gateway.probe(req.containerPort),
        };
      }

      const connections = new Set<Socket>();
      let server: Server | null = null;
      for (const candidate of hostPortCandidates(
        req.containerPort,
        req.hostPort,
      )) {
        try {
          server = await listenOn(candidate, req.containerPort, connections);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
        }
      }
      if (!server) {
        throw new ControlError(
          "host-port-taken",
          req.hostPort !== null
            ? `host port ${req.hostPort} is unavailable`
            : `no free host port near ${req.containerPort}`,
        );
      }

      const address = server.address();
      const chosen =
        address && typeof address === "object"
          ? address.port
          : req.containerPort;
      const binding: PortBinding = {
        containerPort: req.containerPort,
        hostPort: chosen,
        createdAt: now().toISOString(),
      };
      const entry = { binding, server, connections };
      try {
        await persist({ bindings: [...snapshot(), binding] });
      } catch (error) {
        await closeBinding(entry);
        throw error;
      }
      open.set(req.containerPort, entry);
      return {
        hostPort: chosen,
        probe: await opts.gateway.probe(req.containerPort),
      };
    });

  const unbind: PortBindBroker["unbind"] = (key) =>
    mutate(async () => {
      const entry = [...open.values()].find(
        (candidate) =>
          (key.containerPort !== undefined &&
            candidate.binding.containerPort === key.containerPort) ||
          (key.hostPort !== undefined &&
            candidate.binding.hostPort === key.hostPort),
      );
      if (!entry) {
        throw new ControlError(
          "no-such-binding",
          "no binding matches that key",
        );
      }
      const remaining = snapshot().filter(
        (binding) => binding.containerPort !== entry.binding.containerPort,
      );
      await persist({ bindings: remaining });
      await closeBinding(entry);
      open.delete(entry.binding.containerPort);
    });

  const forward: PortBindBroker["forward"] = (req) =>
    mutate(async () => {
      if (reserved.has(req.containerPort)) {
        throw new ControlError(
          "container-port-taken",
          `container port ${req.containerPort} is used by nas itself`,
        );
      }
      const existing = opts.gateway
        .forwards()
        .find((entry) => entry.containerPort === req.containerPort);
      if (existing) {
        if (existing.hostPort !== req.hostPort) {
          throw new ControlError(
            "binding-conflict",
            `container port ${req.containerPort} already forwards to host port ${existing.hostPort}`,
          );
        }
        return {
          containerPort: existing.containerPort,
          hostPort: existing.hostPort,
          hostProbe: await probeHostPort(existing.hostPort),
        };
      }

      try {
        await opts.gateway.forward(req.containerPort, req.hostPort);
      } catch (error) {
        if (error instanceof RelayNotReadyError) {
          throw new ControlError(
            "relay-unavailable",
            error.reason === "container-not-running"
              ? "the container is not running"
              : "the relay could not be started",
          );
        }
        throw new ControlError(
          "container-port-taken",
          `container port ${req.containerPort} could not be opened: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      try {
        await persist({});
      } catch (error) {
        await opts.gateway.unforward(req.containerPort);
        throw error;
      }
      return {
        containerPort: req.containerPort,
        hostPort: req.hostPort,
        hostProbe: await probeHostPort(req.hostPort),
      };
    });

  const unforward: PortBindBroker["unforward"] = (containerPort) =>
    mutate(async () => {
      const forwards = opts.gateway.forwards();
      if (!forwards.some((entry) => entry.containerPort === containerPort)) {
        throw new ControlError(
          "no-such-binding",
          `container port ${containerPort} is not forwarded`,
        );
      }
      await persist({
        forwards: forwards.filter(
          (entry) => entry.containerPort !== containerPort,
        ),
      });
      await opts.gateway.unforward(containerPort);
    });

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
            !reserved.has(listener.containerPort),
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
    bind,
    unbind,
    listBindings: snapshot,
    forward,
    unforward,
    listForwards: () => opts.gateway.forwards(),
    candidates,
    close: async () => {
      closing = true;
      if (watchLease) clearTimeout(watchLease);
      watchLease = undefined;
      await mutationTail;
      for (const entry of open.values()) await closeBinding(entry);
      open.clear();
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
