import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  connectUnix,
  readJsonLine,
  writeJsonLine,
} from "../lib/unix_socket.ts";
import {
  hostPortCandidates,
  type PersistedPorts,
  startPortBindBroker,
} from "./port_bind_broker.ts";
import {
  type ObservedListener,
  PORT_BIND_PROTOCOL_VERSION,
  type PortBinding,
  type PortForward,
} from "./port_bind_protocol.ts";
import {
  type EnsureRelayResult,
  RelayNotReadyError,
  startRelayGateway,
} from "./port_bind_relay.ts";

test("hostPortCandidates prefers the container port, then climbs above 1024", () => {
  expect(hostPortCandidates(3000, null).slice(0, 3)).toEqual([
    3000, 3001, 3002,
  ]);
  expect(hostPortCandidates(80, null).slice(0, 3)).toEqual([80, 1024, 1025]);
  expect(hostPortCandidates(3000, null)).toHaveLength(65);
  expect(hostPortCandidates(3000, 9000)).toEqual([9000]);
});

test("hostPortCandidates never proposes a port above 65535", () => {
  expect(hostPortCandidates(65_530, null).every((port) => port <= 65_535)).toBe(
    true,
  );
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return (server.address() as { port: number }).port;
}

async function withBroker<T>(
  fn: (ctx: {
    broker: Awaited<ReturnType<typeof startPortBindBroker>>;
    written: PortBinding[][];
    echoPort: number;
  }) => Promise<T>,
  relayDelayMs = 0,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-"));
  const echo = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    socket.on("data", (chunk: Buffer) => socket.write(chunk));
  });
  let broker: Awaited<ReturnType<typeof startPortBindBroker>> | undefined;
  try {
    const echoPort = await listen(echo);
    const written: PortBinding[][] = [];
    broker = await startPortBindBroker({
      controlSocketPath: path.join(dir, "sock"),
      gateway: {
        socketPath: path.join(dir, "relay.sock"),
        isRelayConnected: () => true,
        relayCapability: () => "v2" as const,
        completeInitialForwards: () => {},
        openStream: async () => {
          await new Promise((resolve) => setTimeout(resolve, relayDelayMs));
          return connect({ port: echoPort, host: "127.0.0.1" });
        },
        probe: async () => "ok",
        watchListeners: async () => "ready" as const,
        listeners: () => [],
        forward: async () => {},
        unforward: async () => ({ listenerClosed: true }),
        forwards: () => [],
        close: async () => {},
      },
      persist: async (ports) => {
        written.push(ports.bindings.map((binding) => ({ ...binding })));
      },
    });
    return await fn({ broker, written, echoPort });
  } finally {
    await broker?.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

async function connectTcp(port: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

test("bind preserves client data while the relay stream is opening", async () => {
  await withBroker(async ({ broker }) => {
    const result = await broker.bind({ containerPort: 3000, hostPort: 0 });
    const socket = await connectTcp(result.hostPort);
    socket.write("ping");
    const echoed = await new Promise<Buffer>((resolve) =>
      socket.once("data", (data: Buffer) => resolve(data)),
    );
    expect(echoed.toString()).toBe("ping");
    socket.destroy();
  }, 20);
});

test("bind persists the binding and reports the probe result", async () => {
  await withBroker(async ({ broker, written }) => {
    const result = await broker.bind({ containerPort: 3000, hostPort: 0 });
    expect(result.probe).toBe("ok");
    expect(written.at(-1)?.[0]?.containerPort).toBe(3000);
  });
});

test("re-binding the same container port returns the open host port", async () => {
  await withBroker(async ({ broker }) => {
    const first = await broker.bind({ containerPort: 3000, hostPort: 0 });
    const second = await broker.bind({ containerPort: 3000, hostPort: null });
    expect(second.hostPort).toBe(first.hostPort);
  });
});

test("concurrent binds of one container port share one listener", async () => {
  await withBroker(async ({ broker }) => {
    const [first, second] = await Promise.all([
      broker.bind({ containerPort: 3000, hostPort: 0 }),
      broker.bind({ containerPort: 3000, hostPort: null }),
    ]);
    expect(second.hostPort).toBe(first.hostPort);
    expect(broker.listBindings()).toHaveLength(1);
  });
});

test("re-binding with a different explicit host port is a conflict", async () => {
  await withBroker(async ({ broker }) => {
    const first = await broker.bind({ containerPort: 3000, hostPort: 0 });
    await expect(
      broker.bind({ containerPort: 3000, hostPort: first.hostPort + 1 }),
    ).rejects.toThrow("binding-conflict");
  });
});

test("an explicitly requested host port that is taken fails without shifting", async () => {
  await withBroker(async ({ broker, echoPort }) => {
    await expect(
      broker.bind({ containerPort: 3000, hostPort: echoPort }),
    ).rejects.toThrow("host-port-taken");
  });
});

test("a failed bind persistence closes and forgets the listener", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-persist-"));
  let fail = true;
  const broker = await startPortBindBroker({
    controlSocketPath: path.join(dir, "sock"),
    gateway: {
      socketPath: path.join(dir, "relay.sock"),
      isRelayConnected: () => true,
      relayCapability: () => "v2" as const,
      completeInitialForwards: () => {},
      openStream: async () => {
        throw new Error("unused");
      },
      probe: async () => "ok",
      watchListeners: async () => "ready" as const,
      listeners: () => [],
      forward: async () => {},
      unforward: async () => ({ listenerClosed: true }),
      forwards: () => [],
      close: async () => {},
    },
    persist: async () => {
      if (fail) throw new Error("write failed");
    },
  });
  try {
    await expect(
      broker.bind({ containerPort: 3000, hostPort: 0 }),
    ).rejects.toThrow("write failed");
    expect(broker.listBindings()).toEqual([]);
    fail = false;
    await expect(
      broker.bind({ containerPort: 3000, hostPort: 0 }),
    ).resolves.toMatchObject({ probe: "ok" });
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unbind revokes a binding even when persistence fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-persist-"));
  let fail = false;
  const broker = await startPortBindBroker({
    controlSocketPath: path.join(dir, "sock"),
    gateway: {
      socketPath: path.join(dir, "relay.sock"),
      isRelayConnected: () => true,
      relayCapability: () => "v2" as const,
      completeInitialForwards: () => {},
      openStream: async () => {
        throw new Error("unused");
      },
      probe: async () => "ok",
      watchListeners: async () => "ready" as const,
      listeners: () => [],
      forward: async () => {},
      unforward: async () => ({ listenerClosed: true }),
      forwards: () => [],
      close: async () => {},
    },
    persist: async () => {
      if (fail) throw new Error("write failed");
    },
  });
  try {
    const bound = await broker.bind({ containerPort: 3000, hostPort: 0 });
    fail = true;
    await expect(broker.unbind({ containerPort: 3000 })).rejects.toThrow(
      "write failed",
    );
    expect(broker.listBindings()).toHaveLength(0);
    await expect(connectTcp(bound.hostPort)).rejects.toThrow();
  } finally {
    fail = false;
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close drains an accepted bind and rejects later mutations", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-close-"));
  let releasePersist: (() => void) | undefined;
  const persistGate = new Promise<void>((resolve) => {
    releasePersist = resolve;
  });
  const broker = await startPortBindBroker({
    controlSocketPath: path.join(dir, "sock"),
    gateway: {
      socketPath: path.join(dir, "relay.sock"),
      isRelayConnected: () => true,
      relayCapability: () => "v2" as const,
      completeInitialForwards: () => {},
      openStream: async () => {
        throw new Error("unused");
      },
      probe: async () => "ok",
      watchListeners: async () => "ready" as const,
      listeners: () => [],
      forward: async () => {},
      unforward: async () => ({ listenerClosed: true }),
      forwards: () => [],
      close: async () => {},
    },
    persist: async () => persistGate,
  });
  let closing: Promise<void> | undefined;
  try {
    const accepted = broker.bind({ containerPort: 3000, hostPort: 0 });
    closing = broker.close();
    const rejected = broker.bind({ containerPort: 4000, hostPort: 0 });
    releasePersist?.();
    await expect(rejected).rejects.toThrow("broker is closed");
    const [{ hostPort }] = await Promise.all([accepted, closing]);
    expect(broker.listBindings()).toEqual([]);
    await expect(connectTcp(hostPort)).rejects.toThrow();
  } finally {
    releasePersist?.();
    await (closing ?? broker.close());
    await rm(dir, { recursive: true, force: true });
  }
});

test("close destroys a control client waiting on an incomplete line", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-close-"));
  const broker = await startPortBindBroker({
    controlSocketPath: path.join(dir, "sock"),
    gateway: {
      socketPath: path.join(dir, "relay.sock"),
      isRelayConnected: () => true,
      relayCapability: () => "v2" as const,
      completeInitialForwards: () => {},
      openStream: async () => {
        throw new Error("unused");
      },
      probe: async () => "ok",
      watchListeners: async () => "ready" as const,
      listeners: () => [],
      forward: async () => {},
      unforward: async () => ({ listenerClosed: true }),
      forwards: () => [],
      close: async () => {},
    },
    persist: async () => {},
  });
  const socket = await new Promise<Socket>((resolve, reject) => {
    const connecting = connect({ path: broker.controlSocketPath });
    connecting.once("connect", () => resolve(connecting));
    connecting.once("error", reject);
  });
  socket.write("{");
  const closing = broker.close();
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      closing.then(() => "closed"),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("timed-out"), 100);
      }),
    ]);
    clearTimeout(timeout);
    expect(result).toBe("closed");
  } finally {
    socket.destroy();
    await closing;
    await rm(dir, { recursive: true, force: true });
  }
});

