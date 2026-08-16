import { expect, test } from "bun:test";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cause, Effect, Layer } from "effect";
import {
  type HostExecBroker,
  sendHostExecBrokerRequest,
} from "../../hostexec/broker.ts";
import { resolveGatewayTestArtifacts } from "../../hostexec/gateway_test_harness.ts";
import {
  hostExecPendingSessionDir,
  hostExecSessionRegistryPath,
  listHostExecPendingEntries,
} from "../../hostexec/registry.ts";
import type { HostExecBrokerConfig } from "./broker_service.ts";
import {
  awaitGatewayReadyLive,
  closeHostExecStack,
  type GatewayProcess,
  HostExecBrokerService,
  HostExecBrokerServiceLive,
  HostExecStackOps,
  type HostExecStackOpsShape,
  startBrokerLive,
  startBrokerWithCleanup,
  startHostExecStack,
} from "./broker_service.ts";

const config = {
  paths: {
    runtimeDir: "/tmp/nas-runtime",
    sessionsDir: "/tmp/nas-runtime/sessions",
    pendingDir: "/tmp/nas-runtime/pending",
    brokersDir: "/tmp/nas-runtime/brokers",
    wrappersDir: "/tmp/nas-runtime/wrappers",
  },
  sessionId: "session-1",
  execSocketPath: "/tmp/nas-runtime/brokers/session-1/exec/sock",
  internalSocketPath: "/tmp/nas-runtime/brokers/session-1/gateway.sock",
  controlSocketPath: "/tmp/nas-runtime/brokers/session-1/sock",
  gatewayBinaryPath: "/bin/nas-hostexec-gateway",
  profileName: "default",
  workspaceRoot: "/workspace",
  sessionTmpDir: "/tmp/nas-hostexec",
  notify: "off" as const,
} as HostExecBrokerConfig;

const broker = {} as HostExecBroker;
const gateway = {} as GatewayProcess;
const gatewayArtifacts = await resolveGatewayTestArtifacts();

function makeLiveConfig(root: string): HostExecBrokerConfig {
  const brokerDir = path.join(root, "brokers", "session-1");
  return {
    ...config,
    paths: {
      runtimeDir: root,
      sessionsDir: path.join(root, "sessions"),
      pendingDir: path.join(root, "pending"),
      brokersDir: path.join(root, "brokers"),
      wrappersDir: path.join(root, "wrappers"),
    },
    execSocketPath: path.join(brokerDir, "exec", "sock"),
    internalSocketPath: path.join(brokerDir, "gateway.sock"),
    controlSocketPath: path.join(brokerDir, "sock"),
    workspaceRoot: root,
    sessionTmpDir: path.join(root, "tmp"),
  };
}

interface ProcIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startTime: number;
  readonly state: string;
}

async function readProcIdentity(pid: number): Promise<ProcIdentity | null> {
  try {
    const statText = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = statText.lastIndexOf(") ");
    if (close <= 0) return null;
    const fields = statText
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const values = [
      Number(fields[1]),
      Number(fields[2]),
      Number(fields[3]),
      Number(fields[19]),
    ];
    if (values.some((value) => !Number.isSafeInteger(value))) return null;
    return {
      pid,
      state: fields[0],
      ppid: values[0],
      processGroupId: values[1],
      sessionId: values[2],
      startTime: values[3],
    };
  } catch {
    return null;
  }
}

async function waitForGatewayPid(
  gatewayPath: string,
  externalSocketPath: string,
  timeoutMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const entry of await readdir("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      try {
        if ((await readlink(`/proc/${pid}/exe`)) !== gatewayPath) continue;
        if (
          !(await readFile(`/proc/${pid}/cmdline`, "utf8")).includes(
            externalSocketPath,
          )
        ) {
          continue;
        }
        if (await readProcIdentity(pid)) return pid;
      } catch {
        // The process can exit between /proc lookups.
      }
    }
    await Bun.sleep(10);
  }
  throw new Error("real hostexec gateway did not start");
}

async function waitForGatewayHandler(
  gatewayPid: number,
  gatewayPath: string,
  timeoutMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const children = (
        await readFile(
          `/proc/${gatewayPid}/task/${gatewayPid}/children`,
          "utf8",
        )
      )
        .trim()
        .split(/\s+/);
      for (const child of children) {
        if (!child) continue;
        const pid = Number(child);
        if ((await readlink(`/proc/${pid}/exe`)) === gatewayPath) return pid;
      }
    } catch {
      // The gateway can reap a handler between proc reads.
    }
    await Bun.sleep(10);
  }
  throw new Error("real hostexec gateway handler did not start");
}

