import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import {
  connectUnix,
  readJsonLine,
  type Socket,
  writeJsonLine,
} from "../../lib/unix_socket.ts";
import {
  type ControlRequest,
  type ControlResponse,
  type HostProbeResult,
  type ListenerWatchState,
  MAX_CONTROL_BYTES,
  PORT_BIND_PROTOCOL_VERSION,
  type PortBindCandidate,
  type PortBindSessionEntry,
  type ProbeResult,
  sessionPortForwards,
} from "../../network/port_bind_protocol.ts";
import {
  brokerSocketPath,
  findSessionsByHostPort,
  gcPortsRuntime,
  listPortBindSessions,
  type PortsRuntimePaths,
  readSessionRegistry,
} from "../../network/port_bind_registry.ts";
import type {
  AddForwardRequest,
  AddForwardResult,
  ForwardSelector,
  ManagedForward,
  RemoveForwardResult,
} from "../../network/port_forward_model.ts";
import {
  AmbiguousHostPortError,
  BindingConflictError,
  ContainerPortTakenError,
  HostPortTakenError,
  InternalBrokerError,
  InvalidRequestError,
  NoSuchBindingError,
  type PortBindKey,
  type PortForwardKey,
  RelayUnavailableError,
  SessionRestartRequiredError,
  SessionUnreachableError,
} from "./types.ts";

/** Unbound listeners the session's relay currently sees, plus why it may see none. */
export interface PortBindCandidates {
  candidates: PortBindCandidate[];
  watch: ListenerWatchState;
}

/** What a forward request opened, and whether the host side answered a dial. */
export interface PortForwardResult {
  containerPort: number;
  hostPort: number;
  hostProbe: HostProbeResult;
}

export class PortBindService extends Context.Tag("nas/PortBindService")<
  PortBindService,
  {
    readonly list: (
      paths: PortsRuntimePaths,
    ) => Effect.Effect<PortBindSessionEntry[], Error>;
    readonly add: (
      paths: PortsRuntimePaths,
      sessionId: string,
      request: AddForwardRequest,
    ) => Effect.Effect<AddForwardResult, Error>;
    readonly remove: (
      paths: PortsRuntimePaths,
      sessionId: string,
      selector: ForwardSelector,
    ) => Effect.Effect<RemoveForwardResult, Error>;
    readonly bind: (
      paths: PortsRuntimePaths,
      sessionId: string,
      containerPort: number,
      hostPort: number | null,
    ) => Effect.Effect<{ hostPort: number; probe: ProbeResult }, Error>;
    readonly unbindByKey: (
      paths: PortsRuntimePaths,
      key: PortBindKey,
    ) => Effect.Effect<void, Error>;
    /**
     * Asking is what starts the container-side scan, so a caller that wants
     * live suggestions keeps asking; one that stops lets the scan lapse.
     */
    readonly candidates: (
      paths: PortsRuntimePaths,
      sessionId: string,
    ) => Effect.Effect<PortBindCandidates, Error>;
    /**
     * Make the host's `127.0.0.1:hostPort` reachable at
     * `localhost:containerPort` inside the session's container. Fails when
     * the container is not running: the listener lives there.
     */
    readonly forward: (
      paths: PortsRuntimePaths,
      sessionId: string,
      containerPort: number,
      hostPort: number,
    ) => Effect.Effect<PortForwardResult, Error>;
    readonly unforward: (
      paths: PortsRuntimePaths,
      key: PortForwardKey,
    ) => Effect.Effect<void, Error>;
  }
>() {}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function unreachable(sessionId: string): SessionUnreachableError {
  return new SessionUnreachableError(
    `session ${sessionId} is unreachable; restart it or run nas network gc`,
  );
}

function brokerError(kind: string, message: string): Error {
  switch (kind) {
    case "host-port-taken":
      return new HostPortTakenError(message);
    case "binding-conflict":
      return new BindingConflictError(message);
    case "no-such-binding":
      return new NoSuchBindingError(message);
    case "invalid-request":
      return new InvalidRequestError(message);
    case "container-port-taken":
      return new ContainerPortTakenError(message);
    case "relay-unavailable":
      return new RelayUnavailableError(message);
    case "internal":
      return new InternalBrokerError(message);
    default:
      return new InternalBrokerError(message);
  }
}

function isPortNumber(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 65_535
  );
}

function parseBindResult(response: ControlResponse): {
  hostPort: number;
  probe: ProbeResult;
} {
  const hostPort = "hostPort" in response ? response.hostPort : undefined;
  const probe = "probe" in response ? response.probe : undefined;
  if (!isPortNumber(hostPort) || !isProbeResult(probe)) {
    throw new InternalBrokerError("broker returned an invalid bind response");
  }
  return { hostPort, probe };
}