test("unbind closes the listener and its live connections without waiting", async () => {
  await withBroker(async ({ broker, written }) => {
    const bound = await broker.bind({ containerPort: 3000, hostPort: 0 });
    const browser = await connectTcp(bound.hostPort);
    await broker.unbind({ containerPort: 3000 });
    expect(written.at(-1)).toEqual([]);
    await expect(connectTcp(bound.hostPort)).rejects.toThrow();
    browser.destroy();
  });
});

test("a browser that disconnects while waiting cancels the stream request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-cancel-"));
  const aborts: boolean[] = [];
  const broker = await startPortBindBroker({
    controlSocketPath: path.join(dir, "sock"),
    gateway: {
      socketPath: path.join(dir, "relay.sock"),
      isRelayConnected: () => true,
      relayCapability: () => "v2" as const,
      completeInitialForwards: () => {},
      openStream: (_port, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborts.push(true);
            reject(new Error("request aborted"));
          });
        }),
      probe: async () => "ok",
      watchListeners: async () => "ready" as const,
      listeners: () => [],
      forward: async () => {},
      unforward: async () => ({ listenerClosed: true }),
      forwards: () => [],
      close: async () => {},
    },
    persist: async () => {},
  });
  try {
    const bound = await broker.bind({ containerPort: 3000, hostPort: 0 });
    const browser = await connectTcp(bound.hostPort);
    browser.destroy();
    for (let i = 0; i < 100 && aborts.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(aborts).toEqual([true]);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unbind of an unknown port reports no-such-binding", async () => {
  await withBroker(async ({ broker }) => {
    await expect(broker.unbind({ hostPort: 65_000 })).rejects.toThrow(
      "no-such-binding",
    );
  });
});

async function controlRequest(socketPath: string, request: unknown) {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const connecting = connect({ path: socketPath });
    connecting.once("connect", () => resolve(connecting));
    connecting.once("error", reject);
  });
  socket.write(`${JSON.stringify(request)}\n`);
  const reply = await new Promise<string>((resolve) =>
    socket.once("data", (data: Buffer) => resolve(data.toString())),
  );
  socket.destroy();
  return JSON.parse(reply) as Record<string, unknown>;
}