async function waitForProcessGone(
  pid: number,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await readProcIdentity(pid);
    if (!identity) return;
    await Bun.sleep(10);
  }
  throw new Error(`process ${pid} did not exit`);
}

async function waitForPendingEntry(
  paths: HostExecBrokerConfig["paths"],
  sessionId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await listHostExecPendingEntries(paths, sessionId)).length === 1) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("pending approval entry did not appear");
}

async function processFdCount(): Promise<number> {
  return (await readdir("/proc/self/fd")).length;
}

async function processFdCountFor(pid: number): Promise<number> {
  return (await readdir(`/proc/${pid}/fd`)).length;
}

async function waitForFdBaseline(
  baseline: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await processFdCount()) === baseline) return;
    await Bun.sleep(10);
  }
  expect(await processFdCount()).toBe(baseline);
}

function spawnReadinessFixture(script: string): GatewayProcess {
  return {
    process: Bun.spawn([Bun.which("bash") ?? "/bin/sh", "-c", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }),
    externalSocketPath: "/tmp/expected-exec.sock",
  };
}

async function expectReadinessFailure(
  script: string,
  expectedMessage: string,
  timeoutMs = 100,
): Promise<void> {
  const gateway = spawnReadinessFixture(script);
  let thrown: unknown;
  try {
    await Effect.runPromise(awaitGatewayReadyLive(gateway, timeoutMs));
  } catch (error) {
    thrown = error;
  } finally {
    if (gateway.process.exitCode === null) gateway.process.kill("SIGKILL");
    await gateway.process.exited;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(String((thrown as Error).message)).toContain(expectedMessage);
}

function fakeOps(
  calls: string[],
  overrides: Partial<HostExecStackOpsShape> = {},
): HostExecStackOpsShape {
  return {
    startBroker: () => {
      calls.push("startBroker");
      return Effect.succeed(broker);
    },
    spawnGateway: () => {
      calls.push("spawnGateway");
      return Effect.succeed(gateway);
    },
    awaitGatewayReady: () => {
      calls.push("awaitGatewayReady");
      return Effect.void;
    },
    writeRegistry: () => {
      calls.push("writeRegistry");
      return Effect.void;
    },
    stopGateway: () => {
      calls.push("stopGateway");
      return Effect.void;
    },
    closeBroker: () => {
      calls.push("closeBroker");
      return Effect.void;
    },
    removeRegistry: () => {
      calls.push("removeRegistry");
      return Effect.void;
    },
    removePending: () => {
      calls.push("removePending");
      return Effect.void;
    },
    warnTeardown: () => Effect.void,
    ...overrides,
  };
}

test("startHostExecStack starts broker, gateway, readiness, then registry", async () => {
  const calls: string[] = [];
  const layer = Layer.succeed(
    HostExecStackOps,
    HostExecStackOps.of(fakeOps(calls)),
  );

  const handle = await Effect.runPromise(
    startHostExecStack(config).pipe(Effect.provide(layer)),
  );
  expect(calls).toEqual([
    "startBroker",
    "spawnGateway",
    "awaitGatewayReady",
    "writeRegistry",
  ]);

  const droppedClose = handle.close();
  expect(calls).toEqual([
    "startBroker",
    "spawnGateway",
    "awaitGatewayReady",
    "writeRegistry",
  ]);

  await Effect.runPromise(droppedClose.pipe(Effect.provide(layer)));
  expect(calls).toEqual([
    "startBroker",
    "spawnGateway",
    "awaitGatewayReady",
    "writeRegistry",
    "stopGateway",
    "closeBroker",
    "removeRegistry",
    "removePending",
  ]);
});

test("startHostExecStack rolls back broker when gateway readiness fails", async () => {
  const calls: string[] = [];
  const layer = Layer.succeed(
    HostExecStackOps,
    HostExecStackOps.of(
      fakeOps(calls, {
        awaitGatewayReady: () => {
          calls.push("awaitGatewayReady");
          return Effect.fail(new Error("not ready"));
        },
      }),
    ),
  );

  const result = await Effect.runPromiseExit(
    startHostExecStack(config).pipe(Effect.provide(layer)),
  );
  expect(result._tag).toBe("Failure");
  expect(calls).toEqual([
    "startBroker",
    "spawnGateway",
    "awaitGatewayReady",
    "stopGateway",
    "closeBroker",
  ]);
});

test("startHostExecStack rolls back gateway and broker when registry write fails", async () => {
  const calls: string[] = [];
  const layer = Layer.succeed(
    HostExecStackOps,
    HostExecStackOps.of(
      fakeOps(calls, {
        writeRegistry: () => {
          calls.push("writeRegistry");
          return Effect.fail(new Error("registry failed"));
        },
      }),
    ),
  );

  const result = await Effect.runPromiseExit(
    startHostExecStack(config).pipe(Effect.provide(layer)),
  );
  expect(result._tag).toBe("Failure");
  expect(calls).toEqual([
    "startBroker",
    "spawnGateway",
    "awaitGatewayReady",
    "writeRegistry",
    "stopGateway",
    "closeBroker",
  ]);
});

test("closeHostExecStack is ordered gateway, broker, registry, pending", async () => {
  const calls: string[] = [];
  const layer = Layer.succeed(
    HostExecStackOps,
    HostExecStackOps.of(fakeOps(calls)),
  );

  await Effect.runPromise(
    closeHostExecStack(config, broker, gateway).pipe(Effect.provide(layer)),
  );
  expect(calls).toEqual([
    "stopGateway",
    "closeBroker",
    "removeRegistry",
    "removePending",
  ]);
});

test("closeHostExecStack aggregates every labeled cleanup failure", async () => {
  const stopError = new Error("gateway stop failed");
  const closeError = new Error("broker close failed");
  const registryError = new Error("registry removal failed");
  const pendingError = new Error("pending removal failed");
  const calls: string[] = [];
  const layer = Layer.succeed(
    HostExecStackOps,
    HostExecStackOps.of(
      fakeOps(calls, {
        stopGateway: () => {
          calls.push("stopGateway");
          return Effect.fail(stopError);
        },
        closeBroker: () => {
          calls.push("closeBroker");
          return Effect.fail(closeError);
        },
        removeRegistry: () => {
          calls.push("removeRegistry");
          return Effect.fail(registryError);
        },
        removePending: () => {
          calls.push("removePending");
          return Effect.fail(pendingError);
        },
      }),
    ),
  );

  const exit = await Effect.runPromiseExit(
    closeHostExecStack(config, broker, gateway).pipe(Effect.provide(layer)),
  );

  expect(calls).toEqual([
    "stopGateway",
    "closeBroker",
    "removeRegistry",
    "removePending",
  ]);
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") return;
  expect(failure.value).toBeInstanceOf(AggregateError);
  const aggregate = failure.value as AggregateError & {
    readonly failures: readonly {
      readonly operation: string;
      readonly error: unknown;
    }[];
  };
  expect(aggregate.errors).toEqual([
    stopError,
    closeError,
    registryError,
    pendingError,
  ]);
  expect(aggregate.failures).toEqual([
    { operation: "stopGateway", error: stopError },
    { operation: "closeBroker", error: closeError },
    { operation: "removeRegistry", error: registryError },
    { operation: "removePending", error: pendingError },
  ]);
  expect(aggregate.message).toContain(
    "stopGateway -> closeBroker -> removeRegistry -> removePending",
  );
  expect(aggregate.cause).toBe(stopError);
});

test("startBrokerLive closes a partially-started broker on internal listen failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-broker-partial-"));
  try {
    const liveConfig = makeLiveConfig(root);
    // HostExecBroker starts the control listener before the internal listener.
    // A directory at the internal socket path makes the second listen fail
    // deterministically after the control server exists.
    await mkdir(liveConfig.internalSocketPath, { recursive: true });

    const result = await Effect.runPromiseExit(startBrokerLive(liveConfig));
    expect(result._tag).toBe("Failure");
    await expect(stat(liveConfig.controlSocketPath)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startBrokerWithCleanup preserves startup and cleanup errors", async () => {
  const startError = new Error("internal listener failed");
  const cleanupError = new Error("control listener cleanup failed");
  let closeCalls = 0;
  const partialBroker = {
    start: async () => {
      throw startError;
    },
    close: async () => {
      closeCalls += 1;
      throw cleanupError;
    },
  } as unknown as HostExecBroker;

  let thrown: unknown;
  try {
    await startBrokerWithCleanup(partialBroker, "/internal", "/control");
  } catch (error) {
    thrown = error;
  }

  expect(closeCalls).toBe(1);
  expect(thrown).toBeInstanceOf(AggregateError);
  const aggregate = thrown as AggregateError;
  expect(aggregate.errors).toEqual([startError, cleanupError]);
});

