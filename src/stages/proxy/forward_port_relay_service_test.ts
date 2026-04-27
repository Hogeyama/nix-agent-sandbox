/**
 * ForwardPortRelayService Live unit tests. No Docker; uses tmpdir + ephemeral
 * 127.0.0.1 TCP listeners.
 *
 * The Live impl is a thin wrapper over startSessionForwardPortRelays so the
 * focus here is "does the Effect surface preserve the contract": empty ports
 * → empty map + no-op close, real ports → socket file appears, close removes
 * it and is idempotent.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import {
  type AddressInfo,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import {
  ForwardPortRelayService,
  ForwardPortRelayServiceLive,
} from "./forward_port_relay_service.ts";

let tmpRoot = "";

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "nas-fprs-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

interface MockTcpServer {
  port: number;
  server: Server;
  accepted: Socket[];
  close(): Promise<void>;
}

async function startMockTcpServer(): Promise<MockTcpServer> {
  const accepted: Socket[] = [];
  const server = createServer((socket) => {
    accepted.push(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

test("ForwardPortRelayServiceLive.ensureRelays: empty ports yields empty map + no-op close", async () => {
  const program = Effect.gen(function* () {
    const svc = yield* ForwardPortRelayService;
    const handle = yield* svc.ensureRelays({
      runtimeDir: tmpRoot,
      sessionId: "sess-empty",
      ports: [],
    });
    expect(handle.socketPaths.size).toEqual(0);
    yield* handle.close();
    // Idempotent: second close is fine.
    yield* handle.close();
  }).pipe(Effect.provide(ForwardPortRelayServiceLive));

  await Effect.runPromise(program);
});

test("ForwardPortRelayServiceLive.ensureRelays: creates socket file and removes it on close", async () => {
  const mock = await startMockTcpServer();
  try {
    // We exit the Effect between the create and close phases so we can call
    // pathExists() in plain async code; intermixing await inside Effect.gen
    // is a parse error under our biome config.
    const handle = await Effect.runPromise(
      Effect.flatMap(ForwardPortRelayService, (svc) =>
        svc.ensureRelays({
          runtimeDir: tmpRoot,
          sessionId: "sess-real",
          ports: [mock.port],
        }),
      ).pipe(Effect.provide(ForwardPortRelayServiceLive)),
    );

    expect(handle.socketPaths.size).toEqual(1);
    const sockPath = handle.socketPaths.get(mock.port);
    expect(sockPath).toBeDefined();
    expect(await pathExists(sockPath as string)).toEqual(true);

    await Effect.runPromise(handle.close());

    expect(await pathExists(sockPath as string)).toEqual(false);
  } finally {
    await mock.close();
  }
});

test("ForwardPortRelayServiceLive.ensureRelays: close is idempotent", async () => {
  const mock = await startMockTcpServer();
  try {
    const program = Effect.gen(function* () {
      const svc = yield* ForwardPortRelayService;
      const handle = yield* svc.ensureRelays({
        runtimeDir: tmpRoot,
        sessionId: "sess-idem",
        ports: [mock.port],
      });
      yield* handle.close();
      yield* handle.close();
      yield* handle.close();
    }).pipe(Effect.provide(ForwardPortRelayServiceLive));

    await Effect.runPromise(program);
  } finally {
    await mock.close();
  }
});
