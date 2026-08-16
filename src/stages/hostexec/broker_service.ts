/**
 * HostExecBrokerService — owns one broker/gateway session stack.
 *
 * The TypeScript broker is the policy and masking boundary. The per-session
 * Zig gateway owns the container-facing socket and delegated stdin fd. The
 * service keeps their startup and teardown transactional so a stage never
 * has to describe process or socket I/O itself.
 */

import { Cause, Context, Effect, Layer, Ref } from "effect";
import type { HostExecConfig } from "../../config/types.ts";
import {
  HostExecBroker,
  type MaskFilterConfig,
} from "../../hostexec/broker.ts";
import type { ResolvedNotifyBackend } from "../../hostexec/notify.ts";
import type { HostExecRuntimePaths } from "../../hostexec/registry.ts";
import {
  removeHostExecPendingDir,
  removeHostExecSessionRegistry,
  writeHostExecSessionRegistry,
} from "../../hostexec/registry.ts";
import { logWarn } from "../../log.ts";

// ---------------------------------------------------------------------------
// Config and resource handles
// ---------------------------------------------------------------------------

export interface HostExecBrokerConfig {
  readonly paths: HostExecRuntimePaths;
  readonly sessionId: string;
  /** Container-visible socket owned by the gateway. */
  readonly execSocketPath: string;
  /** Host-only socket listened to by the TypeScript broker. */
  readonly internalSocketPath: string;
  readonly controlSocketPath: string;
  readonly gatewayBinaryPath: string;
  readonly profileName: string;
  readonly workspaceRoot: string;
  readonly sessionTmpDir: string;
  readonly agent?: string;
  readonly hostexec?: HostExecConfig;
  readonly notify: ResolvedNotifyBackend;
  readonly uiEnabled?: boolean;
  readonly uiPort?: number;
  readonly uiIdleTimeout?: number;
  readonly auditDir?: string;
  readonly maskFilter?: MaskFilterConfig;
  readonly integrityTargets?: readonly string[];
}

export interface GatewayProcess {
  readonly process: ReturnType<typeof Bun.spawn>;
  readonly externalSocketPath: string;
}

export interface HostExecBrokerHandle {
  readonly close: () => Effect.Effect<void, unknown>;
  /** Report a persistent close failure after the caller has exhausted retries. */
  readonly reportTeardown: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
}

export type HostExecCleanupOperation =
  | "stopGateway"
  | "closeBroker"
  | "removeRegistry"
  | "removePending";

export interface HostExecCleanupFailure {
  readonly operation: HostExecCleanupOperation;
  readonly error: unknown;
}

export class HostExecTeardownError extends AggregateError {
  readonly failures: readonly HostExecCleanupFailure[];

  constructor(failures: readonly HostExecCleanupFailure[]) {
    super(
      failures.map(({ error }) => error),
      `HostExecBrokerService teardown failed (${failures
        .map(({ operation }) => operation)
        .join(" -> ")})`,
      { cause: failures[0]?.error },
    );
    this.name = "HostExecTeardownError";
    this.failures = failures;
  }
}

// ---------------------------------------------------------------------------
// File-private Ops stack (exported for colocated unit tests)
// ---------------------------------------------------------------------------

/**
 * D1 operations used by the composed session-stack workflow. Keeping these
 * operations injected makes every ordering and rollback branch unit-testable
 * without starting a real broker or gateway.
 */
export interface HostExecStackOpsShape {
  startBroker(
    config: HostExecBrokerConfig,
  ): Effect.Effect<HostExecBroker, unknown>;
  spawnGateway(
    config: HostExecBrokerConfig,
  ): Effect.Effect<GatewayProcess, unknown>;
  awaitGatewayReady(process: GatewayProcess): Effect.Effect<void, unknown>;
  writeRegistry(config: HostExecBrokerConfig): Effect.Effect<void, unknown>;
  stopGateway(process: GatewayProcess): Effect.Effect<void, unknown>;
  closeBroker(broker: HostExecBroker): Effect.Effect<void, unknown>;
  removeRegistry(config: HostExecBrokerConfig): Effect.Effect<void, unknown>;
  removePending(config: HostExecBrokerConfig): Effect.Effect<void, unknown>;
  warnTeardown(cause: Cause.Cause<unknown>): Effect.Effect<void>;
}

export class HostExecStackOps extends Context.Tag("nas/HostExecStackOps")<
  HostExecStackOps,
  HostExecStackOpsShape
>() {}