function parseForwardResult(response: ControlResponse): PortForwardResult {
  const containerPort =
    "containerPort" in response ? response.containerPort : undefined;
  const hostPort = "hostPort" in response ? response.hostPort : undefined;
  const hostProbe = "hostProbe" in response ? response.hostProbe : undefined;
  if (
    !isPortNumber(containerPort) ||
    !isPortNumber(hostPort) ||
    (hostProbe !== "ok" && hostProbe !== "no-answer")
  ) {
    throw new InternalBrokerError(
      "broker returned an invalid forward response",
    );
  }
  return { containerPort, hostPort, hostProbe };
}

function isProbeResult(value: unknown): value is ProbeResult {
  return (
    value === "ok" ||
    value === "no-answer" ||
    value === "container-not-running" ||
    value === "relay-unreachable"
  );
}

function isManagedForward(value: unknown): value is ManagedForward {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const expectedKeys = [
    "containerPort",
    "createdAt",
    "direction",
    ...(entry.error === undefined ? [] : ["error"]),
    "hostPort",
    "owners",
    "state",
  ].sort();
  const keys = Object.keys(entry).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    (entry.direction === "local" || entry.direction === "remote") &&
    isPortNumber(entry.containerPort) &&
    isPortNumber(entry.hostPort) &&
    Array.isArray(entry.owners) &&
    entry.owners.every(
      (owner) =>
        owner === "config" || owner === "dynamic" || owner === "internal",
    ) &&
    typeof entry.createdAt === "string" &&
    (entry.state === "pending" ||
      entry.state === "active" ||
      entry.state === "unavailable" ||
      entry.state === "failed") &&
    (entry.error === undefined || typeof entry.error === "string")
  );
}

function parseAddForwardResult(response: ControlResponse): AddForwardResult {
  const entry = "entry" in response ? response.entry : undefined;
  const probe = "probe" in response ? response.probe : undefined;
  if (!isManagedForward(entry) || !isProbeResult(probe)) {
    throw new InternalBrokerError(
      "broker returned an invalid add-forward response",
    );
  }
  return { entry, probe };
}

function parseRemoveForwardResult(
  response: ControlResponse,
): RemoveForwardResult {
  const removed = "removed" in response ? response.removed : undefined;
  const retainedInternal =
    "retainedInternal" in response ? response.retainedInternal : undefined;
  const listenerClosed =
    "listenerClosed" in response ? response.listenerClosed : undefined;
  if (
    typeof removed !== "boolean" ||
    typeof retainedInternal !== "boolean" ||
    typeof listenerClosed !== "boolean"
  ) {
    throw new InternalBrokerError(
      "broker returned an invalid remove-forward response",
    );
  }
  return { removed, retainedInternal, listenerClosed };
}

function isCandidate(value: unknown): value is PortBindCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PortBindCandidate>;
  return (
    Number.isInteger(candidate.containerPort) &&
    (candidate.containerPort as number) >= 1 &&
    (candidate.containerPort as number) <= 65_535 &&
    (candidate.scope === "any" ||
      candidate.scope === "loopback" ||
      candidate.scope === "loopback6" ||
      candidate.scope === "remote") &&
    typeof candidate.reachable === "boolean"
  );
}

function parseCandidates(response: ControlResponse): PortBindCandidates {
  const candidates = "candidates" in response ? response.candidates : undefined;
  const watch = "watch" in response ? response.watch : undefined;
  if (
    !Array.isArray(candidates) ||
    !candidates.every(isCandidate) ||
    (watch !== "watching" &&
      watch !== "container-not-running" &&
      watch !== "relay-unreachable")
  ) {
    throw new InternalBrokerError(
      "broker returned an invalid candidates response",
    );
  }
  return { candidates, watch };
}

function parseResponse(line: string): ControlResponse {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new InternalBrokerError("broker returned invalid JSON");
  }
  if (!value || typeof value !== "object") {
    throw new InternalBrokerError("broker returned an invalid response");
  }
  const response = value as Partial<ControlResponse>;
  if (response.ok === false) {
    if (
      typeof response.error !== "string" ||
      typeof response.message !== "string"
    ) {
      throw new InternalBrokerError(
        "broker returned an invalid error response",
      );
    }
    throw brokerError(response.error, response.message);
  }
  if (response.ok !== true) {
    throw new InternalBrokerError("broker returned an invalid response");
  }
  return value as ControlResponse;
}