test.skipIf(!gatewayArtifacts.gatewayPath || !gatewayArtifacts.clientPath)(
  "HostExecBrokerService closes a pending FD-bearing request and its stack",
  async () => {
    const gatewayPath = gatewayArtifacts.gatewayPath;
    const clientPath = gatewayArtifacts.clientPath;
    if (!gatewayPath || !clientPath) return;

    const root = await mkdtemp(path.join(tmpdir(), "nas-broker-close-live-"));
    const liveConfig: HostExecBrokerConfig = {
      ...makeLiveConfig(root),
      sessionId: "service-close",
      gatewayBinaryPath: gatewayPath,
      hostexec: {
        prompt: {
          enable: true,
          timeoutSeconds: 30,
          defaultScope: "capability",
          notify: "off",
        },
        secrets: {},
        rules: [
          {
            id: "close-pending",
            match: { argv0: "node", argRegex: "^-e(?:\\s|$)" },
            cwd: { mode: "workspace-only", allow: [] },
            env: {},
            inheritEnv: { mode: "minimal", keys: [] },
            approval: "prompt",
            fallback: "container",
          },
        ],
      },
    };
    const clientAlias = path.join(root, "node");
    const localFdBaseline = await processFdCount();
    let handle: {
      readonly close: () => Effect.Effect<void, unknown>;
    } | null = null;
    let client: ReturnType<typeof Bun.spawn> | null = null;
    let clientOutput: Promise<[string, string]> | null = null;
    let stdinReader: Awaited<ReturnType<typeof open>> | null = null;
    let stdinWriter: Awaited<ReturnType<typeof open>> | null = null;
    let closed = false;

    try {
      await symlink(clientPath, clientAlias);
      await mkdir(path.dirname(liveConfig.execSocketPath), {
        recursive: true,
        mode: 0o700,
      });
      handle = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* HostExecBrokerService;
          return yield* service.start(liveConfig);
        }).pipe(Effect.provide(HostExecBrokerServiceLive)),
      );

      const gatewayPid = await waitForGatewayPid(
        gatewayPath,
        liveConfig.execSocketPath,
      );
      const gatewayIdentity = await readProcIdentity(gatewayPid);
      expect(gatewayIdentity).not.toBeNull();
      const gatewayFdBaseline = await processFdCountFor(gatewayPid);

      const fifoPath = path.join(root, "stdin.pipe");
      const mkfifo = Bun.spawn(["mkfifo", fifoPath], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await mkfifo.exited).toBe(0);
      stdinReader = await open(
        fifoPath,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      stdinWriter = await open(
        fifoPath,
        constants.O_WRONLY | constants.O_NONBLOCK,
      );
      client = Bun.spawn([clientAlias, "-e", "console.log('LOCAL_FALLBACK')"], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ""}`,
          NAS_HOSTEXEC_SOCKET: liveConfig.execSocketPath,
          NAS_HOSTEXEC_SESSION_ID: liveConfig.sessionId,
          NAS_HOSTEXEC_WRAPPER_DIR: root,
        },
        stdin: stdinReader.fd,
        stdout: "pipe",
        stderr: "pipe",
      });
      clientOutput = Promise.all([
        new Response(client.stdout as ReadableStream<Uint8Array>).text(),
        new Response(client.stderr as ReadableStream<Uint8Array>).text(),
      ]);

      await waitForPendingEntry(liveConfig.paths, liveConfig.sessionId);
      const handlerPid = await waitForGatewayHandler(gatewayPid, gatewayPath);
      expect(await readProcIdentity(handlerPid)).not.toBeNull();
      expect(
        await listHostExecPendingEntries(
          liveConfig.paths,
          liveConfig.sessionId,
        ),
      ).toHaveLength(1);
      expect(await processFdCountFor(gatewayPid)).toBeGreaterThanOrEqual(
        gatewayFdBaseline,
      );

      await Effect.runPromise(handle.close());
      closed = true;

      expect(await client.exited).not.toBe(0);
      const [stdout, stderr] = await clientOutput;
      expect(stdout).toBe("");
      expect(stderr).not.toContain("LOCAL_FALLBACK");
      await waitForProcessGone(handlerPid);
      await waitForProcessGone(gatewayPid);

      await expect(stat(liveConfig.execSocketPath)).rejects.toThrow();
      await expect(stat(liveConfig.internalSocketPath)).rejects.toThrow();
      await expect(stat(liveConfig.controlSocketPath)).rejects.toThrow();
      await expect(
        stat(
          hostExecSessionRegistryPath(liveConfig.paths, liveConfig.sessionId),
        ),
      ).rejects.toThrow();
      await expect(
        stat(hostExecPendingSessionDir(liveConfig.paths, liveConfig.sessionId)),
      ).rejects.toThrow();
      expect(
        await listHostExecPendingEntries(
          liveConfig.paths,
          liveConfig.sessionId,
        ),
      ).toHaveLength(0);
      await expect(
        sendHostExecBrokerRequest(liveConfig.controlSocketPath, {
          type: "list_pending",
        }),
      ).rejects.toThrow();

      await Promise.resolve(
        (client.stdin as { end?: () => unknown } | null)?.end?.(),
      );
      await stdinWriter?.close();
      stdinWriter = null;
      await stdinReader?.close();
      stdinReader = null;
      await waitForFdBaseline(localFdBaseline);
    } finally {
      if (handle && !closed) {
        await Effect.runPromise(handle.close())
          .then(() => {
            closed = true;
          })
          .catch(() => {});
      }
      if (client) {
        if (client.exitCode === null) client.kill("SIGKILL");
        await client.exited.catch(() => -1);
        await Promise.resolve(
          (client.stdin as { end?: () => unknown } | null)?.end?.(),
        ).catch(() => {});
      }
      await clientOutput?.catch(() => ["", ""] as [string, string]);
      await stdinWriter?.close().catch(() => {});
      await stdinReader?.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("startup rollback retains a stop failure and still closes the broker", async () => {
  const startupError = new Error("gateway was not ready");
  const stopError = new Error("gateway would not stop");
  const calls: string[] = [];
  const layer = Layer.succeed(
    HostExecStackOps,
    HostExecStackOps.of(
      fakeOps(calls, {
        awaitGatewayReady: () => {
          calls.push("awaitGatewayReady");
          return Effect.fail(startupError);
        },
        stopGateway: () => {
          calls.push("stopGateway");
          return Effect.fail(stopError);
        },
      }),
    ),
  );

  const exit = await Effect.runPromiseExit(
    startHostExecStack(config).pipe(Effect.provide(layer)),
  );

  expect(calls).toEqual([
    "startBroker",
    "spawnGateway",
    "awaitGatewayReady",
    "stopGateway",
    "closeBroker",
  ]);
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "Some") {
      expect(failure.value).toBeInstanceOf(AggregateError);
      expect((failure.value as AggregateError).errors).toEqual([
        startupError,
        stopError,
      ]);
    }
  }
});

test("startup rollback retains both cleanup failures", async () => {
  const startupError = new Error("registry write failed");
  const stopError = new Error("gateway would not stop");
  const closeError = new Error("broker would not close");
  const calls: string[] = [];
  const layer = Layer.succeed(
    HostExecStackOps,
    HostExecStackOps.of(
      fakeOps(calls, {
        writeRegistry: () => {
          calls.push("writeRegistry");
          return Effect.fail(startupError);
        },
        stopGateway: () => {
          calls.push("stopGateway");
          return Effect.fail(stopError);
        },
        closeBroker: () => {
          calls.push("closeBroker");
          return Effect.fail(closeError);
        },
      }),
    ),
  );

  const exit = await Effect.runPromiseExit(
    startHostExecStack(config).pipe(Effect.provide(layer)),
  );

  expect(calls).toEqual([
    "startBroker",
    "spawnGateway",
    "awaitGatewayReady",
    "writeRegistry",
    "stopGateway",
    "closeBroker",
  ]);
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "Some") {
      expect(failure.value).toBeInstanceOf(AggregateError);
      expect((failure.value as AggregateError).errors).toEqual([
        startupError,
        stopError,
        closeError,
      ]);
    }
  }
});

test("handle close retries after failure and is idempotent after success", async () => {
  const calls: string[] = [];
  let stopAttempts = 0;
  const layer = Layer.succeed(
    HostExecStackOps,
    HostExecStackOps.of(
      fakeOps(calls, {
        stopGateway: () => {
          calls.push("stopGateway");
          stopAttempts += 1;
          return stopAttempts === 1
            ? Effect.fail(new Error("transient stop failure"))
            : Effect.void;
        },
      }),
    ),
  );

  const handle = await Effect.runPromise(
    startHostExecStack(config).pipe(Effect.provide(layer)),
  );
  const firstClose = await Effect.runPromiseExit(
    handle.close().pipe(Effect.provide(layer)),
  );
  expect(firstClose._tag).toBe("Failure");
  expect(calls).toEqual([
    "startBroker",
    "spawnGateway",
    "awaitGatewayReady",
    "writeRegistry",
    "stopGateway",
    "closeBroker",
    "removeRegistry",
    "removePending",
  ]);

  await Effect.runPromise(handle.close().pipe(Effect.provide(layer)));
  expect(calls).toEqual([
    "startBroker",
    "spawnGateway",
    "awaitGatewayReady",
    "writeRegistry",
    "stopGateway",
    "closeBroker",
    "removeRegistry",
    "removePending",
    "stopGateway",
    "closeBroker",
    "removeRegistry",
    "removePending",
  ]);

  await Effect.runPromise(handle.close().pipe(Effect.provide(layer)));
  expect(calls).toHaveLength(12);
});

test("handle close serializes concurrent effects and leaves diagnostics to its caller", async () => {
  const stopError = new Error("transient stop failure");
  const calls: string[] = [];
  const warnings: unknown[] = [];
  let activeStops = 0;
  let maximumActiveStops = 0;
  const warningOps = {
    ...fakeOps(calls, {
      stopGateway: () =>
        Effect.gen(function* () {
          calls.push("stopGateway");
          activeStops += 1;
          maximumActiveStops = Math.max(maximumActiveStops, activeStops);
          yield* Effect.sleep("5 millis");
          activeStops -= 1;
          return yield* Effect.fail(stopError);
        }),
    }),
    warnTeardown: (cause: unknown) =>
      Effect.sync(() => {
        warnings.push(cause);
      }),
  };
  const layer = Layer.succeed(
    HostExecStackOps,
    HostExecStackOps.of(warningOps as unknown as HostExecStackOpsShape),
  );
  const handle = await Effect.runPromise(
    startHostExecStack(config).pipe(Effect.provide(layer)),
  );

  const [first, second] = await Promise.all([
    Effect.runPromiseExit(handle.close().pipe(Effect.provide(layer))),
    Effect.runPromiseExit(handle.close().pipe(Effect.provide(layer))),
  ]);

  expect(first._tag).toBe("Failure");
  expect(second._tag).toBe("Failure");
  expect(maximumActiveStops).toBe(1);
  expect(warnings).toHaveLength(0);
});

test("awaitGatewayReadyLive accepts a live v2 readiness line", async () => {
  const gateway = spawnReadinessFixture(
    `printf '%s\\n' '{"type":"ready","version":2,"socket":"/tmp/expected-exec.sock"}'; sleep 2`,
  );
  const startedAt = performance.now();
  try {
    await Effect.runPromise(awaitGatewayReadyLive(gateway, 200));
    expect(gateway.process.exitCode).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(250);
  } finally {
    gateway.process.kill("SIGKILL");
    await gateway.process.exited;
  }
});

test("awaitGatewayReadyLive rejects a gateway that exits after readiness", async () => {
  await expectReadinessFailure(
    `printf '%s\\n' '{"type":"ready","version":2,"socket":"/tmp/expected-exec.sock"}'; exit 0`,
    "readiness handshake failed",
    200,
  );
});

test("awaitGatewayReadyLive rejects a readiness timeout", async () => {
  await expectReadinessFailure("sleep 2", "readiness timed out");
});

test("awaitGatewayReadyLive rejects an early child exit", async () => {
  await expectReadinessFailure("exit 7", "exited before readiness");
});

test("awaitGatewayReadyLive rejects malformed JSON", async () => {
  await expectReadinessFailure(
    "printf 'not-json\\n'; sleep 2",
    "not valid JSON",
  );
});

test("awaitGatewayReadyLive rejects an oversized readiness line", async () => {
  await expectReadinessFailure(
    "printf '%*s' 16385 ''; sleep 2",
    "readiness line is too large",
  );
});

test("awaitGatewayReadyLive rejects the wrong readiness version", async () => {
  await expectReadinessFailure(
    `printf '%s\\n' '{"type":"ready","version":1,"socket":"/tmp/expected-exec.sock"}'; sleep 2`,
    "readiness handshake failed",
  );
});

test("awaitGatewayReadyLive rejects the wrong readiness socket", async () => {
  await expectReadinessFailure(
    `printf '%s\\n' '{"type":"ready","version":2,"socket":"/tmp/wrong.sock"}'; sleep 2`,
    "readiness handshake failed",
  );
});

test("awaitGatewayReadyLive rejects EOF before a readiness line", async () => {
  await expectReadinessFailure(
    'printf \'{"type":"ready"\'; exit 0',
    "exited before readiness",
  );
});