const GATEWAY_READY_TIMEOUT_MS = 5_000;
const GATEWAY_READY_SETTLE_MS = 25;
const GATEWAY_READY_MAX_BYTES = 16 * 1024;

async function verifyGatewayProcessAlive(
  gateway: GatewayProcess,
): Promise<void> {
  if (
    gateway.process.exitCode !== null ||
    gateway.process.killed ||
    gateway.process.pid <= 0
  ) {
    throw new Error("hostexec gateway readiness handshake failed");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), GATEWAY_READY_SETTLE_MS);
  });
  try {
    const exited = gateway.process.exited.then(() => true);
    if (await Promise.race([exited, settled])) {
      throw new Error("hostexec gateway readiness handshake failed");
    }
    if (
      gateway.process.exitCode !== null ||
      gateway.process.killed ||
      gateway.process.pid <= 0
    ) {
      throw new Error("hostexec gateway readiness handshake failed");
    }
    try {
      globalThis.process.kill(gateway.process.pid, 0);
    } catch {
      throw new Error("hostexec gateway readiness handshake failed");
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readGatewayReadyLine(
  gateway: GatewayProcess,
  timeoutMs = GATEWAY_READY_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const stdout = gateway.process.stdout;
  if (!stdout || typeof stdout === "number") {
    throw new Error("hostexec gateway stdout is not a readable pipe");
  }
  const reader = stdout.getReader();
  let buffered = "";
  const read = async (): Promise<Record<string, unknown>> => {
    while (true) {
      const next = await reader.read();
      if (next.done)
        throw new Error("hostexec gateway exited before readiness");
      buffered += new TextDecoder().decode(next.value);
      if (
        new TextEncoder().encode(buffered).byteLength > GATEWAY_READY_MAX_BYTES
      ) {
        throw new Error("hostexec gateway readiness line is too large");
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) continue;
      const line = buffered.slice(0, newline);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new Error("hostexec gateway readiness is not valid JSON");
      }
      if (!parsed || typeof parsed !== "object") {
        throw new Error("hostexec gateway readiness is not an object");
      }
      return parsed as Record<string, unknown>;
    }
  };
  const readTask = read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const message = await Promise.race([
      readTask,
      new Promise<Record<string, unknown>>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("hostexec gateway readiness timed out")),
          timeoutMs,
        );
      }),
    ]);
    if (
      message.type !== "ready" ||
      message.version !== 2 ||
      message.socket !== gateway.externalSocketPath
    ) {
      throw new Error("hostexec gateway readiness handshake failed");
    }
    await verifyGatewayProcessAlive(gateway);
    return message;
  } finally {
    if (timer) clearTimeout(timer);
    void readTask.catch(() => {});
  }
}

export async function startBrokerWithCleanup(
  broker: HostExecBroker,
  internalSocketPath: string,
  controlSocketPath: string,
): Promise<HostExecBroker> {
  try {
    await broker.start(internalSocketPath, controlSocketPath);
    return broker;
  } catch (startError) {
    try {
      await broker.close();
    } catch (closeError) {
      throw new AggregateError(
        [startError, closeError],
        "HostExecBrokerService broker start and cleanup failed",
        { cause: startError },
      );
    }
    throw startError;
  }
}

