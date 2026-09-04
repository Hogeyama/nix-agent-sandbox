import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { gcRuntime } from "../../lib/runtime_registry.ts";
import {
  connectUnix,
  readJsonLine,
  type Socket,
  writeJsonLine,
} from "../../lib/unix_socket.ts";
import {
  type ControlRequest,
  type ControlResponse,
  MAX_CONTROL_BYTES,
  type PortBindSessionEntry,
  type ProbeResult,
} from "../../network/port_bind_protocol.ts";
import {
  brokerSocketPath,
  findSessionsByHostPort,
  listPortBindSessions,
  type PortsRuntimePaths,
} from "../../network/port_bind_registry.ts";
import {
  AmbiguousHostPortError,
  BindingConflictError,
  HostPortTakenError,
  InternalBrokerError,
  InvalidRequestError,
  NoSuchBindingError,
  type PortBindKey,
  SessionUnreachableError,
} from "./types.ts";

export class PortBindService extends Context.Tag("nas/PortBindService")<
  PortBindService,
  {
    readonly list: (
      paths: PortsRuntimePaths,
    ) => Effect.Effect<PortBindSessionEntry[], Error>;
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
    case "internal":
      return new InternalBrokerError(message);
    default:
      return new InternalBrokerError(message);
  }
}

function isProbeResult(value: unknown): value is ProbeResult {
  return (
    value === "ok" ||
    value === "no-answer" ||
    value === "container-not-running" ||
    value === "relay-unreachable"
  );
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
): Promise<void> {
  await gcRuntime<PortBindSessionEntry>(paths);
  const sessions = await listReadySessions(paths);
  if (!sessions.some((session) => session.sessionId === sessionId)) {
    throw unreachable(sessionId);
  }
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

export const PortBindServiceLive: Layer.Layer<PortBindService> = Layer.succeed(
  PortBindService,
  PortBindService.of({
    list: (paths) =>
      Effect.tryPromise({
        try: async () => {
          await gcRuntime<PortBindSessionEntry>(paths);
          return await listReadySessions(paths);
        },
        catch: toError,
      }),

    bind: (paths, sessionId, containerPort, hostPort) =>
      Effect.tryPromise({
        try: async () => {
          await requireSession(paths, sessionId);
          const response = await sendRequest(paths, sessionId, {
            type: "bind",
            containerPort,
            hostPort,
          });
          const hostPortResult =
            "hostPort" in response ? response.hostPort : undefined;
          const probe = "probe" in response ? response.probe : undefined;
          if (
            !Number.isInteger(hostPortResult) ||
            hostPortResult === undefined ||
            hostPortResult < 1 ||
            hostPortResult > 65_535 ||
            !isProbeResult(probe)
          ) {
            throw new InternalBrokerError(
              "broker returned an invalid bind response",
            );
          }
          return { hostPort: hostPortResult, probe };
        },
        catch: toError,
      }),

    unbindByKey: (paths, key) =>
      Effect.tryPromise({
        try: async () => {
          let sessionId: string;
          let request: ControlRequest;
          if ("hostPort" in key) {
            await gcRuntime<PortBindSessionEntry>(paths);
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
            request = { type: "unbind", hostPort: key.hostPort };
          } else {
            sessionId = key.sessionId;
            await requireSession(paths, sessionId);
            request = { type: "unbind", containerPort: key.containerPort };
          }
          await sendRequest(paths, sessionId, request);
        },
        catch: toError,
      }),
  }),
);

export interface PortBindServiceFakeConfig {
  readonly list?: (
    paths: PortsRuntimePaths,
  ) => Effect.Effect<PortBindSessionEntry[], Error>;
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
}

export function makePortBindServiceFake(
  overrides: PortBindServiceFakeConfig = {},
): Layer.Layer<PortBindService> {
  return Layer.succeed(
    PortBindService,
    PortBindService.of({
      list: overrides.list ?? (() => Effect.succeed([])),
      bind:
        overrides.bind ??
        ((_paths, _sessionId, containerPort, hostPort) =>
          Effect.succeed({
            hostPort:
              hostPort === null || hostPort === 0 ? containerPort : hostPort,
            probe: "ok",
          })),
      unbindByKey: overrides.unbindByKey ?? (() => Effect.void),
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
    bind: (
      paths: PortsRuntimePaths,
      sessionId: string,
      containerPort: number,
      hostPort: number | null,
    ): Promise<{ hostPort: number; probe: ProbeResult }> =>
      run((service) => service.bind(paths, sessionId, containerPort, hostPort)),
    unbindByKey: (paths: PortsRuntimePaths, key: PortBindKey): Promise<void> =>
      run((service) => service.unbindByKey(paths, key)),
  };
}
