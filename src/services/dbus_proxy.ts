/**
 * DbusProxyService — Effect-based abstraction over xdg-dbus-proxy lifecycle.
 *
 * Manages directory creation, proxy process spawning, and socket readiness waiting.
 *
 * Live implementation delegates to FsService + ProcessService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer, type Scope } from "effect";
import { FsService } from "./fs.ts";
import { ProcessService } from "./process.ts";

// ---------------------------------------------------------------------------
// Service-local plan interface (avoids service → stage dependency)
// ---------------------------------------------------------------------------

export interface DbusProxyStartPlan {
  readonly proxyBinaryPath: string;
  readonly runtimeDir: string;
  readonly sessionsDir: string;
  readonly sessionDir: string;
  readonly socketPath: string;
  readonly args: string[];
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface DbusProxyHandle {
  readonly kill: () => void;
}

// ---------------------------------------------------------------------------
// DbusProxyService tag
// ---------------------------------------------------------------------------

export class DbusProxyService extends Context.Tag("nas/DbusProxyService")<
  DbusProxyService,
  {
    readonly startProxy: (
      plan: DbusProxyStartPlan,
    ) => Effect.Effect<DbusProxyHandle, unknown, Scope.Scope>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const DbusProxyServiceLive: Layer.Layer<
  DbusProxyService,
  never,
  FsService | ProcessService
> = Layer.effect(
  DbusProxyService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    const proc = yield* ProcessService;

    return DbusProxyService.of({
      startProxy: (plan) =>
        Effect.gen(function* () {
          yield* fs.mkdir(plan.runtimeDir, { recursive: true, mode: 0o755 });
          yield* fs.mkdir(plan.sessionsDir, { recursive: true, mode: 0o700 });
          yield* fs.mkdir(plan.sessionDir, { recursive: true, mode: 0o700 });

          const spawnHandle = yield* Effect.acquireRelease(
            proc.spawn(plan.proxyBinaryPath, plan.args),
            (handle) => Effect.sync(() => handle.kill()),
          );

          yield* proc.waitForFileExists(
            plan.socketPath,
            plan.timeoutMs,
            plan.pollIntervalMs,
          );

          return { kill: () => spawnHandle.kill() } satisfies DbusProxyHandle;
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface DbusProxyServiceFakeConfig {
  readonly startProxy?: (
    plan: DbusProxyStartPlan,
  ) => Effect.Effect<DbusProxyHandle, unknown, Scope.Scope>;
}

const defaultHandle: DbusProxyHandle = { kill: () => {} };

export function makeDbusProxyServiceFake(
  overrides: DbusProxyServiceFakeConfig = {},
): Layer.Layer<DbusProxyService> {
  return Layer.succeed(
    DbusProxyService,
    DbusProxyService.of({
      startProxy: overrides.startProxy ?? (() => Effect.succeed(defaultHandle)),
    }),
  );
}
