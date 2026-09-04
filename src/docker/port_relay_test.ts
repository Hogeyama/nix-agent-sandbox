import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
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
    await mkdir(procDir, { recursive: true });
    proc = Bun.spawn(["bun", SCRIPT], {
      env: {
        ...process.env,
        NAS_PORT_RELAY_SOCKET: socketPath,
        NAS_PORT_RELAY_PROC_DIR: procDir,
        NAS_PORT_RELAY_WATCH_MS: "20",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 200 && !startedGateway.isRelayConnected(); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(startedGateway.isRelayConnected()).toEqual(true);
    return await fn({ gateway: startedGateway, echoPort, procDir });
  } finally {
    try {
      if (proc) {
        proc.kill();
        await proc.exited;
      }
    } finally {
      try {
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
      if (chunk.toString() === "control\n") resolveControl(socket);
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
