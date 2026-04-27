/**
 * forward_port_relay unit tests. Docker-free; everything runs over loopback +
 * UDS in a per-test tmp dir.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as nodeFsPromises from "node:fs/promises";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import {
  type AddressInfo,
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathExists } from "../lib/fs_utils.ts";
import {
  type ForwardPortRelayHandle,
  forwardPortSocketPath,
  startForwardPortRelay,
  startSessionForwardPortRelays,
} from "./forward_port_relay.ts";

// ---- helpers ----------------------------------------------------------------

let tmpRoot = "";

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "nas-fpr-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

interface MockTcpServer {
  port: number;
  server: Server;
  /** Sockets the server accepted. */
  accepted: Socket[];
  close(): Promise<void>;
}

/**
 * Spin up an ephemeral TCP listener bound to 127.0.0.1 with a kernel-allocated
 * port. The supplied handler runs per accepted socket.
 */
async function startMockTcpServer(
  onConnection: (socket: Socket) => void,
): Promise<MockTcpServer> {
  const accepted: Socket[] = [];
  const server = createServer((socket) => {
    accepted.push(socket);
    onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  return {
    port,
    server,
    accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of accepted) {
          try {
            s.destroy();
          } catch {
            /* ignore */
          }
        }
        server.close(() => resolve());
      }),
  };
}

/** Connect to a UDS path; resolves with a connected Socket. */
function connectUds(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path: socketPath }, () => {
      sock.removeListener("error", reject);
      resolve(sock);
    });
    sock.once("error", reject);
  });
}

/**
 * Read until socket emits 'end' or `expectedBytes` have been received,
 * whichever comes first. Concatenates to a single Buffer.
 */
function readAllUntil(socket: Socket, expectedBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= expectedBytes) {
        cleanup();
        resolve(Buffer.concat(chunks, total));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
  });
}

// ---- tests ------------------------------------------------------------------

test("forwardPortSocketPath: produces canonical <runtimeDir>/forward-ports/<sessionId>/<port>.sock", () => {
  const got = forwardPortSocketPath("/run/nas", "sess-abc", 8080);
  expect(got).toBe(
    path.join("/run/nas", "forward-ports", "sess-abc", "8080.sock"),
  );
});

test("startForwardPortRelay: bidirectional echo over UDS to host TCP listener", async () => {
  const mock = await startMockTcpServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      socket.write(chunk); // echo
    });
  });
  const socketPath = path.join(tmpRoot, "echo.sock");
  const relay = await startForwardPortRelay({
    socketPath,
    hostPort: mock.port,
  });
  try {
    const client = await connectUds(socketPath);
    const payload = Buffer.from("hello forward-port");
    client.write(payload);
    const echoed = await readAllUntil(client, payload.length);
    expect(echoed.equals(payload)).toBe(true);
    client.destroy();
  } finally {
    await relay.close();
    await mock.close();
  }
});

test("startForwardPortRelay: 128KB payload survives end-to-end without loss", async () => {
  const mock = await startMockTcpServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      socket.write(chunk);
    });
  });
  const socketPath = path.join(tmpRoot, "big.sock");
  const relay = await startForwardPortRelay({
    socketPath,
    hostPort: mock.port,
  });
  try {
    const size = 128 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = i & 0xff;

    const client = await connectUds(socketPath);
    client.write(payload);
    const echoed = await readAllUntil(client, size);
    expect(echoed.length).toBe(size);
    expect(echoed.equals(payload)).toBe(true);
    client.destroy();
  } finally {
    await relay.close();
    await mock.close();
  }
});

