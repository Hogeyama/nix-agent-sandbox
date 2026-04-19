/**
 * HostExecBrokerService — Effect-based abstraction over the HostExecBroker lifecycle.
 *
 * Encapsulates broker creation, start, registry write, and teardown.
 * Live implementation delegates to HostExecBroker from src/hostexec/broker.ts
 * and registry functions from src/hostexec/registry.ts.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import type { HostExecConfig } from "../../config/types.ts";
import { HostExecBroker } from "../../hostexec/broker.ts";
import type { ResolvedNotifyBackend } from "../../hostexec/notify.ts";
import type { HostExecRuntimePaths } from "../../hostexec/registry.ts";
import {
  removeHostExecPendingDir,
  removeHostExecSessionRegistry,
  writeHostExecSessionRegistry,
} from "../../hostexec/registry.ts";
import { logInfo, logWarn } from "../../log.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HostExecBrokerConfig {
  readonly paths: HostExecRuntimePaths;
  readonly sessionId: string;
  readonly socketPath: string;
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
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

export interface HostExecBrokerHandle {
  readonly close: () => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// HostExecBrokerService tag
// ---------------------------------------------------------------------------

export class HostExecBrokerService extends Context.Tag(
  "nas/HostExecBrokerService",
)<
  HostExecBrokerService,
  {
    readonly start: (
      config: HostExecBrokerConfig,
    ) => Effect.Effect<HostExecBrokerHandle>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const HostExecBrokerServiceLive: Layer.Layer<HostExecBrokerService> =
  Layer.succeed(
    HostExecBrokerService,
    HostExecBrokerService.of({
      start: (config) =>
        Effect.tryPromise({
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
            });
            await broker.start(config.socketPath);
            try {
              await writeHostExecSessionRegistry(config.paths, {
                version: 1,
                sessionId: config.sessionId,
                brokerSocket: config.socketPath,
                profileName: config.profileName,
                createdAt: new Date().toISOString(),
                pid: process.pid,
                agent: config.agent,
              });
            } catch (error) {
              try {
                await broker.close();
              } catch (closeErr) {
                logWarn(
                  `[nas] HostExecBrokerService: failed to close broker after registry write failure: ${closeErr}`,
                );
              }
              throw error;
            }

            const handle: HostExecBrokerHandle = {
              close: () =>
                Effect.tryPromise({
                  try: async () => {
                    await broker.close();
                    await removeHostExecSessionRegistry(
                      config.paths,
                      config.sessionId,
                    ).catch((e) =>
                      logInfo(
                        `[nas] HostExecBrokerService teardown: failed to remove session registry: ${e}`,
                      ),
                    );
                    await removeHostExecPendingDir(
                      config.paths,
                      config.sessionId,
                    ).catch((e) =>
                      logInfo(
                        `[nas] HostExecBrokerService teardown: failed to remove pending dir: ${e}`,
                      ),
                    );
                  },
                  catch: (e) =>
                    new Error(
                      `HostExecBrokerService close failed: ${e instanceof Error ? e.message : String(e)}`,
                    ),
                }).pipe(Effect.ignoreLogged),
            };
            return handle;
          },
          catch: (e) =>
            new Error(
              `HostExecBrokerService start failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
        }).pipe(Effect.orDie),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface HostExecBrokerServiceFakeConfig {
  readonly start?: (
    config: HostExecBrokerConfig,
  ) => Effect.Effect<HostExecBrokerHandle>;
}

export function makeHostExecBrokerServiceFake(
  overrides: HostExecBrokerServiceFakeConfig = {},
): Layer.Layer<HostExecBrokerService> {
  return Layer.succeed(
    HostExecBrokerService,
    HostExecBrokerService.of({
      start:
        overrides.start ?? (() => Effect.succeed({ close: () => Effect.void })),
    }),
  );
}
