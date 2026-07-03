/**
 * SessionBrokerService — Effect-based abstraction over the SessionBroker lifecycle.
 *
 * Encapsulates broker creation, start, registry write, and teardown.
 * Live implementation delegates to SessionBroker from src/network/broker.ts
 * and registry functions from src/network/registry.ts.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import type { ReviewRule } from "../../config/types.ts";
import type { ResolvedNotifyBackend } from "../../lib/notify_utils.ts";
import { logInfo, logWarn } from "../../log.ts";
import { SessionBroker } from "../../network/broker.ts";
import type {
  ApprovalScope,
  ResolvedCredential,
} from "../../network/protocol.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import {
  removePendingDir,
  removeSessionRegistry,
  writeSessionRegistry,
} from "../../network/registry.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SessionBrokerConfig {
  readonly paths: NetworkRuntimePaths;
  readonly sessionId: string;
  readonly socketPath: string;
  readonly profileName: string;
  readonly agent?: string;
  readonly reviewRules: ReviewRule[];
  readonly pendingTimeoutSeconds: number;
  readonly pendingDefaultScope: ApprovalScope;
  readonly pendingNotify: ResolvedNotifyBackend;
  readonly uiEnabled?: boolean;
  readonly uiPort?: number;
  readonly uiIdleTimeout?: number;
  readonly auditDir?: string;
  readonly tokenHash: string;
  readonly resolvedCredentials?: ResolvedCredential[];
  readonly maskValues?: string[];
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

export interface SessionBrokerHandle {
  readonly close: () => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// SessionBrokerService tag
// ---------------------------------------------------------------------------

export class SessionBrokerService extends Context.Tag(
  "nas/SessionBrokerService",
)<
  SessionBrokerService,
  {
    readonly start: (
      config: SessionBrokerConfig,
    ) => Effect.Effect<SessionBrokerHandle>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const SessionBrokerServiceLive: Layer.Layer<SessionBrokerService> =
  Layer.succeed(
    SessionBrokerService,
    SessionBrokerService.of({
      start: (config) =>
        Effect.tryPromise({
          try: async () => {
            const broker = new SessionBroker({
              paths: config.paths,
              sessionId: config.sessionId,
              reviewRules: config.reviewRules,
              pendingTimeoutSeconds: config.pendingTimeoutSeconds,
              pendingDefaultScope: config.pendingDefaultScope,
              pendingNotify: config.pendingNotify,
              uiEnabled: config.uiEnabled,
              uiPort: config.uiPort,
              uiIdleTimeout: config.uiIdleTimeout,
              auditDir: config.auditDir,
              resolvedCredentials: config.resolvedCredentials,
              maskValues: config.maskValues,
            });
            await broker.start(config.socketPath);
            try {
              await writeSessionRegistry(config.paths, {
                version: 1,
                sessionId: config.sessionId,
                tokenHash: config.tokenHash,
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
                  `[nas] SessionBrokerService: failed to close broker after registry write failure: ${closeErr}`,
                );
              }
              throw error;
            }

            const handle: SessionBrokerHandle = {
              close: () =>
                Effect.tryPromise({
                  try: async () => {
                    await broker.close();
                    await removeSessionRegistry(
                      config.paths,
                      config.sessionId,
                    ).catch((e) =>
                      logInfo(
                        `[nas] SessionBrokerService teardown: failed to remove session registry: ${e}`,
                      ),
                    );
                    await removePendingDir(
                      config.paths,
                      config.sessionId,
                    ).catch((e) =>
                      logInfo(
                        `[nas] SessionBrokerService teardown: failed to remove pending dir: ${e}`,
                      ),
                    );
                  },
                  catch: (e) =>
                    new Error(
                      `SessionBrokerService close failed: ${e instanceof Error ? e.message : String(e)}`,
                    ),
                }).pipe(Effect.ignoreLogged),
            };
            return handle;
          },
          catch: (e) =>
            new Error(
              `SessionBrokerService start failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
        }).pipe(Effect.orDie),
    }),
  );

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface SessionBrokerServiceFakeConfig {
  readonly start?: (
    config: SessionBrokerConfig,
  ) => Effect.Effect<SessionBrokerHandle>;
}

export function makeSessionBrokerServiceFake(
  overrides: SessionBrokerServiceFakeConfig = {},
): Layer.Layer<SessionBrokerService> {
  return Layer.succeed(
    SessionBrokerService,
    SessionBrokerService.of({
      start:
        overrides.start ?? (() => Effect.succeed({ close: () => Effect.void })),
    }),
  );
}
