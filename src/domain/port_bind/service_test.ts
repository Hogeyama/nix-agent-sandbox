import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import {
  createUnixServer,
  readJsonLine,
  writeJsonLine,
} from "../../lib/unix_socket.ts";
import type { PortBindSessionEntry } from "../../network/port_bind_protocol.ts";
import {
  brokerSocketPath,
  relayScriptPath,
  resolvePortsRuntimePaths,
  writeSessionRegistry,
} from "../../network/port_bind_registry.ts";
import {
  makePortBindClient,
  makePortBindServiceFake,
  PortBindService,
  PortBindServiceLive,
} from "./service.ts";
import {
  AmbiguousHostPortError,
  InternalBrokerError,
  NoSuchBindingError,
  SessionUnreachableError,
} from "./types.ts";

async function withPaths<T>(
  fn: (
    paths: Awaited<ReturnType<typeof resolvePortsRuntimePaths>>,
  ) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "nas-ports-domain-"));
  try {
    return await fn(await resolvePortsRuntimePaths(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function entry(
  sessionId: string,
  brokerSocket: string,
  bindings: PortBindSessionEntry["bindings"],
): PortBindSessionEntry {
  return { sessionId, pid: process.pid, brokerSocket, bindings };
}

test("the fake lists nothing by default", async () => {
  await withPaths(async (paths) => {
    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* PortBindService;
        return yield* svc.list(paths);
      }).pipe(Effect.provide(makePortBindServiceFake())),
    );
    expect(listed).toEqual([]);
  });
});

test("the fake treats host port zero as automatic selection", async () => {
  await withPaths(async (paths) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* PortBindService;
        return yield* svc.bind(paths, "s1", 3000, 0);
      }).pipe(Effect.provide(makePortBindServiceFake())),
    );
    expect(result.hostPort).toBe(3000);
  });
});

test("the live service hides provisional session entries", async () => {
  await withPaths(async (paths) => {
    const livenessPath = relayScriptPath(paths, "starting");
    await mkdir(path.dirname(livenessPath), { recursive: true });
    await writeFile(livenessPath, "");
    await writeSessionRegistry(paths, entry("starting", livenessPath, []));

    const client = makePortBindClient();
    expect(await client.list(paths)).toEqual([]);
  });
});

test("unbinding a host port no session claims fails with NoSuchBindingError", async () => {
  await withPaths(async (paths) => {
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* PortBindService;
        return yield* svc.unbindByKey(paths, { hostPort: 9999 });
      }).pipe(
        Effect.provide(
          makePortBindServiceFake({
            unbindByKey: () => Effect.fail(new NoSuchBindingError("none")),
          }),
        ),
      ),
    );
    expect(result._tag).toEqual("Failure");
  });
});

test("two live sessions claiming one host port is reported, not guessed", () => {
  const err = new AmbiguousHostPortError(8080, ["s1", "s2"]);
  expect(err.message).toContain("8080");
  expect(err.message).toContain("s1");
});

test("the live service resolves a host port to its claiming session", async () => {
  await withPaths(async (paths) => {
    const firstSocket = brokerSocketPath(paths, "s1");
    const secondSocket = brokerSocketPath(paths, "s2");
    await mkdir(path.dirname(firstSocket), { recursive: true });
    await mkdir(path.dirname(secondSocket), { recursive: true });

    let received: unknown;
    const server = await createUnixServer(firstSocket, (socket) => {
      void (async () => {
        const line = await readJsonLine(socket);
        received = line === null ? null : JSON.parse(line);
        await writeJsonLine(socket, { ok: true });
        socket.end();
      })();
    });

    try {
      await writeFile(secondSocket, "not-a-socket");
      await writeSessionRegistry(
        paths,
        entry("s1", firstSocket, [
          { containerPort: 3000, hostPort: 8080, createdAt: "t" },
        ]),
      );
      await writeSessionRegistry(
        paths,
        entry("s2", secondSocket, [
          { containerPort: 5173, hostPort: 9090, createdAt: "t" },
        ]),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* PortBindService;
          yield* svc.unbindByKey(paths, { hostPort: 8080 });
        }).pipe(Effect.provide(PortBindServiceLive)),
      );

      expect(received).toEqual({ type: "unbind", hostPort: 8080 });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

test("binding a session without a registry entry fails as unreachable", async () => {
  await withPaths(async (paths) => {
    const client = makePortBindClient();
    const error = await client
      .bind(paths, "old-session", 3000, null)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SessionUnreachableError);
  });
});

test("binding rejects malformed success responses from the broker", async () => {
  await withPaths(async (paths) => {
    const socketPath = brokerSocketPath(paths, "s1");
    await mkdir(path.dirname(socketPath), { recursive: true });
    const responses = [
      { ok: true, hostPort: 0, probe: "ok" },
      { ok: true, hostPort: 8080, probe: "unexpected" },
    ];
    let responseIndex = 0;
    const server = await createUnixServer(socketPath, (socket) => {
      void (async () => {
        await readJsonLine(socket);
        await writeJsonLine(socket, responses[responseIndex]);
        responseIndex += 1;
        socket.end();
      })();
    });

    try {
      await writeSessionRegistry(paths, entry("s1", socketPath, []));
      const client = makePortBindClient();
      for (let i = 0; i < responses.length; i += 1) {
        const error = await client
          .bind(paths, "s1", 3000, null)
          .catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(InternalBrokerError);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

async function withFakeBroker<T>(
  reply: (request: unknown) => unknown,
  fn: (
    paths: Awaited<ReturnType<typeof resolvePortsRuntimePaths>>,
  ) => Promise<T>,
): Promise<T> {
  return await withPaths(async (paths) => {
    const socketPath = brokerSocketPath(paths, "s1");
    await mkdir(path.dirname(socketPath), { recursive: true });
    const server = await createUnixServer(socketPath, (socket) => {
      void (async () => {
        const line = await readJsonLine(socket);
        await writeJsonLine(
          socket,
          reply(line === null ? null : JSON.parse(line)),
        );
        socket.end();
      })();
    });
    try {
      await writeSessionRegistry(paths, entry("s1", socketPath, []));
      return await fn(paths);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("the live service asks its session for candidates", async () => {
  let received: unknown;
  await withFakeBroker(
    (request) => {
      received = request;
      return {
        ok: true,
        candidates: [
          { containerPort: 5173, scope: "remote", reachable: false },
        ],
        watch: "watching",
      };
    },
    async (paths) => {
      const result = await makePortBindClient().candidates(paths, "s1");
      expect(received).toEqual({ type: "candidates" });
      expect(result).toEqual({
        candidates: [
          { containerPort: 5173, scope: "remote", reachable: false },
        ],
        watch: "watching",
      });
    },
  );
});

test("a malformed candidates response is a broker error, not data", async () => {
  await withFakeBroker(
    () => ({ ok: true, candidates: [{ containerPort: 0 }], watch: "watching" }),
    async (paths) => {
      await expect(
        makePortBindClient().candidates(paths, "s1"),
      ).rejects.toBeInstanceOf(InternalBrokerError);
    },
  );
});

test("the fake reports a watching scan with nothing found", async () => {
  await withPaths(async (paths) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* PortBindService;
        return yield* svc.candidates(paths, "s1");
      }).pipe(Effect.provide(makePortBindServiceFake())),
    );
    expect(result).toEqual({ candidates: [], watch: "watching" });
  });
});
