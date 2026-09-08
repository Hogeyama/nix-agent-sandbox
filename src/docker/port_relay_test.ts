import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { startRelayGateway } from "../network/port_bind_relay.ts";

const SCRIPT = path.join(import.meta.dir, "embed", "port-relay.mjs");

/** Sockets handed back by the gateway are paused; production resumes via pipe. */
function firstChunk(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    socket.once("data", (chunk: Buffer) => resolve(chunk));
    socket.resume();
  });
}

async function withRelay<T>(
  fn: (ctx: {
    gateway: Awaited<ReturnType<typeof startRelayGateway>>;
    echoPort: number;
    procDir: string;
    socketPath: string;
    tokens: string[];
    readOutput: (stream: "stdout" | "stderr") => Promise<string>;
    waitExit: () => Promise<number>;
  }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-relay-proc-"));
  const socketPath = path.join(dir, "relay.sock");
  // The scan reads /proc/net inside the container; here it reads a fixture.
  const procDir = path.join(dir, "proc-net");
  const echo = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    socket.write("HELLO\n");
    socket.on("data", (chunk: Buffer) => socket.write(chunk));
  });
  const tokens: string[] = [];
  const proxySockets = new Set<Socket>();
  const relayPath = path.join(dir, "container.sock");
  const proxy = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({ path: socketPath, allowHalfOpen: true });
    for (const socket of [client, upstream]) {
      proxySockets.add(socket);
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
      socket.once("close", () => proxySockets.delete(socket));
    }
    let buffer = "";
    upstream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let end = buffer.indexOf("\n");
      while (end !== -1) {
        const line = buffer.slice(0, end);
        const match = /^forward [0-9a-f]{16} ([0-9a-f]{32}) [0-9]+$/.exec(line);
        if (match) tokens.push(match[1]);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
      }
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  let echoListening = false;
  let gateway: Awaited<ReturnType<typeof startRelayGateway>> | undefined;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await new Promise<void>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve()),
    );
    echoListening = true;
    const echoPort = (echo.address() as { port: number }).port;
    const startedGateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    gateway = startedGateway;
    await new Promise<void>((resolve) => proxy.listen(relayPath, resolve));
    await mkdir(procDir, { recursive: true });
    const startedProc = Bun.spawn(["bun", SCRIPT], {
      env: {
        ...process.env,
        NAS_PORT_RELAY_SOCKET: relayPath,
        NAS_PORT_RELAY_PROC_DIR: procDir,
        NAS_PORT_RELAY_WATCH_MS: "20",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    proc = startedProc;
    for (let i = 0; i < 200 && !startedGateway.isRelayConnected(); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(startedGateway.isRelayConnected()).toEqual(true);
    return await fn({
      gateway: startedGateway,
      echoPort,
      procDir,
      socketPath,
      tokens,
      readOutput: async (stream) => {
        const reader = startedProc[stream].getReader();
        try {
          const { value } = await reader.read();
          return new TextDecoder().decode(value);
        } finally {
          reader.releaseLock();
        }
      },
      waitExit: () => startedProc.exited,
    });
  } finally {
    try {
      if (proc) {
        proc.kill();
        await proc.exited;
      }
    } finally {
      try {
        for (const socket of proxySockets) socket.destroy();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await gateway?.close();
      } finally {
        try {
          if (echoListening)
            await new Promise<void>((resolve) => echo.close(() => resolve()));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
  }
}

test("the relay pipes a stream to a listening port", async () => {
  await withRelay(async ({ gateway, echoPort }) => {
    const stream = await gateway.openStream(echoPort);
    expect((await firstChunk(stream)).toString()).toEqual("HELLO\n");
    stream.write("ping");
    expect((await firstChunk(stream)).toString()).toEqual("ping");
    stream.destroy();
  });
});

test("the relay reports a refused dial instead of opening a stream", async () => {
  await withRelay(async ({ gateway }) => {
    const closedPort = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });
    await expect(gateway.openStream(closedPort)).rejects.toThrow();
  });
});

test("the relay answers a probe for a listening port", async () => {
  await withRelay(async ({ gateway, echoPort }) => {
    expect(await gateway.probe(echoPort)).toEqual("ok");
  });
});

test("a probe for a port nothing listens on comes back as no-answer", async () => {
  await withRelay(async ({ gateway }) => {
    const closedPort = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });
    expect(await gateway.probe(closedPort)).toEqual("no-answer");
  });
});

test("the relay closes control for a request with extra fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-relay-parse-"));
  const socketPath = path.join(dir, "relay.sock");
  let resolveControl: (socket: Socket) => void;
  let rejectControl: (error: Error) => void;
  const connected = new Promise<Socket>((resolve, reject) => {
    resolveControl = resolve;
    rejectControl = reject;
  });
  const server = createServer((socket: Socket) => {
    socket.once("data", (chunk: Buffer) => {
      if (chunk.toString() === "control-v2\n") resolveControl(socket);
      else rejectControl(new Error(`unexpected relay header: ${chunk}`));
    });
  });
  let listening = false;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    listening = true;
    proc = Bun.spawn(["bun", SCRIPT], {
      env: { ...process.env, NAS_PORT_RELAY_SOCKET: socketPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const control = await connected;
    const closed = new Promise<void>((resolve) =>
      control.once("close", resolve),
    );
    control.write("open 0123456789abcdef 3000 extra\n");
    await closed;
  } finally {
    try {
      if (proc) {
        proc.kill();
        await proc.exited;
      }
    } finally {
      try {
        if (listening)
          await new Promise<void>((resolve) => server.close(() => resolve()));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
});

const PROC_HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

function procRow(address: string, port: number, state = "0A"): string {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  return `   0: ${address}:${hexPort} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0`;
}

async function writeProcNet(
  procDir: string,
  rows: { tcp: string[]; tcp6?: string[]; ephemeralRange?: string },
): Promise<void> {
  await mkdir(path.join(procDir, "net"), { recursive: true });
  await mkdir(path.join(procDir, "sys", "net", "ipv4"), { recursive: true });
  await writeFile(
    path.join(procDir, "net", "tcp"),
    `${[PROC_HEADER, ...rows.tcp].join("\n")}\n`,
  );
  await writeFile(
    path.join(procDir, "net", "tcp6"),
    `${[PROC_HEADER, ...(rows.tcp6 ?? [])].join("\n")}\n`,
  );
  await writeFile(
    path.join(procDir, "sys", "net", "ipv4", "ip_local_port_range"),
    `${rows.ephemeralRange ?? "32768\t60999"}\n`,
  );
}

async function waitForListeners(
  gateway: Awaited<ReturnType<typeof startRelayGateway>>,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (gateway.listeners().length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `expected ${count} listeners, saw ${JSON.stringify(gateway.listeners())}`,
  );
}

test("the relay reports listening ports and the address each one picked", async () => {
  await withRelay(async ({ gateway, procDir }) => {
    await writeProcNet(procDir, {
      tcp: [
        procRow("00000000", 5173),
        procRow("0100007F", 3000),
        procRow("020011AC", 8080),
        // An established connection is not a server; it must not be offered.
        procRow("0100007F", 4444, "01"),
      ],
      tcp6: [procRow("00000000000000000000000001000000", 9000)],
    });

    expect(await gateway.watchListeners(true)).toEqual("ready");
    await waitForListeners(gateway, 4);
    expect(gateway.listeners()).toEqual([
      { containerPort: 3000, scope: "loopback" },
      { containerPort: 5173, scope: "any" },
      { containerPort: 8080, scope: "remote" },
      { containerPort: 9000, scope: "loopback6" },
    ]);
  });
});

test("ports the kernel hands out on its own are not suggested", async () => {
  await withRelay(async ({ gateway, procDir }) => {
    await writeProcNet(procDir, {
      tcp: [
        procRow("00000000", 5432),
        // What a Testcontainers publish looks like from the shared namespace.
        procRow("00000000", 40001),
        procRow("0100007F", 49152),
      ],
      ephemeralRange: "40000\t60999",
    });

    await gateway.watchListeners(true);
    await waitForListeners(gateway, 1);
    expect(gateway.listeners()).toEqual([
      { containerPort: 5432, scope: "any" },
    ]);
  });
});

test("a server that stops listening stops being reported", async () => {
  await withRelay(async ({ gateway, procDir }) => {
    await writeProcNet(procDir, { tcp: [procRow("00000000", 5173)] });
    await gateway.watchListeners(true);
    await waitForListeners(gateway, 1);

    await writeProcNet(procDir, { tcp: [] });
    await waitForListeners(gateway, 0);
  });
});

test("the relay only scans while the host is watching", async () => {
  await withRelay(async ({ gateway, procDir }) => {
    await writeProcNet(procDir, { tcp: [procRow("00000000", 5173)] });
    // Nothing asked for candidates, so the scan never ran.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(gateway.listeners()).toEqual([]);

    await gateway.watchListeners(true);
    await waitForListeners(gateway, 1);
    await gateway.watchListeners(false);

    await writeProcNet(procDir, {
      tcp: [procRow("00000000", 5173), procRow("00000000", 3000)],
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(gateway.listeners()).toEqual([]);
  });
});

/** A port nothing listens on right now, for the relay to take. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

test("a forward listens in the relay and reaches the host port, client-first bytes intact", async () => {
  await withRelay(async ({ gateway, echoPort }) => {
    const containerPort = await freePort();
    await gateway.forward(containerPort, echoPort);
    expect(gateway.forwards().map((f) => f.containerPort)).toEqual([
      containerPort,
    ]);

    const client = await dial(containerPort);
    // Written before the relay can have reached the host: the relay must hold
    // it until the host side is piped.
    client.write("ping");
    let received = "";
    await new Promise<void>((resolve) => {
      client.on("data", (chunk: Buffer) => {
        received += chunk.toString();
        if (received.includes("ping")) resolve();
      });
    });
    expect(received).toEqual("HELLO\nping");
    client.destroy();
    await gateway.unforward(containerPort);
  });
});

test("unforward closes the container listener and cuts open connections", async () => {
  await withRelay(async ({ gateway, echoPort }) => {
    const containerPort = await freePort();
    await gateway.forward(containerPort, echoPort);
    const client = await dial(containerPort);
    const closed = new Promise<void>((resolve) =>
      client.once("close", resolve),
    );
    await gateway.unforward(containerPort);
    await closed;
    expect(gateway.forwards()).toEqual([]);
    await expect(dial(containerPort)).rejects.toThrow();
  });
});

test("a forward whose container port is taken reports the relay's reason", async () => {
  await withRelay(async ({ gateway, echoPort }) => {
    // The echo server already holds echoPort in this (shared) namespace.
    await expect(gateway.forward(echoPort, echoPort)).rejects.toThrow(
      "EADDRINUSE",
    );
    expect(gateway.forwards()).toEqual([]);
  });
});

test("a connection to a forward whose host port is closed is dropped", async () => {
  await withRelay(async ({ gateway }) => {
    const containerPort = await freePort();
    const closedHostPort = await freePort();
    await gateway.forward(containerPort, closedHostPort);
    const client = await dial(containerPort);
    await new Promise<void>((resolve) => client.once("close", resolve));
    await gateway.unforward(containerPort);
  });
});

test("a removed real-relay token cannot reach the host after the port is re-added", async () => {
  await withRelay(async ({ gateway, echoPort, socketPath, tokens }) => {
    const containerPort = await freePort();
    await gateway.forward(containerPort, echoPort);
    const oldToken = tokens.at(-1);
    expect(oldToken).toMatch(/^[0-9a-f]{32}$/);
    await gateway.unforward(containerPort);
    await gateway.forward(containerPort, echoPort);
    expect(tokens.at(-1)).not.toBe(oldToken);
    for (const header of [
      `client ${oldToken}`,
      `client ${containerPort}`,
      `client ${"f".repeat(32)} extra`,
    ]) {
      const socket = connect({ path: socketPath });
      let received = false;
      socket.on("data", () => {
        received = true;
      });
      try {
        const closed = new Promise<void>((resolve) =>
          socket.once("close", resolve),
        );
        socket.write(`${header}\nping`);
        await closed;
        expect(received).toBe(false);
      } finally {
        socket.destroy();
      }
    }
    const client = connect({ host: "127.0.0.1", port: containerPort });
    try {
      expect((await firstChunk(client)).toString()).toBe("HELLO\n");
    } finally {
      client.destroy();
    }
    await gateway.unforward(containerPort);
  });
});

test("initial-ready is reported without stopping the real relay", async () => {
  await withRelay(async ({ gateway, echoPort, readOutput }) => {
    gateway.completeInitialForwards();
    expect(await readOutput("stdout")).toBe("initial-ready\n");
    expect(await gateway.probe(echoPort)).toBe("ok");
  });
});

test("initial-failed stops the real relay with a failure reason", async () => {
  await withRelay(async ({ gateway, readOutput, waitExit }) => {
    gateway.completeInitialForwards("listen-failed");
    expect(await waitExit()).toBe(1);
    expect(await readOutput("stderr")).toBe("initial-failed listen-failed\n");
  });
});
