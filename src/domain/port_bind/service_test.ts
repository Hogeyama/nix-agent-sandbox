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
import { PORT_BIND_PROTOCOL_VERSION } from "../../network/port_bind_protocol.ts";
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
  ContainerPortTakenError,
  InternalBrokerError,
  NoSuchBindingError,
  RelayUnavailableError,
  SessionRestartRequiredError,
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
  reply: (
    request: unknown,
    paths: Awaited<ReturnType<typeof resolvePortsRuntimePaths>>,
    socketPath: string,
  ) => unknown | Promise<unknown>,
  fn: (
    paths: Awaited<ReturnType<typeof resolvePortsRuntimePaths>>,
  ) => Promise<T>,
  registry: Pick<PortBindSessionEntry, "protocolVersion" | "forwards"> = {
    protocolVersion: undefined,
    forwards: [],
  },
): Promise<T> {
  return await withPaths(async (paths) => {
    const socketPath = brokerSocketPath(paths, "s1");
    await mkdir(path.dirname(socketPath), { recursive: true });
    const server = await createUnixServer(socketPath, (socket) => {
      void (async () => {
        const line = await readJsonLine(socket);
        await writeJsonLine(
          socket,
          await reply(
            line === null ? null : JSON.parse(line),
            paths,
            socketPath,
          ),
        );
        socket.end();
      })();
    });
    try {
      await writeSessionRegistry(paths, {
        ...entry("s1", socketPath, []),
        ...registry,
      });
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

test("the live service forwards through its session and validates the answer", async () => {
  let received: unknown;
  await withFakeBroker(
    async (request, paths, socketPath) => {
      received = request;
      const isForward = (request as { type?: string }).type === "forward";
      await writeSessionRegistry(paths, {
        ...entry("s1", socketPath, []),
        forwards: isForward
          ? [
              {
                containerPort: 5432,
                hostPort: 5432,
                createdAt: "2026-09-08T00:00:00.000Z",
              },
            ]
          : [],
      });
      if (!isForward) return { ok: true };
      return { ok: true, containerPort: 5432, hostPort: 5432, hostProbe: "ok" };
    },
    async (paths) => {
      const client = makePortBindClient();
      expect(await client.forward(paths, "s1", 5432, 5432)).toEqual({
        containerPort: 5432,
        hostPort: 5432,
        hostProbe: "ok",
      });
      expect(received).toEqual({
        type: "forward",
        containerPort: 5432,
        hostPort: 5432,
      });
      await client.unforward(paths, { sessionId: "s1", containerPort: 5432 });
      expect(received).toEqual({ type: "unforward", containerPort: 5432 });
    },
  );
});

test("forward errors keep their kind across the socket", async () => {
  await withFakeBroker(
    () => ({
      ok: false,
      error: "relay-unavailable",
      message: "the container is not running",
    }),
    async (paths) => {
      const error = await makePortBindClient()
        .forward(paths, "s1", 5432, 5432)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(RelayUnavailableError);
    },
  );
  await withFakeBroker(
    () => ({ ok: false, error: "container-port-taken", message: "in use" }),
    async (paths) => {
      const error = await makePortBindClient()
        .forward(paths, "s1", 5432, 5432)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ContainerPortTakenError);
    },
  );
});

test("a malformed forward response is a broker error, not data", async () => {
  await withFakeBroker(
    () => ({ ok: true, containerPort: 5432, hostPort: 0, hostProbe: "ok" }),
    async (paths) => {
      const error = await makePortBindClient()
        .forward(paths, "s1", 5432, 5432)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(InternalBrokerError);
    },
  );
});

test("the fake forwards to the same port and answers ok", async () => {
  await withPaths(async (paths) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* PortBindService;
        return yield* svc.forward(paths, "s1", 5432, 15_432);
      }).pipe(Effect.provide(makePortBindServiceFake())),
    );
    expect(result).toEqual({
      containerPort: 5432,
      hostPort: 15_432,
      hostProbe: "ok",
    });
  });
});

