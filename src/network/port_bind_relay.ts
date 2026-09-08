import { randomBytes } from "node:crypto";
import { chmod } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import * as path from "node:path";
import { ensureDir, safeRemove } from "../lib/fs_utils.ts";
import { logDebug } from "../log.ts";
import {
  type ListenerScope,
  MAX_LINE_BYTES,
  type ObservedListener,
  type PortForward,
  type ProbeResult,
} from "./port_bind_protocol.ts";

const PAIRING_TIMEOUT_MS = 10_000;
const HALF_OPEN_GRACE_MS = 30_000;
/**
 * Forwards live in the relay process, so losing the relay loses their
 * listeners. Waiting a moment before asking for a new one lets an ordinary
 * container stop finish first instead of exec'ing into it.
 */
const RE_ENSURE_DELAY_MS = 1_000;
const HOST = "127.0.0.1";

/** What the supervisor reports after it tries to make the relay available. */
export type EnsureRelayResult =
  | "ready"
  | "container-not-running"
  | "unreachable";

export class RelayNotReadyError extends Error {
  constructor(readonly reason: Exclude<EnsureRelayResult, "ready">) {
    super(`relay is not available: ${reason}`);
    this.name = "RelayNotReadyError";
  }
}

/**
 * Read a newline-terminated line while preserving every following byte.
 *
 * The resolved socket is paused. A caller that needs its remainder must resume
 * it (or pipe it), otherwise an eager flowing stream can lose that first data.
 */
export function readFirstLine(
  socket: Socket,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length > maxBytes)
          fail(new Error("line exceeds byte limit"));
        return;
      }
      if (newline > maxBytes) {
        fail(new Error("line exceeds byte limit"));
        return;
      }

      cleanup();
      const line = buffered.subarray(0, newline).toString("utf8");
      const remainder = buffered.subarray(newline + 1);
      socket.pause();
      if (remainder.length > 0) socket.unshift(remainder);
      resolve(line);
    };
    const onEnd = () =>
      fail(new Error("connection ended before a line arrived"));
    const onError = (error: Error) => fail(error);

    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
  });
}

/**
 * Pipe two sockets while keeping a graceful half-close intact. An abrupt
 * disconnect tears down both ends, while a peer that never finishes gets a
 * bounded grace period after the first EOF.
 */
export function pipeSockets(
  a: Socket,
  b: Socket,
  opts: { graceMs?: number } = {},
): void {
  const graceMs = opts.graceMs ?? HALF_OPEN_GRACE_MS;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = new Set<Socket>();

  const destroyBoth = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    if (!a.destroyed) a.destroy();
    if (!b.destroyed) b.destroy();
  };
  const halfClosed = (socket: Socket) => {
    ended.add(socket);
    if (ended.size === 2) {
      // `pipe()` still owns the final write that followed this EOF. Destroying
      // here can preempt that queued tail, so let both pipes close naturally.
      if (timer) clearTimeout(timer);
      timer = undefined;
    } else if (!timer) {
      timer = setTimeout(destroyBoth, graceMs);
    }
  };
  const abruptlyClosed = (socket: Socket) => {
    if (!ended.has(socket)) destroyBoth();
  };

  for (const socket of [a, b]) {
    socket.on("error", destroyBoth);
    socket.on("end", () => halfClosed(socket));
    socket.on("close", () => abruptlyClosed(socket));
  }
  a.pipe(b);
  b.pipe(a);
}

export interface RelayGateway {
  readonly socketPath: string;
  isRelayConnected(): boolean;
  openStream(port: number, signal?: AbortSignal): Promise<Socket>;
  probe(port: number): Promise<ProbeResult>;
  /**
   * Turn the container-side listener scan on or off. Enabling it starts the
   * relay if it is not running yet, which is the whole cost of the feature —
   * so nothing enables it until something actually asks for candidates.
   *
   * The request survives a relay restart: the flag is re-sent on the next
   * control connection.
   */
  watchListeners(enabled: boolean): Promise<EnsureRelayResult>;
  /** Ports last reported as listening; empty while nothing is watching. */
  listeners(): ObservedListener[];
  /**
   * Make the host's `127.0.0.1:hostPort` reachable at
   * `127.0.0.1:containerPort` inside the container. Resolves once the relay
   * is listening; a relay that cannot be started rejects with
   * {@link RelayNotReadyError}, a listen failure with the relay's reason.
   *
   * The forward survives a relay restart: it is re-sent on the next control
   * connection, and losing the relay while forwards exist asks for a new one.
   */
  forward(containerPort: number, hostPort: number): Promise<void>;
  /** Drop the forward; the relay's listener is closed if the relay is up. */
  // biome-ignore lint/suspicious/noConfusingVoidType: compatibility with gateway adapters that predate listener acknowledgements.
  unforward(containerPort: number): Promise<{ listenerClosed: boolean } | void>;
  forwards(): PortForward[];
  close(): Promise<void>;
}

