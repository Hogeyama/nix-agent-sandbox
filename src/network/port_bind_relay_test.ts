import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  pipeSockets,
  readFirstLine,
  startRelayGateway,
} from "./port_bind_relay.ts";

async function withSocketPath<T>(
  fn: (socketPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-relay-"));
  try {
    return await fn(path.join(dir, "relay.sock"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `readFirstLine` leaves its socket paused, so resume before reading payload. */
function firstChunk(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    socket.once("data", (chunk: Buffer) => resolve(chunk));
    socket.resume();
  });
}

function waitForClose(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.once("close", resolve));
}

async function waitForRelay(gateway: {
  isRelayConnected(): boolean;
}): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (gateway.isRelayConnected()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("relay did not connect");
}

/** Minimal stand-in for port-relay.mjs: dials a loopback port on request. */
function fakeRelay(socketPath: string, target: number): Socket {
  const control = connect({ path: socketPath });
  control.write("control\n");
  control.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const [verb, id, port] = line.split(" ");
      if (verb === "probe") {
        control.write(`ok ${id}\n`);
        continue;
      }
      if (verb !== "open") continue;
      if (Number(port) !== target) {
        control.write(`fail ${id} ECONNREFUSED\n`);
        continue;
      }
      const stream = connect({ path: socketPath });
      stream.write(`stream ${id}\nHELLO\n`);
      stream.on("data", (data: Buffer) => stream.write(data));
    }
  });
  return control;
}

test("readFirstLine returns the line and unshifts the remainder", async () => {
  await new Promise<void>((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      readFirstLine(socket, 128)
        .then(async (line) => {
          expect(line).toEqual("stream abc");
          expect((await firstChunk(socket)).toString()).toEqual("payload");
          socket.destroy();
          server.close();
          resolve();
        })
        .catch(reject);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      connect({ port, host: "127.0.0.1" }).end("stream abc\npayload");
    });
  });
});

test("readFirstLine rejects an overlong or incomplete line", async () => {
  await new Promise<void>((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      readFirstLine(socket, 4)
        .then(() => reject(new Error("expected overlong line to reject")))
        .catch((error: Error) => {
          expect(error.message).toContain("exceeds");
          socket.destroy();
          server.close();
          resolve();
        });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      connect({ port, host: "127.0.0.1" }).end("abcde");
    });
  });
});

test("readFirstLine rejects when its peer ends before a newline", async () => {
  await new Promise<void>((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      readFirstLine(socket, 128)
        .then(() => reject(new Error("expected incomplete line to reject")))
        .catch((error: Error) => {
          expect(error.message).toContain("ended before");
          socket.destroy();
          server.close();
          resolve();
        });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      connect({ port, host: "127.0.0.1" }).end("stream abc");
    });
  });
});

test("pipeSockets propagates a half-close to its peer", async () => {
  await new Promise<void>((resolve, reject) => {
    let first: Socket | undefined;
    let pairedResolve: (() => void) | undefined;
    const paired = new Promise<void>((resolvePair) => {
      pairedResolve = resolvePair;
    });
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      if (!first) {
        first = socket;
        return;
      }
      pipeSockets(first, socket, { graceMs: 100 });
      pairedResolve?.();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const requester = connect({
        port,
        host: "127.0.0.1",
        allowHalfOpen: true,
      });
      const responder = connect({
        port,
        host: "127.0.0.1",
        allowHalfOpen: true,
      });
      responder.once("data", (request: Buffer) => {
        expect(request.toString()).toEqual("request");
      });
      responder.once("end", () => {
        requester.destroy();
        responder.destroy();
        server.close();
        resolve();
      });
      requester.on("error", reject);
      responder.on("error", reject);
      void Promise.all([
        new Promise<void>((connected) => requester.once("connect", connected)),
        new Promise<void>((connected) => responder.once("connect", connected)),
      ])
        .then(() => paired)
        .then(() => requester.end("request"))
        .catch(reject);
    });
  });
});

test("openStream pairs a stream connection and pipes both directions", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const relay = fakeRelay(socketPath, 3000);
    await waitForRelay(gateway);
    const stream = await gateway.openStream(3000);
    expect((await firstChunk(stream)).toString()).toEqual("HELLO\n");
    stream.write("ping");
    expect((await firstChunk(stream)).toString()).toEqual("ping");
    stream.destroy();
    relay.destroy();
    await gateway.close();
  });
});