test("the fake remove result preserves retained and listener state", async () => {
  await withPaths(async (paths) => {
    const expected = {
      removed: true,
      retainedInternal: true,
      listenerClosed: false,
    };
    const client = makePortBindClient(
      makePortBindServiceFake({
        remove: () => Effect.succeed(expected),
      }),
    );
    expect(
      await client.remove(paths, "s1", {
        direction: "remote",
        containerPort: 5432,
      }),
    ).toEqual(expected);
  });
});

test("current sessions use the common owner-free control wire", async () => {
  const received: unknown[] = [];
  await withFakeBroker(
    (request) => {
      received.push(request);
      if ((request as { type?: string }).type === "add-forward") {
        return {
          ok: true,
          entry: {
            direction: "remote",
            containerPort: 15_432,
            hostPort: 5432,
            owners: ["dynamic"],
            createdAt: "2026-09-08T00:00:00.000Z",
            state: "active",
          },
          probe: "no-answer",
        };
      }
      return {
        ok: true,
        removed: true,
        retainedInternal: true,
        listenerClosed: false,
      };
    },
    async (paths) => {
      const client = makePortBindClient();
      expect(
        await client.add(paths, "s1", {
          direction: "remote",
          containerPort: 15_432,
          hostPort: 5432,
        }),
      ).toMatchObject({
        entry: {
          direction: "remote",
          owners: ["dynamic"],
          state: "active",
        },
        probe: "no-answer",
      });
      expect(
        await client.remove(paths, "s1", {
          direction: "local",
          hostPort: 8080,
        }),
      ).toEqual({
        removed: true,
        retainedInternal: true,
        listenerClosed: false,
      });
      expect(received).toEqual([
        {
          type: "add-forward",
          direction: "remote",
          containerPort: 15_432,
          hostPort: 5432,
        },
        {
          type: "remove-forward",
          direction: "local",
          hostPort: 8080,
        },
      ]);
    },
    { protocolVersion: PORT_BIND_PROTOCOL_VERSION, forwards: [] },
  );
});

test("an unversioned session falls back to the legacy local wire", async () => {
  let received: unknown;
  await withFakeBroker(
    async (request, paths, socketPath) => {
      received = request;
      await writeSessionRegistry(paths, {
        ...entry("s1", socketPath, [
          {
            containerPort: 3000,
            hostPort: 8080,
            createdAt: "2026-09-08T00:00:00.000Z",
          },
        ]),
        forwards: [],
      });
      return { ok: true, hostPort: 8080, probe: "ok" };
    },
    async (paths) => {
      expect(
        await makePortBindClient().add(paths, "s1", {
          direction: "local",
          containerPort: 3000,
          hostPort: 8080,
        }),
      ).toEqual({
        entry: {
          direction: "local",
          containerPort: 3000,
          hostPort: 8080,
          owners: ["dynamic"],
          createdAt: "2026-09-08T00:00:00.000Z",
          state: "active",
        },
        probe: "ok",
      });
      expect(received).toEqual({
        type: "bind",
        containerPort: 3000,
        hostPort: 8080,
      });
    },
  );
});

test("legacy remote removal is conservative while local removal confirms closure", async () => {
  const received: unknown[] = [];
  await withFakeBroker(
    (request) => {
      received.push(request);
      return { ok: true };
    },
    async (paths) => {
      const client = makePortBindClient();
      expect(
        await client.remove(paths, "s1", {
          direction: "remote",
          containerPort: 15_432,
        }),
      ).toEqual({
        removed: true,
        retainedInternal: false,
        listenerClosed: false,
      });
      expect(
        await client.remove(paths, "s1", {
          direction: "local",
          hostPort: 8080,
        }),
      ).toEqual({
        removed: true,
        retainedInternal: false,
        listenerClosed: true,
      });
      expect(received).toEqual([
        { type: "unforward", containerPort: 15_432 },
        { type: "unbind", hostPort: 8080 },
      ]);
    },
  );
});

test("legacy sessions without remote support require restart", async () => {
  await withFakeBroker(
    () => ({ ok: true }),
    async (paths) => {
      await expect(
        makePortBindClient().add(paths, "s1", {
          direction: "remote",
          containerPort: 15_432,
          hostPort: 5432,
        }),
      ).rejects.toBeInstanceOf(SessionRestartRequiredError);
    },
    { protocolVersion: undefined, forwards: undefined },
  );
});