test("startForwardPortRelay: survives host listener disappearance and accepts new connections after", async () => {
  // Phase 0: bring up mock1 so we have a real port the relay can target.
  const mock1 = await startMockTcpServer(() => {
    /* no echo — we kill it before testing recovery */
  });
  const port = mock1.port;

  const socketPath = path.join(tmpRoot, "recovery.sock");
  const relay = await startForwardPortRelay({ socketPath, hostPort: port });

  // Phase 1: kill mock1. The relay's UDS listener must stay alive even though
  // its target host port is now refused.
  await mock1.close();

  try {
    // Phase 2: a UDS connect should still succeed (the UDS server is alive),
    // but the relay's host-side TCP connect will fail — observe the pair tear
    // down so we know the relay handled the failure cleanly.
    const failingClient = await connectUds(socketPath);
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      failingClient.once("close", done);
      failingClient.once("end", done);
      failingClient.once("error", done);
      setTimeout(done, 500).unref?.();
    });
    failingClient.destroy();

    // Phase 3: bind a brand-new mock on the SAME port. We listen explicitly on
    // `port` (not port 0) so this isn't subject to ephemeral-allocation
    // flakiness. If something else grabbed the port in the meantime this
    // listen will EADDRINUSE and the test will surface that as a real error.
    const accepted: Socket[] = [];
    const server2 = createServer((socket) => {
      accepted.push(socket);
      socket.on("data", (c: Buffer) => socket.write(c));
    });
    await new Promise<void>((resolve, reject) => {
      server2.once("error", reject);
      server2.listen({ host: "127.0.0.1", port }, () => {
        server2.removeListener("error", reject);
        resolve();
      });
    });
    try {
      const client = await connectUds(socketPath);
      const payload = Buffer.from("after-recovery");
      client.write(payload);
      const echoed = await readAllUntil(client, payload.length);
      expect(echoed.equals(payload)).toBe(true);
      client.destroy();
    } finally {
      for (const s of accepted) {
        try {
          s.destroy();
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  } finally {
    await relay.close();
  }
});

test("startForwardPortRelay: close() removes the socket file and frees the path for re-listen", async () => {
  const mock = await startMockTcpServer(() => {});
  const socketPath = path.join(tmpRoot, "cleanup.sock");
  const relay = await startForwardPortRelay({
    socketPath,
    hostPort: mock.port,
  });
  expect(await pathExists(socketPath)).toBe(true);

  await relay.close();
  expect(await pathExists(socketPath)).toBe(false);

  // Re-binding the same path must succeed.
  const relay2 = await startForwardPortRelay({
    socketPath,
    hostPort: mock.port,
  });
  expect(await pathExists(socketPath)).toBe(true);
  await relay2.close();
  await mock.close();
});

test("startForwardPortRelay: close() is idempotent", async () => {
  const mock = await startMockTcpServer(() => {});
  const socketPath = path.join(tmpRoot, "idempotent.sock");
  const relay = await startForwardPortRelay({
    socketPath,
    hostPort: mock.port,
  });
  await relay.close();
  await relay.close(); // second call must not throw
  await mock.close();
});

test("startSessionForwardPortRelays: starts independent relays for multiple ports and cleans up on close", async () => {
  const mockA = await startMockTcpServer((s) => {
    s.on("data", (c: Buffer) => s.write(Buffer.concat([Buffer.from("A:"), c])));
  });
  const mockB = await startMockTcpServer((s) => {
    s.on("data", (c: Buffer) => s.write(Buffer.concat([Buffer.from("B:"), c])));
  });

  const sessionId = "sess-multi";
  const relays = await startSessionForwardPortRelays({
    runtimeDir: tmpRoot,
    sessionId,
    ports: [mockA.port, mockB.port],
  });

  try {
    expect(relays.socketPaths.size).toBe(2);
    const pathA = relays.socketPaths.get(mockA.port);
    const pathB = relays.socketPaths.get(mockB.port);
    expect(pathA).toBe(forwardPortSocketPath(tmpRoot, sessionId, mockA.port));
    expect(pathB).toBe(forwardPortSocketPath(tmpRoot, sessionId, mockB.port));
    expect(await pathExists(pathA!)).toBe(true);
    expect(await pathExists(pathB!)).toBe(true);

    const cA = await connectUds(pathA!);
    cA.write(Buffer.from("hi"));
    const echoA = await readAllUntil(cA, 4); // "A:hi"
    expect(echoA.toString()).toBe("A:hi");
    cA.destroy();

    const cB = await connectUds(pathB!);
    cB.write(Buffer.from("yo"));
    const echoB = await readAllUntil(cB, 4); // "B:yo"
    expect(echoB.toString()).toBe("B:yo");
    cB.destroy();
  } finally {
    await relays.close();
    await mockA.close();
    await mockB.close();
  }

  // After close, both socket files (and the session dir) must be gone.
  const sessionDir = path.join(tmpRoot, "forward-ports", sessionId);
  expect(await pathExists(sessionDir)).toBe(false);
});

test("startSessionForwardPortRelays: ports=[] is a fast path — no session dir, no I/O, no-op close", async () => {
  const sessionId = "sess-empty";
  const relays = await startSessionForwardPortRelays({
    runtimeDir: tmpRoot,
    sessionId,
    ports: [],
  });
  expect(relays.socketPaths.size).toBe(0);
  // Session dir must not have been created.
  const sessionDir = path.join(tmpRoot, "forward-ports", sessionId);
  expect(await pathExists(sessionDir)).toBe(false);
  // close() must resolve without throwing even though we never created
  // anything.
  await relays.close();
  // forward-ports root also must not have been created by this call.
  const fpRoot = path.join(tmpRoot, "forward-ports");
  expect(await pathExists(fpRoot)).toBe(false);
});

test("startSessionForwardPortRelays: duplicate ports are rejected and leave no socket files behind", async () => {
  const sessionId = "sess-dup";
  await expect(
    startSessionForwardPortRelays({
      runtimeDir: tmpRoot,
      sessionId,
      ports: [8080, 8080],
    }),
  ).rejects.toThrow(/duplicate port 8080/);

  // Validation happens before any directory creation, so the forward-ports
  // root, the session dir, and any individual sockets must not exist.
  // (Symmetric with the empty-ports fast path test above.)
  expect(await pathExists(path.join(tmpRoot, "forward-ports"))).toBe(false);
  const sessionDir = path.join(tmpRoot, "forward-ports", sessionId);
  expect(await pathExists(sessionDir)).toBe(false);
  expect(
    await pathExists(forwardPortSocketPath(tmpRoot, sessionId, 8080)),
  ).toBe(false);
});

test("startForwardPortRelay: client mid-stream destroy closes the corresponding host-side socket", async () => {
  let hostSocket: Socket | null = null;

  let resolveHostClosed!: () => void;
  const hostClosedSignal = new Promise<void>((resolve) => {
    resolveHostClosed = resolve;
  });

  const mock = await startMockTcpServer((socket) => {
    hostSocket = socket;
    socket.on("close", () => resolveHostClosed());
    // No echo — we just want to observe the close event when the UDS client
    // tears down mid-stream.
  });

  const socketPath = path.join(tmpRoot, "midstream.sock");
  const relay = await startForwardPortRelay({
    socketPath,
    hostPort: mock.port,
  });
  try {
    const client = await connectUds(socketPath);
    // Send some bytes, then destroy mid-stream.
    client.write(Buffer.from("partial"));
    // Give the relay a tick to actually open the host-side TCP socket so the
    // mock has registered hostSocket / its close listener.
    await new Promise((r) => setTimeout(r, 50));
    expect(hostSocket).not.toBeNull();
    client.destroy();

    // The host-side socket must observe close() shortly after.
    await Promise.race([
      hostClosedSignal,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("host-side socket did not close")),
          2_000,
        ).unref?.(),
      ),
    ]);
  } finally {
    await relay.close();
    await mock.close();
  }
});