test("the control socket answers a bind request", async () => {
  await withBroker(async ({ broker }) => {
    const reply = await controlRequest(broker.controlSocketPath, {
      type: "bind",
      containerPort: 3000,
      hostPort: 0,
    });
    expect(reply.ok).toBe(true);
    expect(reply.hostPort).toBeGreaterThan(0);
  });
});

test("the control socket rejects invalid request shapes", async () => {
  await withBroker(async ({ broker }) => {
    const invalid = [
      { type: "bind", containerPort: 70_000, hostPort: null },
      { type: "bind", containerPort: 3000 },
      { type: "unbind", containerPort: 3000, hostPort: 4000 },
      { type: "unbind", containerPort: 3000, extra: true },
      { type: "unknown", containerPort: 3000 },
    ];
    for (const request of invalid) {
      expect(
        await controlRequest(broker.controlSocketPath, request),
      ).toMatchObject({ ok: false, error: "invalid-request" });
    }
  });
});

async function withCandidateBroker<T>(
  opts: {
    listeners: ObservedListener[];
    reservedPorts?: number[];
    watchLeaseMs?: number;
    ensure?: () => EnsureRelayResult;
  },
  fn: (ctx: {
    broker: Awaited<ReturnType<typeof startPortBindBroker>>;
    controlSocketPath: string;
    watchCalls: boolean[];
  }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-candidates-"));
  const controlSocketPath = path.join(dir, "sock");
  const watchCalls: boolean[] = [];
  let broker: Awaited<ReturnType<typeof startPortBindBroker>> | undefined;
  try {
    broker = await startPortBindBroker({
      controlSocketPath,
      gateway: {
        socketPath: path.join(dir, "relay.sock"),
        isRelayConnected: () => true,
        relayCapability: () => "v2" as const,
        completeInitialForwards: () => {},
        openStream: async () => {
          throw new Error("unused");
        },
        probe: async () => "ok",
        watchListeners: async (enabled) => {
          watchCalls.push(enabled);
          return opts.ensure?.() ?? "ready";
        },
        listeners: () => opts.listeners,
        forward: async () => {},
        unforward: async () => ({ listenerClosed: true }),
        forwards: () => [],
        close: async () => {},
      },
      persist: async () => {},
      reservedPorts: opts.reservedPorts,
      watchLeaseMs: opts.watchLeaseMs,
    });
    return await fn({ broker, controlSocketPath, watchCalls });
  } finally {
    await broker?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("candidates drop bound ports, nas ports, and flag unreachable ones", async () => {
  await withCandidateBroker(
    {
      listeners: [
        { containerPort: 3000, scope: "any" },
        { containerPort: 5173, scope: "remote" },
        { containerPort: 2375, scope: "any" },
      ],
      reservedPorts: [2375],
    },
    async ({ broker, watchCalls }) => {
      await broker.bind({ containerPort: 3000, hostPort: 0 });
      const result = await broker.candidates();
      expect(result).toEqual({
        candidates: [
          { containerPort: 5173, scope: "remote", reachable: false },
        ],
        watch: "watching",
      });
      // Asking is what starts the scan; nothing else turned it on.
      expect(watchCalls).toEqual([true]);
    },
  );
});

test("the scan stops once nothing renews the lease", async () => {
  await withCandidateBroker(
    { listeners: [{ containerPort: 3000, scope: "any" }], watchLeaseMs: 40 },
    async ({ broker, watchCalls }) => {
      await broker.candidates();
      await broker.candidates();
      expect(watchCalls).toEqual([true, true]);
      for (let attempt = 0; attempt < 40 && watchCalls.length < 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(watchCalls.at(-1)).toBe(false);
    },
  );
});

test("a container that cannot be reached reports why instead of an empty scan", async () => {
  await withCandidateBroker(
    { listeners: [], ensure: () => "container-not-running" },
    async ({ broker }) => {
      expect(await broker.candidates()).toEqual({
        candidates: [],
        watch: "container-not-running",
      });
    },
  );
});

test("the control socket answers a candidates request", async () => {
  await withCandidateBroker(
    { listeners: [{ containerPort: 5173, scope: "loopback" }] },
    async ({ controlSocketPath }) => {
      const socket = await connectUnix(controlSocketPath);
      try {
        await writeJsonLine(socket, { type: "candidates" });
        const line = await readJsonLine(socket, 8192);
        expect(JSON.parse(line ?? "null")).toEqual({
          ok: true,
          candidates: [
            { containerPort: 5173, scope: "loopback", reachable: true },
          ],
          watch: "watching",
        });
      } finally {
        socket.destroy();
      }
    },
  );
});

/** A gateway whose forwards are plain bookkeeping, plus what it was asked. */
function forwardingGateway(opts: {
  ensure?: () => EnsureRelayResult;
  listenError?: string;
  forwardGate?: () => Promise<void>;
  listeners?: ObservedListener[];
}) {
  const table = new Map<number, PortForward>();
  const requests: string[] = [];
  const gateway = {
    socketPath: "unused",
    isRelayConnected: () => true,
    relayCapability: () => "v2" as const,
    completeInitialForwards: () => {},
    openStream: async () => {
      throw new Error("unused");
    },
    probe: async () => "ok" as const,
    watchListeners: async () => "ready" as const,
    listeners: () => opts.listeners ?? [],
    forward: async (containerPort: number, hostPort: number) => {
      requests.push(`forward ${containerPort} ${hostPort}`);
      const ensured = opts.ensure?.() ?? "ready";
      if (ensured !== "ready") throw new RelayNotReadyError(ensured);
      if (opts.listenError) throw new Error(opts.listenError);
      await opts.forwardGate?.();
      table.set(containerPort, {
        containerPort,
        hostPort,
        createdAt: "2026-09-08T00:00:00.000Z",
      });
    },
    unforward: async (containerPort: number) => {
      requests.push(`unforward ${containerPort}`);
      table.delete(containerPort);
      return { listenerClosed: true };
    },
    forwards: () => [...table.values()],
    close: async () => {},
  };
  return { gateway, requests };
}

async function withForwardBroker<T>(
  opts: {
    ensure?: () => EnsureRelayResult;
    listenError?: string;
    forwardGate?: () => Promise<void>;
    listeners?: ObservedListener[];
    persist?: (ports: PersistedPorts) => Promise<void>;
    reservedPorts?: number[];
  },
  fn: (ctx: {
    broker: Awaited<ReturnType<typeof startPortBindBroker>>;
    requests: string[];
    written: PersistedPorts[];
    controlSocketPath: string;
    echoPort: number;
  }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-forward-"));
  const controlSocketPath = path.join(dir, "sock");
  const echo = createServer((socket: Socket) => socket.end());
  const written: PersistedPorts[] = [];
  const { gateway, requests } = forwardingGateway(opts);
  let broker: Awaited<ReturnType<typeof startPortBindBroker>> | undefined;
  try {
    const echoPort = await listen(echo);
    broker = await startPortBindBroker({
      controlSocketPath,
      gateway,
      persist:
        opts.persist ??
        (async (ports) => {
          written.push(structuredClone(ports));
        }),
      reservedPorts: opts.reservedPorts,
      now: () => new Date("2026-09-08T00:00:00.000Z"),
    });
    return await fn({ broker, requests, written, controlSocketPath, echoPort });
  } finally {
    await broker?.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

test("forward asks the relay to listen, persists, and probes the host port", async () => {
  await withForwardBroker(
    {},
    async ({ broker, requests, written, echoPort }) => {
      const result = await broker.forward({
        containerPort: 5432,
        hostPort: echoPort,
      });
      expect(result).toEqual({
        containerPort: 5432,
        hostPort: echoPort,
        hostProbe: "ok",
      });
      expect(requests).toEqual([`forward 5432 ${echoPort}`]);
      expect(written.at(-1)).toMatchObject({
        bindings: [],
        forwards: [
          {
            containerPort: 5432,
            hostPort: echoPort,
            createdAt: "2026-09-08T00:00:00.000Z",
          },
        ],
      });
      expect(broker.listForwards()).toHaveLength(1);
    },
  );
});

test("a forward to a host port nothing listens on is kept and reported", async () => {
  await withForwardBroker({}, async ({ broker }) => {
    const closedPort = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });
    const result = await broker.forward({
      containerPort: 5432,
      hostPort: closedPort,
    });
    expect(result.hostProbe).toEqual("no-answer");
    expect(broker.listPortForwards()[0]?.state).toBe("active");
    expect(broker.listForwards()).toHaveLength(1);
  });
});

test("repeating a forward returns the open mapping without asking the relay again", async () => {
  await withForwardBroker({}, async ({ broker, requests, echoPort }) => {
    await broker.forward({ containerPort: 5432, hostPort: echoPort });
    const again = await broker.forward({
      containerPort: 5432,
      hostPort: echoPort,
    });
    expect(again.hostPort).toEqual(echoPort);
    expect(requests).toHaveLength(1);
  });
});

test("forwarding a container port to a different host port is a conflict", async () => {
  await withForwardBroker({}, async ({ broker, echoPort }) => {
    await broker.forward({ containerPort: 5432, hostPort: echoPort });
    await expect(
      broker.forward({ containerPort: 5432, hostPort: echoPort + 1 }),
    ).rejects.toThrow("binding-conflict");
  });
});

test("a container port nas itself binds cannot be forwarded", async () => {
  await withForwardBroker(
    { reservedPorts: [18_080] },
    async ({ broker, requests }) => {
      await expect(
        broker.forward({ containerPort: 18_080, hostPort: 8080 }),
      ).rejects.toThrow("container-port-taken");
      expect(requests).toEqual([]);
    },
  );
});

test("a relay that cannot start makes the forward fail as unavailable", async () => {
  await withForwardBroker(
    { ensure: () => "container-not-running" },
    async ({ broker, written }) => {
      await expect(
        broker.forward({ containerPort: 5432, hostPort: 5432 }),
      ).rejects.toThrow("relay-unavailable");
      expect(written).toEqual([]);
    },
  );
});

test("a relay that cannot listen reports the container port as taken", async () => {
  await withForwardBroker({ listenError: "EADDRINUSE" }, async ({ broker }) => {
    await expect(
      broker.forward({ containerPort: 5432, hostPort: 5432 }),
    ).rejects.toThrow("EADDRINUSE");
    expect(broker.listForwards()).toEqual([]);
  });
});

test("a failed forward persistence takes the listener back down", async () => {
  await withForwardBroker(
    {
      persist: async () => {
        throw new Error("disk full");
      },
    },
    async ({ broker, requests }) => {
      await expect(
        broker.forward({ containerPort: 5432, hostPort: 5432 }),
      ).rejects.toThrow("disk full");
      expect(requests).toEqual(["forward 5432 5432", "unforward 5432"]);
    },
  );
});

test("a timed-out forward rejects pre-ACK streams and attempts token listener teardown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-timeout-"));
  const relaySocketPath = path.join(dir, "relay.sock");
  const echo = createServer({ allowHalfOpen: true });
  let broker: Awaited<ReturnType<typeof startPortBindBroker>> | undefined;
  let relay: Socket | undefined;
  let client: Socket | undefined;
  try {
    let accepted = 0;
    echo.on("connection", (socket: Socket) => {
      accepted += 1;
      socket.destroy();
    });
    const hostPort = await listen(echo);
    const gateway = await startRelayGateway({
      socketPath: relaySocketPath,
      ensureRelay: async () => "ready",
      pairingTimeoutMs: 250,
    });
    broker = await startPortBindBroker({
      controlSocketPath: path.join(dir, "broker.sock"),
      gateway,
      persist: async () => {},
    });

    const relayLines: string[] = [];
    let buffered = "";
    relay = connect({ path: relaySocketPath });
    relay.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        relayLines.push(line);
        buffered = buffered.slice(newline + 1);
        const [verb, id] = line.split(" ");
        if (verb === "unforward") relay?.write(`ok ${id}\n`);
        newline = buffered.indexOf("\n");
      }
    });
    relay.write("control-v2\n");
    for (
      let attempt = 0;
      attempt < 100 && !gateway.isRelayConnected();
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(gateway.isRelayConnected()).toBe(true);

    const adding = broker.addPortForward(
      { direction: "remote", containerPort: 5432, hostPort },
      "dynamic",
    );
    const addOutcome = adding.then(
      () => new Error("expected forward to time out"),
      (error: Error) => error,
    );
    for (
      let attempt = 0;
      attempt < 100 && !relayLines.some((line) => line.startsWith("forward "));
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(relayLines.some((line) => line.startsWith("forward "))).toBe(true);

    client = connect({ path: relaySocketPath });
    const token = relayLines
      .find((line) => line.startsWith("forward "))
      ?.split(" ")[2];
    const clientClosed = new Promise<void>((resolve) =>
      client?.once("close", () => resolve()),
    );
    client.write(`client ${token}\nping`);
    client.resume();
    await clientClosed;
    expect(accepted).toBe(0);
    expect((await addOutcome).message).toContain("timed out");
    expect(
      relayLines.some(
        (line) => line.startsWith("unforward ") && line.endsWith(` ${token}`),
      ),
    ).toBe(true);
    expect(client.destroyed).toBe(true);
    expect(broker.listPortForwards()).toEqual([]);
  } finally {
    client?.destroy();
    relay?.destroy();
    await broker?.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("unforward persists the remaining forwards and closes the listener", async () => {
  await withForwardBroker(
    {},
    async ({ broker, requests, written, echoPort }) => {
      await broker.forward({ containerPort: 5432, hostPort: echoPort });
      await broker.forward({ containerPort: 6379, hostPort: echoPort });
      await broker.unforward(5432);
      expect(written.at(-1)?.forwards.map((f) => f.containerPort)).toEqual([
        6379,
      ]);
      expect(requests.at(-1)).toEqual("unforward 5432");
      await expect(broker.unforward(5432)).rejects.toThrow("no-such-binding");
    },
  );
});

test("the control socket answers forward and unforward requests", async () => {
  await withForwardBroker(
    {},
    async ({ broker, controlSocketPath, echoPort }) => {
      const ask = async (request: unknown) => {
        const socket = await connectUnix(controlSocketPath);
        await writeJsonLine(socket, request);
        const line = await readJsonLine(socket);
        socket.destroy();
        return line === null ? null : JSON.parse(line);
      };
      expect(
        await ask({ type: "forward", containerPort: 5432, hostPort: echoPort }),
      ).toEqual({
        ok: true,
        containerPort: 5432,
        hostPort: echoPort,
        hostProbe: "ok",
      });
      expect(await ask({ type: "forward", containerPort: 5432 })).toEqual({
        ok: false,
        error: "invalid-request",
        message: expect.any(String),
      });
      expect(await ask({ type: "unforward", containerPort: 5432 })).toEqual({
        ok: true,
      });
      expect(broker.listForwards()).toEqual([]);
    },
  );
});

test("the common control wire validates shape and returns managed state", async () => {
  await withForwardBroker(
    {},
    async ({ broker, controlSocketPath, echoPort }) => {
      const ask = async (request: unknown) => {
        const socket = await connectUnix(controlSocketPath);
        await writeJsonLine(socket, request);
        const line = await readJsonLine(socket);
        socket.destroy();
        return line === null ? null : JSON.parse(line);
      };
      const added = await ask({
        type: "add-forward",
        direction: "remote",
        containerPort: 5432,
        hostPort: echoPort,
      });
      expect(added).toMatchObject({
        ok: true,
        entry: {
          direction: "remote",
          containerPort: 5432,
          hostPort: echoPort,
          owners: ["dynamic"],
          state: "active",
        },
        probe: "ok",
      });
      expect(
        await ask({
          type: "add-forward",
          direction: "remote",
          containerPort: 5432,
          hostPort: echoPort + 1,
        }),
      ).toMatchObject({ ok: false, error: "binding-conflict" });
      for (const extra of [{ owner: "internal" }, { origin: "internal" }]) {
        expect(
          await ask({
            type: "add-forward",
            direction: "remote",
            containerPort: 6379,
            hostPort: echoPort,
            ...extra,
          }),
        ).toMatchObject({ ok: false, error: "invalid-request" });
      }
      expect(
        await ask({
          type: "remove-forward",
          direction: "remote",
          containerPort: 5432,
        }),
      ).toEqual({
        ok: true,
        removed: true,
        retainedInternal: false,
        listenerClosed: true,
      });
      expect(broker.listPortForwards()).toEqual([]);
    },
  );
});

test("common additions serialize ownership and share the remote listener", async () => {
  await withForwardBroker(
    {},
    async ({ broker, requests, echoPort, written }) => {
      const spec = {
        direction: "remote",
        containerPort: 5432,
        hostPort: echoPort,
      } as const;
      await Promise.all([
        broker.addPortForward(spec, "config"),
        broker.addPortForward(spec, "dynamic"),
        broker.addPortForward(spec, "internal"),
      ]);
      expect(requests).toEqual([`forward 5432 ${echoPort}`]);
      expect(broker.listPortForwards()).toEqual([
        {
          ...spec,
          owners: ["config", "dynamic", "internal"],
          createdAt: "2026-09-08T00:00:00.000Z",
          state: "active",
        },
      ]);
      expect(written.at(-1)?.portForwards).toEqual(broker.listPortForwards());
      expect(written.at(-1)?.protocolVersion).toBe(PORT_BIND_PROTOCOL_VERSION);
      const removed = await broker.removePortForward(spec);
      expect(removed).toEqual({
        removed: true,
        retainedInternal: true,
        listenerClosed: false,
      });
      expect(broker.listPortForwards()[0]?.owners).toEqual(["internal"]);
      expect(await broker.removePortForward(spec)).toEqual({
        removed: false,
        retainedInternal: true,
        listenerClosed: false,
      });
      expect(requests).toHaveLength(1);
    },
  );
});

test("config removal is session-local and duplicate removals are serialized", async () => {
  await withForwardBroker({}, async ({ broker, requests, echoPort }) => {
    const spec = {
      direction: "remote",
      containerPort: 5432,
      hostPort: echoPort,
    } as const;
    await broker.addPortForward(spec, "config");
    const results = await Promise.allSettled([
      broker.removePortForward(spec),
      broker.removePortForward(spec),
    ]);
    expect(results[0]).toEqual({
      status: "fulfilled",
      value: { removed: true, retainedInternal: false, listenerClosed: true },
    });
    expect(results[1]?.status).toBe("rejected");
    expect(broker.listPortForwards()).toEqual([]);
    expect(requests).toEqual([`forward 5432 ${echoPort}`, "unforward 5432"]);
  });
});

test("failed delete persistence retries the revoked snapshot without restoring permission", async () => {
  let writes = 0;
  const snapshots: PersistedPorts[] = [];
  await withForwardBroker(
    {
      persist: async (ports) => {
        snapshots.push(structuredClone(ports));
        if (++writes === 2) throw new Error("disk full");
      },
    },
    async ({ broker, requests, echoPort }) => {
      const spec = {
        direction: "remote",
        containerPort: 5432,
        hostPort: echoPort,
      } as const;
      await broker.addPortForward(spec, "config");
      await expect(broker.removePortForward(spec)).rejects.toThrow("disk full");
      expect(broker.listPortForwards()).toEqual([]);
      expect(requests.at(-1)).toBe("unforward 5432");
      expect(snapshots).toHaveLength(3);
      expect(snapshots[2]?.portForwards).toEqual([]);
    },
  );
});

test("failed owner persistence restores existing ownership without revoking its listener", async () => {
  let fail = false;
  await withForwardBroker(
    {
      persist: async () => {
        if (fail) throw new Error("disk full");
      },
    },
    async ({ broker, requests, echoPort }) => {
      const spec = {
        direction: "remote",
        containerPort: 5432,
        hostPort: echoPort,
      } as const;
      await broker.addPortForward(spec, "internal");
      fail = true;
      await expect(broker.addPortForward(spec, "dynamic")).rejects.toThrow(
        "disk full",
      );
      expect(broker.listPortForwards()[0]?.owners).toEqual(["internal"]);
      expect(requests).toHaveLength(1);
    },
  );
});

test("both directions coexist while a longer forwarding cycle is rejected", async () => {
  await withForwardBroker({}, async ({ broker }) => {
    const first = await broker.bind({ containerPort: 3000, hostPort: 0 });
    const second = await broker.bind({ containerPort: 4000, hostPort: 0 });
    await broker.addPortForward(
      { direction: "remote", containerPort: 3000, hostPort: second.hostPort },
      "dynamic",
    );
    await expect(
      broker.addPortForward(
        { direction: "remote", containerPort: 4000, hostPort: first.hostPort },
        "dynamic",
      ),
    ).rejects.toThrow("binding-conflict");
    await broker.removePortForward({ direction: "local", containerPort: 3000 });
    expect(
      broker
        .listPortForwards()
        .some(
          (entry) =>
            entry.direction === "remote" && entry.containerPort === 3000,
        ),
    ).toBe(true);
  });
});

test("remote listeners are excluded from local candidates", async () => {
  await withCandidateBroker(
    {
      listeners: [
        { containerPort: 5432, scope: "loopback" },
        { containerPort: 3000, scope: "any" },
      ],
    },
    async ({ broker }) => {
      await broker.addPortForward(
        { direction: "remote", containerPort: 5432, hostPort: 5432 },
        "dynamic",
      );
      expect(
        (await broker.candidates()).candidates.map(
          (entry) => entry.containerPort,
        ),
      ).toEqual([3000]);
    },
  );
});

test("a pending remote listener is visible as pending and excluded from candidates", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withForwardBroker(
    {
      forwardGate: () => gate,
      listeners: [{ containerPort: 5432, scope: "loopback" }],
    },
    async ({ broker, requests, echoPort }) => {
      const adding = broker.addPortForward(
        { direction: "remote", containerPort: 5432, hostPort: echoPort },
        "dynamic",
      );
      try {
        for (let attempt = 0; attempt < 50 && requests.length === 0; attempt++)
          await new Promise((resolve) => setTimeout(resolve, 1));
        expect(broker.listPortForwards()[0]?.state).toBe("pending");
        expect((await broker.candidates()).candidates).toEqual([]);
      } finally {
        release?.();
        await adding;
      }
      expect(broker.listPortForwards()[0]?.state).toBe("active");
    },
  );
});

test("local ownership uses the shared model and returned snapshots cannot mutate it", async () => {
  await withBroker(async ({ broker }) => {
    const bound = await broker.bind({ containerPort: 3000, hostPort: 0 });
    const spec = {
      direction: "local",
      containerPort: 3000,
      hostPort: bound.hostPort,
    } as const;
    const added = await broker.addPortForward(spec, "internal");
    added.entry.owners.length = 0;
    broker.listPortForwards()[0]!.owners.length = 0;
    expect(broker.listPortForwards()[0]?.owners).toEqual([
      "dynamic",
      "internal",
    ]);
    expect(await broker.removePortForward(spec)).toEqual({
      removed: true,
      retainedInternal: true,
      listenerClosed: false,
    });
    const socket = await connectTcp(bound.hostPort);
    socket.destroy();
    await expect(
      broker.addPortForward({ ...spec, containerPort: 4000 }, "dynamic"),
    ).rejects.toThrow("binding-conflict");
  });
});

test("relay state updates are persisted in order and stale events cannot affect a re-added mapping", async () => {
  await withForwardBroker({}, async ({ broker, written, echoPort }) => {
    const spec = {
      direction: "remote" as const,
      containerPort: 5432,
      hostPort: echoPort,
    };
    await broker.addPortForward(spec, "dynamic");
    broker.onForwardState(5432, "unavailable", "relay disconnected");
    broker.onForwardState(5432, "failed", "EADDRINUSE");
    // A serialized API request is also a barrier for earlier state events.
    await broker.addPortForward(spec, "dynamic");
    expect(written.at(-1)?.portForwards[0]).toMatchObject({
      state: "failed",
      error: "EADDRINUSE",
    });
    broker.onForwardState(5432, "active");
    await broker.addPortForward(spec, "dynamic");
    expect(written.at(-1)?.portForwards[0]).toMatchObject({ state: "active" });
    expect(written.at(-1)?.portForwards[0]).not.toHaveProperty("error");

    const removing = broker.removePortForward(spec);
    const replacing = broker.addPortForward(spec, "dynamic");
    // This event refers to the old generation, even with the same port and time.
    broker.onForwardState(5432, "failed", "stale failure");
    await Promise.all([removing, replacing]);
    await broker.addPortForward(spec, "dynamic");
    expect(broker.listPortForwards()[0]).toMatchObject({ state: "active" });
    expect(broker.listPortForwards()[0]).not.toHaveProperty("error");
  });
});

test("persistence rollback closes both token streams and rejects the saved token", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-token-"));
  const socketPath = path.join(dir, "relay.sock");
  const echo = createServer({ allowHalfOpen: true }, (socket: Socket) =>
    socket.pipe(socket),
  );
  let broker: Awaited<ReturnType<typeof startPortBindBroker>> | undefined;
  let relay: Socket | undefined;
  let client: Socket | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let persisting = false;
  try {
    const hostPort = await listen(echo);
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    broker = await startPortBindBroker({
      controlSocketPath: path.join(dir, "control.sock"),
      gateway,
      persist: async () => {
        persisting = true;
        await gate;
        throw new Error("disk full");
      },
    });
    const lines: string[] = [];
    relay = connect({ path: socketPath });
    let buffered = "";
    relay.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let end = buffered.indexOf("\n");
      while (end !== -1) {
        const line = buffered.slice(0, end);
        lines.push(line);
        buffered = buffered.slice(end + 1);
        relay?.write(`ok ${line.split(" ")[1]}\n`);
        end = buffered.indexOf("\n");
      }
    });
    relay.write("control-v2\n");
    for (let i = 0; i < 100 && !gateway.isRelayConnected(); i++)
      await new Promise((r) => setTimeout(r, 5));
    const result = broker
      .addPortForward(
        { direction: "remote", containerPort: 5432, hostPort },
        "dynamic",
      )
      .catch((error: Error) => error);
    for (let i = 0; i < 100 && !persisting; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(persisting).toBe(true);
    const token = lines
      .find((line) => line.startsWith("forward "))!
      .split(" ")[2];
    const targetAccepted = new Promise<Socket>((resolve) =>
      echo.once("connection", resolve),
    );
    client = connect({ path: socketPath });
    const echoed = new Promise<Buffer>((resolve) =>
      client?.once("data", resolve),
    );
    client.write(`client ${token}\nping`);
    const target = await targetAccepted;
    expect((await echoed).toString()).toBe("ping");
    const clientClosed = new Promise<void>((resolve) =>
      client?.once("close", resolve),
    );
    const targetClosed = new Promise<void>((resolve) =>
      target.once("close", resolve),
    );
    release();
    expect(await result).toMatchObject({ message: "disk full" });
    await Promise.all([clientClosed, targetClosed]);
    expect(gateway.forwards()).toEqual([]);
    const stale = connect({ path: socketPath });
    try {
      const closed = new Promise<void>((resolve) =>
        stale.once("close", resolve),
      );
      stale.write(`client ${token}\nping`);
      await closed;
    } finally {
      stale.destroy();
    }
  } finally {
    release();
    client?.destroy();
    relay?.destroy();
    await broker?.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

async function withInitialBroker(
  fn: (ctx: {
    broker: Awaited<ReturnType<typeof startPortBindBroker>>;
    events: string[];
    complete: Promise<string | undefined>;
    connect: () => void;
    persistWith: (persist: (ports: PersistedPorts) => Promise<void>) => void;
  }) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-initial-"));
  const events: string[] = [];
  let connected = false;
  let persistHook = async (_ports: PersistedPorts) => {};
  let finish!: (error?: string) => void;
  const complete = new Promise<string | undefined>((resolve) => {
    finish = resolve;
  });
  const broker = await startPortBindBroker({
    controlSocketPath: path.join(dir, "sock"),
    gateway: {
      socketPath: path.join(dir, "relay.sock"),
      isRelayConnected: () => connected,
      relayCapability: () => "v2",
      completeInitialForwards: (error) => {
        if (!connected) throw new RelayNotReadyError("unreachable");
        events.push(error ? "failed" : "ready");
      },
      openStream: async () => {
        throw new Error("not launched");
      },
      probe: async () => "no-answer",
      watchListeners: async () => "ready",
      listeners: () => [],
      forwards: () => [],
      forward: async () => {
        events.push("forward");
      },
      unforward: async (port) => {
        events.push(`unforward:${port}`);
        return { listenerClosed: true };
      },
      close: async () => {},
    },
    persist: async (ports) => {
      events.push(
        `persist:${ports.portForwards.map((entry) => entry.state).join(",")}`,
      );
      await persistHook(ports);
    },
    reservedPorts: [18080],
    onInitialComplete: finish,
  });
  try {
    await fn({
      broker,
      events,
      complete,
      connect: () => {
        connected = true;
        broker.onRelayConnected();
      },
      persistWith: (hook) => {
        persistHook = hook;
      },
    });
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const initialRemote = {
  direction: "remote" as const,
  hostPort: 5432,
  containerPort: 15432,
  owners: ["config" as const],
};

test("initial remote preparation never starts the relay and rejects concurrent mutations", async () => {
  await withInitialBroker(async ({ broker, events }) => {
    await broker.prepareInitial([initialRemote]);
    expect(events).toEqual(["persist:pending"]);
    expect(broker.listPortForwards()[0].state).toBe("pending");
    await expect(
      broker.addPortForward(
        { direction: "remote", hostPort: 8080, containerPort: 18081 },
        "dynamic",
      ),
    ).rejects.toThrow("initial forwarding is not ready");
    await expect(broker.removePortForward(initialRemote)).rejects.toThrow(
      "initial forwarding is not ready",
    );
    await expect(
      broker.bind({ containerPort: 3000, hostPort: 9000 }),
    ).rejects.toThrow("initial forwarding is not ready");
  });
});

test("disconnected initial failure preserves its cause and completes startup", async () => {
  await withInitialBroker(async ({ broker, events, complete, persistWith }) => {
    const failure = new Error("disk full before launch");
    persistWith(async () => {
      throw failure;
    });

    const caught = await broker
      .prepareInitial([initialRemote])
      .catch((error: unknown) => error);

    expect(caught).toBe(failure);
    expect(await complete).toBe(failure.message);
    expect(events).not.toContain("failed");
  });
});

test("initial-ready waits for every remote ACK and the last persistence", async () => {
  await withInitialBroker(
    async ({ broker, events, complete, connect, persistWith }) => {
      await broker.prepareInitial([
        initialRemote,
        { ...initialRemote, containerPort: 25432 },
      ]);
      connect();
      broker.onForwardState(15432, "active");
      let release!: () => void;
      let entered!: () => void;
      const enteredPersist = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const persisted = new Promise<void>((resolve) => {
        release = resolve;
      });
      persistWith(async (ports) => {
        if (ports.portForwards.every((entry) => entry.state === "active")) {
          entered();
          await persisted;
        }
      });
      broker.onForwardState(25432, "active");
      await enteredPersist;
      expect(events).not.toContain("ready");
      release();
      expect(await complete).toBeUndefined();
      expect(events.at(-1)).toBe("ready");
    },
  );
});

test("initial listen failure revokes the entire initial remote set", async () => {
  await withInitialBroker(async ({ broker, events, complete, connect }) => {
    await broker.prepareInitial([
      initialRemote,
      { ...initialRemote, containerPort: 25432 },
    ]);
    connect();
    broker.onForwardState(15432, "active");
    broker.onForwardState(25432, "failed", "EADDRINUSE");
    expect(await complete).toContain("EADDRINUSE");
    expect(broker.listPortForwards()).toEqual([]);
    expect(events).toContain("unforward:15432");
    expect(events).toContain("unforward:25432");
    expect(events).not.toContain("ready");
    expect(events.at(-2)).toBe("persist:");
  });
});

test("initial persistence failure rolls back ACKed resources and fails startup", async () => {
  await withInitialBroker(
    async ({ broker, events, complete, connect, persistWith }) => {
      await broker.prepareInitial([initialRemote]);
      persistWith(async (ports) => {
        if (ports.portForwards.some((entry) => entry.state === "active"))
          throw new Error("disk full");
      });
      connect();
      broker.onForwardState(15432, "active");
      expect(await complete).toContain("disk full");
      expect(broker.listPortForwards()).toEqual([]);
      expect(events).toContain("unforward:15432");
      expect(events).not.toContain("ready");
    },
  );
});

test("local-only initial listeners are acquired before launch and ready on connection", async () => {
  const reservation = createServer();
  const hostPort = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  await withInitialBroker(async ({ broker, events, complete, connect }) => {
    await broker.prepareInitial([
      { direction: "local", hostPort, containerPort: 3000, owners: ["config"] },
    ]);
    const contender = createServer();
    try {
      const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
        contender.once("error", resolve);
        contender.listen(hostPort, "127.0.0.1");
      });
      expect(error.code).toBe("EADDRINUSE");
      expect(events).not.toContain("ready");
      connect();
      expect(await complete).toBeUndefined();
    } finally {
      contender.close();
    }
  });
});

test("configured receiver keeps its listener when user ownership is removed", async () => {
  await withInitialBroker(async ({ broker, events, complete, connect }) => {
    await broker.prepareInitial([
      { ...initialRemote, owners: ["config", "internal"] },
    ]);
    connect();
    broker.onForwardState(15432, "active");
    await complete;
    expect(await broker.removePortForward(initialRemote)).toEqual({
      removed: true,
      retainedInternal: true,
      listenerClosed: false,
    });
    expect(broker.listPortForwards()[0].owners).toEqual(["internal"]);
    expect(events).not.toContain("unforward:15432");
  });
});

test("prelaunch local conflict releases earlier initial listeners", async () => {
  const first = createServer();
  const occupied = createServer();
  const hostPort = await listen(first);
  const occupiedPort = await listen(occupied);
  await new Promise<void>((resolve) => first.close(() => resolve()));
  try {
    await withInitialBroker(async ({ broker }) => {
      await expect(
        broker.prepareInitial([
          {
            direction: "local",
            hostPort,
            containerPort: 3000,
            owners: ["config"],
          },
          {
            direction: "local",
            hostPort: occupiedPort,
            containerPort: 3001,
            owners: ["config"],
          },
        ]),
      ).rejects.toThrow();
      expect(broker.listPortForwards()).toEqual([]);
      await new Promise<void>((resolve, reject) => {
        first.once("error", reject);
        first.listen(hostPort, "127.0.0.1", resolve);
      });
    });
  } finally {
    await new Promise<void>((resolve) => first.close(() => resolve()));
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});