export function startBrokerLive(
  config: HostExecBrokerConfig,
): Effect.Effect<HostExecBroker, unknown> {
  return Effect.tryPromise({
    try: async () => {
      const broker = new HostExecBroker({
        paths: config.paths,
        sessionId: config.sessionId,
        profileName: config.profileName,
        workspaceRoot: config.workspaceRoot,
        sessionTmpDir: config.sessionTmpDir,
        hostexec: config.hostexec,
        notify: config.notify,
        uiEnabled: config.uiEnabled,
        uiPort: config.uiPort,
        uiIdleTimeout: config.uiIdleTimeout,
        auditDir: config.auditDir,
        maskFilter: config.maskFilter,
        integrityTargets: config.integrityTargets,
      });
      return await startBrokerWithCleanup(
        broker,
        config.internalSocketPath,
        config.controlSocketPath,
      );
    },
    catch: (error) => {
      if (error instanceof AggregateError) return error;
      return new Error(
        `HostExecBrokerService broker start failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    },
  });
}

function spawnGatewayLive(
  config: HostExecBrokerConfig,
): Effect.Effect<GatewayProcess, unknown> {
  return Effect.try({
    try: () => ({
      process: Bun.spawn(
        [
          config.gatewayBinaryPath,
          "--session-id",
          config.sessionId,
          "--external-socket",
          config.execSocketPath,
          "--internal-socket",
          config.internalSocketPath,
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "inherit",
        },
      ),
      externalSocketPath: config.execSocketPath,
    }),
    catch: (error) =>
      new Error(
        `HostExecBrokerService gateway spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
}

export function awaitGatewayReadyLive(
  gateway: GatewayProcess,
  timeoutMs = GATEWAY_READY_TIMEOUT_MS,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await readGatewayReadyLine(gateway, timeoutMs);
    },
    catch: (error) =>
      new Error(
        `HostExecBrokerService gateway readiness failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
}

function writeRegistryLive(
  config: HostExecBrokerConfig,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      await writeHostExecSessionRegistry(config.paths, {
        version: 1,
        sessionId: config.sessionId,
        brokerSocket: config.controlSocketPath,
        profileName: config.profileName,
        createdAt: new Date().toISOString(),
        pid: process.pid,
        agent: config.agent,
      });
    },
    catch: (error) =>
      new Error(
        `HostExecBrokerService registry write failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
}

function stopGatewayLive(
  gateway: GatewayProcess,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: async () => {
      if (gateway.process.exitCode === null) gateway.process.kill("SIGTERM");
      await gateway.process.exited;
    },
    catch: (error) =>
      new Error(
        `HostExecBrokerService gateway stop failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
}

function closeBrokerLive(broker: HostExecBroker): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () => broker.close(),
    catch: (error) =>
      new Error(
        `HostExecBrokerService broker close failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
}

function removeRegistryLive(
  config: HostExecBrokerConfig,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise(() =>
    removeHostExecSessionRegistry(config.paths, config.sessionId),
  );
}

function removePendingLive(
  config: HostExecBrokerConfig,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise(() =>
    removeHostExecPendingDir(config.paths, config.sessionId),
  );
}

function warnTeardownLive(cause: Cause.Cause<unknown>): Effect.Effect<void> {
  return Effect.sync(() => {
    logWarn(
      `[nas] HostExecBrokerService teardown failed: ${Cause.pretty(cause)}`,
    );
  });
}

const HostExecStackOpsLive: Layer.Layer<HostExecStackOps> = Layer.succeed(
  HostExecStackOps,
  HostExecStackOps.of({
    startBroker: (config) => startBrokerLive(config),
    spawnGateway: spawnGatewayLive,
    awaitGatewayReady: awaitGatewayReadyLive,
    writeRegistry: writeRegistryLive,
    stopGateway: stopGatewayLive,
    closeBroker: closeBrokerLive,
    removeRegistry: removeRegistryLive,
    removePending: removePendingLive,
    warnTeardown: warnTeardownLive,
  }),
);

// ---------------------------------------------------------------------------
// Composed stack orchestration (D2: Ops only, no direct I/O)
// ---------------------------------------------------------------------------

function rollbackStart(
  ops: HostExecStackOpsShape,
  broker: HostExecBroker,
  gateway: GatewayProcess | undefined,
  error: unknown,
): Effect.Effect<never, unknown> {
  return Effect.gen(function* () {
    const cleanupErrors: unknown[] = [];
    if (gateway) {
      const stop = yield* ops.stopGateway(gateway).pipe(Effect.either);
      if (stop._tag === "Left") cleanupErrors.push(stop.left);
    }
    const close = yield* ops.closeBroker(broker).pipe(Effect.either);
    if (close._tag === "Left") cleanupErrors.push(close.left);
    return yield* Effect.fail(
      new AggregateError(
        [error, ...cleanupErrors],
        cleanupErrors.length === 0
          ? "HostExecBrokerService startup failed; rollback completed"
          : `HostExecBrokerService startup failed and rollback encountered ${cleanupErrors.length} error(s)`,
        { cause: error },
      ),
    );
  });
}

function closeHostExecHandle(
  config: HostExecBrokerConfig,
  broker: HostExecBroker,
  gateway: GatewayProcess,
  state: Ref.Ref<"open" | "closed">,
  semaphore: Effect.Semaphore,
): Effect.Effect<void, unknown, HostExecStackOps> {
  const close = Effect.gen(function* () {
    if ((yield* Ref.get(state)) === "closed") return;
    yield* closeHostExecStack(config, broker, gateway).pipe(
      Effect.tap(() => Ref.set(state, "closed")),
      Effect.catchAllCause((cause) =>
        Ref.set(state, "open").pipe(Effect.zipRight(Effect.failCause(cause))),
      ),
    );
  });
  return semaphore.withPermits(1)(close);
}

function reportHostExecTeardown(
  cause: Cause.Cause<unknown>,
): Effect.Effect<void, never, HostExecStackOps> {
  return Effect.gen(function* () {
    const ops = yield* HostExecStackOps;
    yield* ops.warnTeardown(cause);
  });
}

export function startHostExecStack(
  config: HostExecBrokerConfig,
): Effect.Effect<HostExecBrokerHandle, unknown, HostExecStackOps> {
  return Effect.gen(function* () {
    const ops = yield* HostExecStackOps;
    const brokerResult = yield* ops.startBroker(config).pipe(Effect.either);
    if (brokerResult._tag === "Left") {
      return yield* Effect.fail(brokerResult.left);
    }
    const broker = brokerResult.right;

    const gatewayResult = yield* ops.spawnGateway(config).pipe(Effect.either);
    if (gatewayResult._tag === "Left") {
      return yield* rollbackStart(ops, broker, undefined, gatewayResult.left);
    }
    const gateway = gatewayResult.right;

    const readinessResult = yield* ops
      .awaitGatewayReady(gateway)
      .pipe(Effect.either);
    if (readinessResult._tag === "Left") {
      return yield* rollbackStart(ops, broker, gateway, readinessResult.left);
    }

    const registryResult = yield* ops.writeRegistry(config).pipe(Effect.either);
    if (registryResult._tag === "Left") {
      return yield* rollbackStart(ops, broker, gateway, registryResult.left);
    }

    const closeContext = yield* Effect.context<HostExecStackOps>();
    const closeState = yield* Ref.make<"open" | "closed">("open");
    const closeSemaphore = yield* Effect.makeSemaphore(1);
    return {
      close: () =>
        closeHostExecHandle(
          config,
          broker,
          gateway,
          closeState,
          closeSemaphore,
        ).pipe(Effect.provide(closeContext)),
      reportTeardown: (cause) =>
        reportHostExecTeardown(cause).pipe(Effect.provide(closeContext)),
    } satisfies HostExecBrokerHandle;
  });
}

export function closeHostExecStack(
  config: HostExecBrokerConfig,
  broker: HostExecBroker,
  gateway: GatewayProcess,
): Effect.Effect<void, unknown, HostExecStackOps> {
  return Effect.gen(function* () {
    const ops = yield* HostExecStackOps;
    const failures: HostExecCleanupFailure[] = [];
    const stop = yield* ops.stopGateway(gateway).pipe(Effect.either);
    if (stop._tag === "Left") {
      failures.push({ operation: "stopGateway", error: stop.left });
    }
    const close = yield* ops.closeBroker(broker).pipe(Effect.either);
    if (close._tag === "Left") {
      failures.push({ operation: "closeBroker", error: close.left });
    }
    const registry = yield* ops.removeRegistry(config).pipe(Effect.either);
    if (registry._tag === "Left") {
      failures.push({ operation: "removeRegistry", error: registry.left });
    }
    const pending = yield* ops.removePending(config).pipe(Effect.either);
    if (pending._tag === "Left") {
      failures.push({ operation: "removePending", error: pending.left });
    }
    if (failures.length > 0) {
      return yield* Effect.fail(new HostExecTeardownError(failures));
    }
  });
}

// ---------------------------------------------------------------------------
// Public stage service
// ---------------------------------------------------------------------------

export class HostExecBrokerService extends Context.Tag(
  "nas/HostExecBrokerService",
)<
  HostExecBrokerService,
  {
    readonly start: (
      config: HostExecBrokerConfig,
    ) => Effect.Effect<HostExecBrokerHandle, unknown>;
  }
>() {}

export const HostExecBrokerServiceLive: Layer.Layer<HostExecBrokerService> =
  Layer.succeed(
    HostExecBrokerService,
    HostExecBrokerService.of({
      start: (config) =>
        startHostExecStack(config).pipe(Effect.provide(HostExecStackOpsLive)),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface HostExecBrokerServiceFakeConfig {
  readonly start?: (
    config: HostExecBrokerConfig,
  ) => Effect.Effect<HostExecBrokerHandle, unknown>;
}

export function makeHostExecBrokerServiceFake(
  overrides: HostExecBrokerServiceFakeConfig = {},
): Layer.Layer<HostExecBrokerService> {
  return Layer.succeed(
    HostExecBrokerService,
    HostExecBrokerService.of({
      start:
        overrides.start ??
        (() =>
          Effect.succeed({
            close: () => Effect.void,
            reportTeardown: () => Effect.void,
          })),
    }),
  );
}