test("startForwardPortRelay: socket file is chmod'd to 0o666 so non-root containers can connect", async () => {
  const mock = await startMockTcpServer(() => {});
  const socketPath = path.join(tmpRoot, "perms.sock");
  const relay = await startForwardPortRelay({
    socketPath,
    hostPort: mock.port,
  });
  try {
    const st = await stat(socketPath);
    expect(st.mode & 0o777).toBe(0o666);
  } finally {
    await relay.close();
    await mock.close();
  }
});

test("startForwardPortRelay: safeRemove failure (non-empty dir at socketPath) propagates and leaves no listener behind", async () => {
  // Plant a non-empty directory at the exact socketPath. `startForwardPortRelay`
  // begins by calling `safeRemove(socketPath)` which is a NON-recursive `rm`;
  // removing a non-empty directory non-recursively fails synchronously with
  // ENOTEMPTY/EISDIR, and that error must propagate before the server is ever
  // bound. No race, no poll, no sleep — purely sequential.
  const obstacleDir = path.join(tmpRoot, "obstacle.sock");
  await mkdir(obstacleDir, { recursive: true });
  await writeFile(path.join(obstacleDir, "block"), "x");

  await expect(
    startForwardPortRelay({ socketPath: obstacleDir, hostPort: 1 }),
  ).rejects.toThrow();

  // The obstacle directory is unchanged (non-recursive rm couldn't touch it),
  // so the path still exists as a directory and there is no socket / listener.
  const st = await stat(obstacleDir);
  expect(st.isDirectory()).toBe(true);
});