async function sendRequest(
  paths: PortsRuntimePaths,
  sessionId: string,
  request: ControlRequest,
): Promise<ControlResponse> {
  let socket: Socket;
  try {
    socket = await connectUnix(brokerSocketPath(paths, sessionId));
  } catch {
    throw unreachable(sessionId);
  }
  try {
    await writeJsonLine(socket, request);
    const line = await readJsonLine(socket, MAX_CONTROL_BYTES);
    if (line === null) throw unreachable(sessionId);
    return parseResponse(line);
  } catch (error) {
    if (
      error instanceof HostPortTakenError ||
      error instanceof BindingConflictError ||
      error instanceof NoSuchBindingError ||
      error instanceof InvalidRequestError ||
      error instanceof ContainerPortTakenError ||
      error instanceof RelayUnavailableError ||
      error instanceof InternalBrokerError ||
      error instanceof SessionUnreachableError
    ) {
      throw error;
    }
    throw unreachable(sessionId);
  } finally {
    socket.destroy();
  }
}

async function requireSession(
  paths: PortsRuntimePaths,
  sessionId: string,
): Promise<PortBindSessionEntry> {
  await gcPortsRuntime(paths);
  const session = await readSessionRegistry<PortBindSessionEntry>(
    paths,
    sessionId,
  );
  if (
    !session ||
    session.brokerSocket !== brokerSocketPath(paths, session.sessionId)
  ) {
    throw unreachable(sessionId);
  }
  return session;
}

async function listReadySessions(
  paths: PortsRuntimePaths,
): Promise<PortBindSessionEntry[]> {
  const sessions = await listPortBindSessions(paths);
  return sessions.filter(
    (session) =>
      session.brokerSocket === brokerSocketPath(paths, session.sessionId),
  );
}

function usesCurrentProtocol(entry: PortBindSessionEntry): boolean {
  const version = (entry as { protocolVersion?: unknown }).protocolVersion;
  if (version === PORT_BIND_PROTOCOL_VERSION) return true;
  if (version === undefined) return false;
  throw new SessionRestartRequiredError(
    entry.sessionId,
    `port forwarding protocol version ${String(version)}`,
  );
}

function requireLegacyRemoteSupport(entry: PortBindSessionEntry): void {
  if (entry.forwards === undefined) {
    throw new SessionRestartRequiredError(entry.sessionId, "remote forwarding");
  }
}

async function readLegacyAddedEntry(
  paths: PortsRuntimePaths,
  sessionId: string,
  direction: AddForwardRequest["direction"],
  containerPort: number,
): Promise<ManagedForward> {
  const persisted = await readSessionRegistry<PortBindSessionEntry>(
    paths,
    sessionId,
  );
  const entry = persisted
    ? sessionPortForwards(persisted).find(
        (candidate) =>
          candidate.direction === direction &&
          candidate.containerPort === containerPort,
      )
    : undefined;
  if (!entry) {
    throw new InternalBrokerError(
      "legacy broker did not persist the added forwarding",
    );
  }
  return entry;
}

async function addForward(
  paths: PortsRuntimePaths,
  sessionId: string,
  request: AddForwardRequest,
): Promise<AddForwardResult> {
  const session = await requireSession(paths, sessionId);
  if (usesCurrentProtocol(session)) {
    return parseAddForwardResult(
      await sendRequest(paths, sessionId, { type: "add-forward", ...request }),
    );
  }

  if (request.direction === "local") {
    const result = parseBindResult(
      await sendRequest(paths, sessionId, {
        type: "bind",
        containerPort: request.containerPort,
        hostPort: request.hostPort,
      }),
    );
    return {
      entry: await readLegacyAddedEntry(
        paths,
        sessionId,
        request.direction,
        request.containerPort,
      ),
      probe: result.probe,
    };
  }

  requireLegacyRemoteSupport(session);
  const result = parseForwardResult(
    await sendRequest(paths, sessionId, {
      type: "forward",
      containerPort: request.containerPort,
      hostPort: request.hostPort,
    }),
  );
  return {
    entry: await readLegacyAddedEntry(
      paths,
      sessionId,
      request.direction,
      request.containerPort,
    ),
    probe: result.hostProbe,
  };
}

