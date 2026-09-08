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
import type {
  ObservedListener,
  PortBinding,
  PortForward,
} from "./port_bind_protocol.ts";
import {
  type EnsureRelayResult,
  RelayNotReadyError,
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
        openStream: async () => {
          await new Promise((resolve) => setTimeout(resolve, relayDelayMs));
          return connect({ port: echoPort, host: "127.0.0.1" });
        },
        probe: async () => "ok",
        watchListeners: async () => "ready" as const,
        listeners: () => [],
        forward: async () => {},
        unforward: async () => {},
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
      openStream: async () => {
        throw new Error("unused");
      },
      probe: async () => "ok",
      watchListeners: async () => "ready" as const,
      listeners: () => [],
      forward: async () => {},
      unforward: async () => {},
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

test("unbind keeps a live binding when persistence fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-broker-persist-"));
  let fail = false;
  const broker = await startPortBindBroker({
    controlSocketPath: path.join(dir, "sock"),
    gateway: {
      socketPath: path.join(dir, "relay.sock"),
      isRelayConnected: () => true,
      openStream: async () => {
        throw new Error("unused");
      },
      probe: async () => "ok",
      watchListeners: async () => "ready" as const,
      listeners: () => [],
      forward: async () => {},
      unforward: async () => {},
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
    expect(broker.listBindings()).toHaveLength(1);
    const socket = await connectTcp(bound.hostPort);
    socket.destroy();
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
      openStream: async () => {
        throw new Error("unused");
      },
      probe: async () => "ok",
      watchListeners: async () => "ready" as const,
      listeners: () => [],
      forward: async () => {},
      unforward: async () => {},
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
      openStream: async () => {
        throw new Error("unused");
      },
      probe: async () => "ok",
      watchListeners: async () => "ready" as const,
      listeners: () => [],
      forward: async () => {},
      unforward: async () => {},
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
      unforward: async () => {},
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
        unforward: async () => {},
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
}) {
  const table = new Map<number, PortForward>();
  const requests: string[] = [];
  const gateway = {
    socketPath: "unused",
    isRelayConnected: () => true,
    openStream: async () => {
      throw new Error("unused");
    },
    probe: async () => "ok" as const,
    watchListeners: async () => "ready" as const,
    listeners: () => [],
    forward: async (containerPort: number, hostPort: number) => {
      requests.push(`forward ${containerPort} ${hostPort}`);
      const ensured = opts.ensure?.() ?? "ready";
      if (ensured !== "ready") throw new RelayNotReadyError(ensured);
      if (opts.listenError) throw new Error(opts.listenError);
      table.set(containerPort, {
        containerPort,
        hostPort,
        createdAt: "2026-09-08T00:00:00.000Z",
      });
    },
    unforward: async (containerPort: number) => {
      requests.push(`unforward ${containerPort}`);
      table.delete(containerPort);
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
      expect(written.at(-1)).toEqual({
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
