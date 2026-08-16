import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cause, Effect, Layer } from "effect";
import type { HostExecBroker } from "../../hostexec/broker.ts";
import type { HostExecBrokerConfig } from "./broker_service.ts";
import {
  awaitGatewayReadyLive,
  closeHostExecStack,
  type GatewayProcess,
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

test("awaitGatewayReadyLive rejects invalid readiness outcomes", async () => {
  const cases = [
    {
      script: `printf '%s\\n' '{"type":"ready","version":2,"socket":"/tmp/expected-exec.sock"}'; exit 0`,
      message: "readiness handshake failed",
      timeoutMs: 200,
    },
    { script: "sleep 2", message: "readiness timed out" },
    { script: "exit 7", message: "exited before readiness" },
    { script: "printf 'not-json\\n'; sleep 2", message: "not valid JSON" },
    {
      script: "printf '%*s' 16385 ''; sleep 2",
      message: "readiness line is too large",
    },
    {
      script: `printf '%s\\n' '{"type":"ready","version":1,"socket":"/tmp/expected-exec.sock"}'; sleep 2`,
      message: "readiness handshake failed",
    },
    {
      script: `printf '%s\\n' '{"type":"ready","version":2,"socket":"/tmp/wrong.sock"}'; sleep 2`,
      message: "readiness handshake failed",
    },
    {
      script: 'printf \'{"type":"ready"\'; exit 0',
      message: "exited before readiness",
    },
  ];
  for (const { script, message, timeoutMs } of cases) {
    await expectReadinessFailure(script, message, timeoutMs);
  }
});
