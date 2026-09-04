import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
  }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-relay-proc-"));
  const socketPath = path.join(dir, "relay.sock");
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
    proc = Bun.spawn(["bun", SCRIPT], {
      env: { ...process.env, NAS_PORT_RELAY_SOCKET: socketPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 200 && !startedGateway.isRelayConnected(); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(startedGateway.isRelayConnected()).toEqual(true);
    return await fn({ gateway: startedGateway, echoPort });
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