type Pending = {
  kind: "open" | "probe" | "forward" | "unforward";
  resolve: (socket?: Socket) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  dispose: () => void;
};

export async function startRelayGateway(opts: {
  socketPath: string;
  ensureRelay: () => Promise<EnsureRelayResult>;
  pairingTimeoutMs?: number;
  reEnsureDelayMs?: number;
  onRelayLost?: () => void;
  onRelayConnected?: () => void;
}): Promise<RelayGateway> {
  const pairingTimeoutMs = opts.pairingTimeoutMs ?? PAIRING_TIMEOUT_MS;
  const reEnsureDelayMs = opts.reEnsureDelayMs ?? RE_ENSURE_DELAY_MS;
  const pending = new Map<string, Pending>();
  const connections = new Set<Socket>();
  const observed = new Map<number, ListenerScope>();
  /** containerPort -> forward. The record; the relay's listeners follow it. */
  const forwardTable = new Map<number, PortForward>();
  const forwardConnections = new Map<number, Set<Socket>>();
  let control: Socket | null = null;
  let watching = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let reEnsureTimer: ReturnType<typeof setTimeout> | undefined;

  const settle = (id: string, apply: (entry: Pending) => void) => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.dispose();
    apply(entry);
    return true;
  };
  const rejectPending = (error: Error) => {
    for (const id of [...pending.keys()])
      settle(id, (entry) => entry.reject(error));
  };
  const nextId = () => {
    let id: string;
    do {
      id = randomBytes(8).toString("hex");
    } while (pending.has(id));
    return id;
  };

  const sendWatch = (enabled: boolean): void => {
    const active = control;
    if (!active || active.destroyed) return;
    try {
      active.write(`watch ${enabled ? 1 : 0}\n`, () => {});
    } catch {
      // A relay that died mid-write re-sends the flag when it reconnects.
    }
  };

  const handleControlLine = (line: string): boolean => {
    if (line.startsWith("log ")) {
      logDebug(`[nas] port-relay: ${sanitize(line.slice(4))}`);
      return true;
    }

    const listen = /^listen ([0-9]{1,5}) (any|loopback|loopback6|remote)$/.exec(
      line,
    );
    if (listen) {
      const port = Number(listen[1]);
      if (port < 1 || port > 65_535) return false;
      observed.set(port, listen[2] as ListenerScope);
      return true;
    }

    const unlisten = /^unlisten ([0-9]{1,5})$/.exec(line);
    if (unlisten) {
      observed.delete(Number(unlisten[1]));
      return true;
    }

    const ok = /^ok ([0-9a-f]{16})$/.exec(line);
    if (ok) {
      settle(ok[1], (entry) => {
        if (entry.kind === "open")
          entry.reject(new Error("relay answered a stream request with ok"));
        else entry.resolve();
      });
      return true;
    }

    const fail = /^fail ([0-9a-f]{16})(?: (.*))?$/.exec(line);
    if (fail) {
      const reason = sanitize(fail[2] ?? "") || "dial failed";
      settle(fail[1], (entry) => entry.reject(new Error(reason)));
      return true;
    }

    return false;
  };

  const adoptControl = (socket: Socket) => {
    control = socket;
    let buffered = Buffer.alloc(0);
    const drop = () => {
      if (control !== socket) return;
      control = null;
      // The next relay reports its own listeners from scratch, so anything
      // this one saw is now hearsay.
      observed.clear();
      rejectPending(new Error("relay disconnected"));
      for (const connection of connections) connection.destroy();
      if (closed) return;
      opts.onRelayLost?.();
      // Forwards have no listener until a relay is back, and nothing else
      // would ask for one while the agent simply waits on a dead port.
      if (forwardTable.size > 0 && reEnsureTimer === undefined) {
        reEnsureTimer = setTimeout(() => {
          reEnsureTimer = undefined;
          if (closed || forwardTable.size === 0) return;
          void opts.ensureRelay().catch(() => {});
        }, reEnsureDelayMs);
      }
    };
    socket.resume();
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      let newline = buffered.indexOf(0x0a);
      while (newline !== -1) {
        if (newline > MAX_LINE_BYTES) {
          socket.destroy();
          return;
        }
        if (
          !handleControlLine(buffered.subarray(0, newline).toString("utf8"))
        ) {
          socket.destroy();
          return;
        }
        buffered = buffered.subarray(newline + 1);
        newline = buffered.indexOf(0x0a);
      }
      if (buffered.length > MAX_LINE_BYTES) socket.destroy();
    });
    socket.once("end", drop);
    socket.once("error", drop);
    socket.once("close", drop);
    if (watching) sendWatch(true);
    for (const forward of forwardTable.values()) {
      send("forward", forward.containerPort).catch((error) => {
        logDebug(
          `[nas] port-relay: forward ${forward.containerPort} not restored: ${error}`,
        );
      });
    }
    opts.onRelayConnected?.();
  };

  /** Host-side half of a forward: dial the host port and pipe. */
  const acceptForwardClient = (socket: Socket, containerPort: number) => {
    const forward = forwardTable.get(containerPort);
    if (!forward || closed) {
      socket.destroy();
      return;
    }
    const target = connect({
      host: HOST,
      port: forward.hostPort,
      allowHalfOpen: true,
    });
    const streams = forwardConnections.get(containerPort) ?? new Set<Socket>();
    forwardConnections.set(containerPort, streams);
    for (const stream of [socket, target]) {
      streams.add(stream);
      stream.once("close", () => {
        streams.delete(stream);
        if (
          streams.size === 0 &&
          forwardConnections.get(containerPort) === streams
        ) {
          forwardConnections.delete(containerPort);
        }
      });
    }
    const onDialError = (error: Error) => {
      logDebug(
        `[nas] port-forward: host ${forward.hostPort} unreachable: ${error}`,
      );
      target.destroy();
      socket.destroy();
    };
    target.once("error", onDialError);
    socket.once("close", () => {
      if (!target.destroyed && target.connecting) target.destroy();
    });
    target.once("connect", () => {
      target.off("error", onDialError);
      if (socket.destroyed) {
        target.destroy();
        return;
      }
      pipeSockets(socket, target);
      socket.resume();
    });
  };

  await ensureDir(path.dirname(opts.socketPath));
  await safeRemove(opts.socketPath);

  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
    readFirstLine(socket, MAX_LINE_BYTES)
      .then((line) => {
        if (line === "control") {
          if (control || closed) socket.destroy();
          else adoptControl(socket);
          return;
        }

        const client = /^client ([0-9]{1,5})$/.exec(line);
        if (client) {
          acceptForwardClient(socket, Number(client[1]));
          return;
        }

        const match = /^stream ([0-9a-f]{16})$/.exec(line);
        const id = match?.[1];
        const entry = id ? pending.get(id) : undefined;
        if (!id || !entry || entry.kind !== "open" || closed) {
          socket.destroy();
          return;
        }
        settle(id, (pendingEntry) => pendingEntry.resolve(socket));
      })
      .catch(() => socket.destroy());
  });
  server.on("error", (error) =>
    logDebug(`[nas] port-relay listener: ${error}`),
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const onListenError = (error: Error) => reject(error);
      server.once("error", onListenError);
      server.listen(opts.socketPath, () => {
        server.removeListener("error", onListenError);
        resolve();
      });
    });
    await chmod(opts.socketPath, 0o666);
  } catch (startError) {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await safeRemove(opts.socketPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [startError, cleanupError],
        "relay gateway startup and cleanup failed",
        { cause: startError },
      );
    }
    throw startError;
  }

  /** Write one request to the connected relay and await its answer. */
  const send = (
    kind: Pending["kind"],
    port: number,
    signal?: AbortSignal,
  ): Promise<Socket | undefined> => {
    const active = control;
    if (!active || active.destroyed)
      return Promise.reject(new RelayNotReadyError("unreachable"));
    if (signal?.aborted) return Promise.reject(new Error("request aborted"));

    return new Promise<Socket | undefined>((resolve, reject) => {
      const id = nextId();
      const onAbort = () => {
        settle(id, (entry) => entry.reject(new Error("request aborted")));
      };
      const dispose = () => signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        settle(id, (entry) =>
          entry.reject(new Error(`relay ${kind} timed out`)),
        );
      }, pairingTimeoutMs);
      pending.set(id, { kind, resolve, reject, timer, dispose });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        active.write(`${kind} ${id} ${port}\n`, (error) => {
          if (error) settle(id, (entry) => entry.reject(error));
        });
      } catch (error) {
        settle(id, (entry) => entry.reject(asError(error)));
      }
    });
  };

  /** Start the relay if needed, then {@link send}. */
  const request = async (
    kind: Pending["kind"],
    port: number,
    signal?: AbortSignal,
  ): Promise<Socket | undefined> => {
    const ensured = await opts.ensureRelay();
    if (ensured !== "ready") throw new RelayNotReadyError(ensured);
    return send(kind, port, signal);
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    if (reEnsureTimer !== undefined) {
      clearTimeout(reEnsureTimer);
      reEnsureTimer = undefined;
    }
    closePromise = (async () => {
      rejectPending(new Error("gateway closed"));
      for (const socket of connections) socket.destroy();
      connections.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (
            !error ||
            (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
          ) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      await safeRemove(opts.socketPath);
    })();
    return closePromise;
  };

  return {
    socketPath: opts.socketPath,
    isRelayConnected: () => control !== null && !control.destroyed,
    watchListeners: async (enabled) => {
      // A closed gateway must not exec a relay for a request that raced close.
      if (closed) return enabled ? "unreachable" : "ready";
      if (!enabled) {
        watching = false;
        observed.clear();
        sendWatch(false);
        return "ready";
      }
      watching = true;
      const ensured = await opts.ensureRelay();
      if (ensured === "ready") sendWatch(true);
      return ensured;
    },
    listeners: () =>
      [...observed.entries()]
        .map(([containerPort, scope]) => ({ containerPort, scope }))
        .sort((a, b) => a.containerPort - b.containerPort),
    openStream: async (port, signal) => {
      const socket = await request("open", port, signal);
      if (!socket) throw new Error("relay did not return a stream");
      return socket;
    },
    probe: async (port) => {
      try {
        await request("probe", port);
        return "ok";
      } catch (error) {
        if (error instanceof RelayNotReadyError) {
          return error.reason === "container-not-running"
            ? "container-not-running"
            : "relay-unreachable";
        }
        return "no-answer";
      }
    },
    forward: async (containerPort, hostPort) => {
      if (closed) throw new RelayNotReadyError("unreachable");
      // Recorded before the relay answers so a `client` line that races the
      // `ok` is served rather than refused; a failure takes it back out.
      const existing = forwardTable.get(containerPort);
      forwardTable.set(containerPort, {
        containerPort,
        hostPort,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      });
      try {
        await request("forward", containerPort);
      } catch (error) {
        if (existing) forwardTable.set(containerPort, existing);
        else forwardTable.delete(containerPort);
        throw error;
      }
    },
    unforward: async (containerPort) => {
      forwardTable.delete(containerPort);
      for (const socket of forwardConnections.get(containerPort) ?? [])
        socket.destroy();
      forwardConnections.delete(containerPort);
      if (!control || control.destroyed) return { listenerClosed: false };
      try {
        // A failed forward may have created the relay listener before its ACK
        // was lost. Ask the relay to tear it down even when the local record
        // has already been rolled back.
        await send("unforward", containerPort);
        return { listenerClosed: true };
      } catch (error) {
        // Permission is already revoked even if listener teardown is unconfirmed.
        logDebug(`[nas] port-relay: unforward ${containerPort}: ${error}`);
        return { listenerClosed: false };
      }
    },
    forwards: () =>
      [...forwardTable.values()].sort(
        (a, b) => a.containerPort - b.containerPort,
      ),
    close,
  };
}

/** Relay-authored text is attacker-chosen; strip terminal control characters. */
function sanitize(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control removal is intentional.
  return text.replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_LINE_BYTES);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