async function removeForward(
  paths: PortsRuntimePaths,
  sessionId: string,
  selector: ForwardSelector,
): Promise<RemoveForwardResult> {
  const session = await requireSession(paths, sessionId);
  if (usesCurrentProtocol(session)) {
    return parseRemoveForwardResult(
      await sendRequest(paths, sessionId, {
        type: "remove-forward",
        ...selector,
      }),
    );
  }

  if (selector.direction === "remote") {
    requireLegacyRemoteSupport(session);
    await sendRequest(paths, sessionId, {
      type: "unforward",
      containerPort: selector.containerPort,
    });
  } else {
    await sendRequest(
      paths,
      sessionId,
      "hostPort" in selector
        ? { type: "unbind", hostPort: selector.hostPort }
        : { type: "unbind", containerPort: selector.containerPort },
    );
  }
  return {
    removed: true,
    retainedInternal: false,
    listenerClosed: selector.direction === "local",
  };
}

export const PortBindServiceLive: Layer.Layer<PortBindService> = Layer.succeed(
  PortBindService,
  PortBindService.of({
    list: (paths) =>
      Effect.tryPromise({
        try: async () => {
          await gcPortsRuntime(paths);
          return await listReadySessions(paths);
        },
        catch: toError,
      }),

    add: (paths, sessionId, request) =>
      Effect.tryPromise({
        try: () => addForward(paths, sessionId, request),
        catch: toError,
      }),

    remove: (paths, sessionId, selector) =>
      Effect.tryPromise({
        try: () => removeForward(paths, sessionId, selector),
        catch: toError,
      }),

    bind: (paths, sessionId, containerPort, hostPort) =>
      Effect.map(
        Effect.tryPromise({
          try: () =>
            addForward(paths, sessionId, {
              direction: "local",
              containerPort,
              hostPort: hostPort === 0 ? null : hostPort,
            }),
          catch: toError,
        }),
        ({ entry, probe }) => ({ hostPort: entry.hostPort, probe }),
      ),

    unbindByKey: (paths, key) =>
      Effect.tryPromise({
        try: async () => {
          let sessionId: string;
          let selector: ForwardSelector;
          if ("hostPort" in key) {
            await gcPortsRuntime(paths);
            const matches = await findSessionsByHostPort(paths, key.hostPort);
            if (matches.length === 0) {
              throw new NoSuchBindingError(
                `no binding uses host port ${key.hostPort}`,
              );
            }
            if (matches.length > 1) {
              throw new AmbiguousHostPortError(
                key.hostPort,
                matches.map((entry) => entry.sessionId).sort(),
              );
            }
            sessionId = matches[0].sessionId;
            selector = { direction: "local", hostPort: key.hostPort };
          } else {
            sessionId = key.sessionId;
            selector = {
              direction: "local",
              containerPort: key.containerPort,
            };
          }
          await removeForward(paths, sessionId, selector);
        },
        catch: toError,
      }),

    candidates: (paths, sessionId) =>
      Effect.tryPromise({
        try: async () => {
          await requireSession(paths, sessionId);
          return parseCandidates(
            await sendRequest(paths, sessionId, { type: "candidates" }),
          );
        },
        catch: toError,
      }),

    forward: (paths, sessionId, containerPort, hostPort) =>
      Effect.map(
        Effect.tryPromise({
          try: () =>
            addForward(paths, sessionId, {
              direction: "remote",
              containerPort,
              hostPort,
            }),
          catch: toError,
        }),
        ({ entry, probe }) => ({
          containerPort: entry.containerPort,
          hostPort: entry.hostPort,
          hostProbe: probe === "ok" ? "ok" : "no-answer",
        }),
      ),

    unforward: (paths, key) =>
      Effect.asVoid(
        Effect.tryPromise({
          try: () =>
            removeForward(paths, key.sessionId, {
              direction: "remote",
              containerPort: key.containerPort,
            }),
          catch: toError,
        }),
      ),
  }),
);

export interface PortBindServiceFakeConfig {
  readonly list?: (
    paths: PortsRuntimePaths,
  ) => Effect.Effect<PortBindSessionEntry[], Error>;
  readonly add?: (
    paths: PortsRuntimePaths,
    sessionId: string,
    request: AddForwardRequest,
  ) => Effect.Effect<AddForwardResult, Error>;
  readonly remove?: (
    paths: PortsRuntimePaths,
    sessionId: string,
    selector: ForwardSelector,
  ) => Effect.Effect<RemoveForwardResult, Error>;
  readonly bind?: (
    paths: PortsRuntimePaths,
    sessionId: string,
    containerPort: number,
    hostPort: number | null,
  ) => Effect.Effect<{ hostPort: number; probe: ProbeResult }, Error>;
  readonly unbindByKey?: (
    paths: PortsRuntimePaths,
    key: PortBindKey,
  ) => Effect.Effect<void, Error>;
  readonly candidates?: (
    paths: PortsRuntimePaths,
    sessionId: string,
  ) => Effect.Effect<PortBindCandidates, Error>;
  readonly forward?: (
    paths: PortsRuntimePaths,
    sessionId: string,
    containerPort: number,
    hostPort: number,
  ) => Effect.Effect<PortForwardResult, Error>;
  readonly unforward?: (
    paths: PortsRuntimePaths,
    key: PortForwardKey,
  ) => Effect.Effect<void, Error>;
}