test("startForwardPortRelay: chmod failure tears down the listener and removes the socket file", async () => {
  // chmod runs AFTER listen(), so a chmod failure is precisely the "leak path"
  // we care about: the server is already bound when the error fires.
  // We spy on chmod to inject a deterministic failure for one call; the
  // implementation must close the server and unlink the socket file before
  // re-throwing, otherwise this test would observe a leftover socket file.
  const mock = await startMockTcpServer(() => {});
  const socketPath = path.join(tmpRoot, "chmod-fail.sock");

  const chmodSpy = spyOn(nodeFsPromises, "chmod");
  const injected = new Error("injected chmod failure");
  chmodSpy.mockImplementationOnce((async () => {
    throw injected;
  }) as typeof nodeFsPromises.chmod);

  try {
    await expect(
      startForwardPortRelay({ socketPath, hostPort: mock.port }),
    ).rejects.toBe(injected);

    // Listener must be torn down: the path must be free for a fresh listen().
    expect(await pathExists(socketPath)).toBe(false);
  } finally {
    chmodSpy.mockRestore();
  }

  // Sanity: a fresh relay can now bind the same path and accept a connection,
  // proving nothing is still listening on it.
  const relay = await startForwardPortRelay({
    socketPath,
    hostPort: mock.port,
  });
  try {
    expect(await pathExists(socketPath)).toBe(true);
    const c = await connectUds(socketPath);
    c.destroy();
  } finally {
    await relay.close();
    await mock.close();
  }
});

test("startSessionForwardPortRelays: partial-leak rollback — second-relay failure tears down the first relay and the session dir", async () => {
  // Deterministic version of the partial-failure rollback test. We inject a
  // `_relayFactory` (test-only seam) that:
  //   - on the first call, delegates to the real `startForwardPortRelay`
  //   - on the second call, throws synchronously
  // This puts the loop in the partial-failure state with a non-empty `handles`
  // list, exactly the state the rollback branch is meant to recover from.
  // No filesystem races, no polling, no sleeps.
  const sessionId = "sess-partial";
  const mockA = await startMockTcpServer(() => {});
  const mockB = await startMockTcpServer(() => {});

  const sessionDir = path.join(tmpRoot, "forward-ports", sessionId);
  const port1Path = forwardPortSocketPath(tmpRoot, sessionId, mockA.port);
  const port2Path = forwardPortSocketPath(tmpRoot, sessionId, mockB.port);

  let calls = 0;
  let started: ForwardPortRelayHandle | null = null;
  const injected = new Error("injected second-relay failure");
  const relayFactory: typeof startForwardPortRelay = async (factoryOpts) => {
    calls += 1;
    if (calls === 1) {
      const handle = await startForwardPortRelay(factoryOpts);
      started = handle;
      return handle;
    }
    throw injected;
  };

  await expect(
    startSessionForwardPortRelays({
      runtimeDir: tmpRoot,
      sessionId,
      ports: [mockA.port, mockB.port],
      _relayFactory: relayFactory,
    }),
  ).rejects.toBe(injected);

  // Confirm both relays were attempted (so the rollback path actually saw a
  // non-empty handles list — otherwise we'd be testing an empty rollback).
  expect(calls).toBe(2);
  expect(started).not.toBeNull();

  // Rollback must remove the session dir entirely, taking the first relay's
  // socket file with it.
  expect(await pathExists(sessionDir)).toBe(false);
  expect(await pathExists(port1Path)).toBe(false);
  expect(await pathExists(port2Path)).toBe(false);

  // The first relay's handle should have been closed by the rollback. close()
  // is idempotent, so calling it again here is safe and serves as a sanity
  // check that no double-throw bubbles up.
  await (started as unknown as ForwardPortRelayHandle).close();

  await mockA.close();
  await mockB.close();
});