test("openStream rejects when the relay reports a failed dial", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const relay = fakeRelay(socketPath, 3000);
    await waitForRelay(gateway);
    await expect(gateway.openStream(9999)).rejects.toThrow("ECONNREFUSED");
    relay.destroy();
    await gateway.close();
  });
});

test("openStream rejects when no stream arrives before the pairing timeout", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
      pairingTimeoutMs: 50,
    });
    const control = connect({ path: socketPath });
    control.write("control\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(gateway.openStream(3000)).rejects.toThrow("timed out");
    control.destroy();
    await gateway.close();
  });
});

test("an aborted openStream retires its id, so a late stream is closed", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const control = connect({ path: socketPath });
    control.write("control\n");
    await waitForRelay(gateway);
    const requested = new Promise<string>((resolve) =>
      control.once("data", (data: Buffer) => resolve(data.toString().trim())),
    );
    const abort = new AbortController();
    const pending = gateway.openStream(3000, abort.signal);
    const id = (await requested).split(" ")[1] as string;
    abort.abort();
    await expect(pending).rejects.toThrow("aborted");

    const late = connect({ path: socketPath });
    late.write(`stream ${id}\n`);
    await waitForClose(late);
    control.destroy();
    await gateway.close();
  });
});

test("an already-aborted request is not sent to the relay", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const control = connect({ path: socketPath });
    control.write("control\n");
    await waitForRelay(gateway);
    const abort = new AbortController();
    abort.abort();
    await expect(gateway.openStream(3000, abort.signal)).rejects.toThrow(
      "aborted",
    );
    const requestArrived = await Promise.race([
      new Promise<boolean>((resolve) =>
        control.once("data", () => resolve(true)),
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
    ]);
    expect(requestArrived).toEqual(false);
    control.destroy();
    await gateway.close();
  });
});

test("probe reports unavailable relay reasons and a failed dial", async () => {
  await withSocketPath(async (socketPath) => {
    const unavailable = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "container-not-running",
    });
    expect(await unavailable.probe(3000)).toEqual("container-not-running");
    await unavailable.close();
  });
  await withSocketPath(async (socketPath) => {
    const unreachable = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "unreachable",
    });
    expect(await unreachable.probe(3000)).toEqual("relay-unreachable");
    await unreachable.close();
  });
});

test("a second control connection and unknown stream are refused", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const first = fakeRelay(socketPath, 3000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = connect({ path: socketPath });
    second.write("control\n");
    await waitForClose(second);
    expect(gateway.isRelayConnected()).toEqual(true);

    const unknown = connect({ path: socketPath });
    unknown.write("stream deadbeefdeadbeef\n");
    await waitForClose(unknown);
    first.destroy();
    await gateway.close();
  });
});

test("an invalid control line disconnects the relay", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const control = connect({ path: socketPath });
    control.write("control\n");
    await waitForRelay(gateway);
    const closed = waitForClose(control);
    control.write("unexpected message\n");
    await closed;
    expect(gateway.isRelayConnected()).toEqual(false);
    await gateway.close();
  });
});

test("control disconnect rejects pending requests and destroys paired streams", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const control = connect({ path: socketPath });
    control.write("control\n");
    await waitForRelay(gateway);
    const pending = gateway.openStream(3000);
    control.destroy();
    await expect(pending).rejects.toThrow("disconnected");

    const relay = fakeRelay(socketPath, 3000);
    await waitForRelay(gateway);
    const stream = await gateway.openStream(3000);
    const streamClosed = waitForClose(stream);
    relay.destroy();
    await streamClosed;
    expect(stream.destroyed).toEqual(true);
    await gateway.close();
  });
});

test("close rejects a request that is waiting for a stream", async () => {
  await withSocketPath(async (socketPath) => {
    const gateway = await startRelayGateway({
      socketPath,
      ensureRelay: async () => "ready",
    });
    const control = connect({ path: socketPath });
    control.write("control\n");
    await waitForRelay(gateway);
    const requested = new Promise<void>((resolve) =>
      control.once("data", () => resolve()),
    );
    const pending = gateway.openStream(3000);
    await requested;
    const rejection = pending.then(
      () => new Error("expected pending request to reject"),
      (error: Error) => error,
    );
    await gateway.close();
    expect((await rejection).message).toContain("gateway closed");
    control.destroy();
  });
});