export function makePortBindServiceFake(
  overrides: PortBindServiceFakeConfig = {},
): Layer.Layer<PortBindService> {
  const add =
    overrides.add ??
    ((_paths, _sessionId, request) =>
      Effect.succeed({
        entry: {
          direction: request.direction,
          containerPort: request.containerPort,
          hostPort: request.hostPort ?? request.containerPort,
          owners: ["dynamic"],
          createdAt: "1970-01-01T00:00:00.000Z",
          state: "active",
        },
        probe: "ok",
      }));
  const remove =
    overrides.remove ??
    (() =>
      Effect.succeed({
        removed: true,
        retainedInternal: false,
        listenerClosed: true,
      }));
  return Layer.succeed(
    PortBindService,
    PortBindService.of({
      list: overrides.list ?? (() => Effect.succeed([])),
      add,
      remove,
      bind:
        overrides.bind ??
        ((paths, sessionId, containerPort, hostPort) =>
          Effect.map(
            add(paths, sessionId, {
              direction: "local",
              containerPort,
              hostPort: hostPort === 0 ? null : hostPort,
            }),
            ({ entry, probe }) => ({ hostPort: entry.hostPort, probe }),
          )),
      unbindByKey: overrides.unbindByKey ?? (() => Effect.void),
      candidates:
        overrides.candidates ??
        (() => Effect.succeed({ candidates: [], watch: "watching" })),
      forward:
        overrides.forward ??
        ((paths, sessionId, containerPort, hostPort) =>
          Effect.map(
            add(paths, sessionId, {
              direction: "remote",
              containerPort,
              hostPort,
            }),
            ({ entry, probe }) => ({
              containerPort: entry.containerPort,
              hostPort: entry.hostPort,
              hostProbe: probe === "ok" ? "ok" : "no-answer",
            }),
          )),
      unforward:
        overrides.unforward ??
        ((paths, key) =>
          Effect.asVoid(
            remove(paths, key.sessionId, {
              direction: "remote",
              containerPort: key.containerPort,
            }),
          )),
    }),
  );
}

export function makePortBindClient(
  layer: Layer.Layer<PortBindService> = PortBindServiceLive,
) {
  async function run<A>(
    f: (
      service: Context.Tag.Service<PortBindService>,
    ) => Effect.Effect<A, Error>,
  ): Promise<A> {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(PortBindService, f).pipe(Effect.provide(layer)),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) throw failure.value;
    throw new Error(`Defect or interruption: ${Cause.pretty(exit.cause)}`);
  }

  return {
    list: (paths: PortsRuntimePaths): Promise<PortBindSessionEntry[]> =>
      run((service) => service.list(paths)),
    add: (
      paths: PortsRuntimePaths,
      sessionId: string,
      request: AddForwardRequest,
    ): Promise<AddForwardResult> =>
      run((service) => service.add(paths, sessionId, request)),
    remove: (
      paths: PortsRuntimePaths,
      sessionId: string,
      selector: ForwardSelector,
    ): Promise<RemoveForwardResult> =>
      run((service) => service.remove(paths, sessionId, selector)),
    bind: (
      paths: PortsRuntimePaths,
      sessionId: string,
      containerPort: number,
      hostPort: number | null,
    ): Promise<{ hostPort: number; probe: ProbeResult }> =>
      run((service) => service.bind(paths, sessionId, containerPort, hostPort)),
    unbindByKey: (paths: PortsRuntimePaths, key: PortBindKey): Promise<void> =>
      run((service) => service.unbindByKey(paths, key)),
    candidates: (
      paths: PortsRuntimePaths,
      sessionId: string,
    ): Promise<PortBindCandidates> =>
      run((service) => service.candidates(paths, sessionId)),
    forward: (
      paths: PortsRuntimePaths,
      sessionId: string,
      containerPort: number,
      hostPort: number,
    ): Promise<PortForwardResult> =>
      run((service) =>
        service.forward(paths, sessionId, containerPort, hostPort),
      ),
    unforward: (paths: PortsRuntimePaths, key: PortForwardKey): Promise<void> =>
      run((service) => service.unforward(paths, key)),
  };
}
