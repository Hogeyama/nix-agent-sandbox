/**
 * SessionBrokerService — Effect-based abstraction over the SessionBroker lifecycle.
 *
 * Encapsulates broker creation, start, registry write, and teardown.
 * Live implementation delegates to SessionBroker from src/network/broker.ts
 * and registry functions from src/network/registry.ts.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import type { RequestBodyAuditConfig } from "../../config/types.ts";
import type { ResolvedNotifyBackend } from "../../lib/notify_utils.ts";
import { logInfo, logWarn } from "../../log.ts";
import { claudeAgentCredential } from "../../network/agent_credential.ts";
import type { ResolvedDocument } from "../../network/authz/resolve.ts";
import { SessionBroker } from "../../network/broker.ts";
import {
  type AgentCredentialSource,
  ClaudeOAuthCredentialSource,
  liveClaudeOAuthSourceDeps,
} from "../../network/claude_oauth_source.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import {
  removePendingDir,
  removeSessionRegistry,
  writeSessionRegistry,
} from "../../network/registry.ts";
import type { SecretValues } from "../../network/secrets.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SessionBrokerConfig {
  readonly paths: NetworkRuntimePaths;
  readonly sessionId: string;
  readonly socketPath: string;
  readonly profileName: string;
  readonly agent?: string;
  readonly document: ResolvedDocument;
  readonly requestBodyAudit: RequestBodyAuditConfig;
  readonly pendingTimeoutSeconds: number;
  readonly pendingNotify: ResolvedNotifyBackend;
  readonly uiEnabled?: boolean;
  readonly uiPort?: number;
  readonly uiIdleTimeout?: number;
  readonly auditDir?: string;
  readonly tokenHash: string;
  readonly secretValues?: SecretValues;
  readonly proxyMasking?: boolean;
  /**
   * ホストが保持するエージェントの credential を broker に持たせる。
   * 取得できなければ start が失敗し、セッションを開始しない。
   */
  readonly agentCredential?: {
    readonly kind: "claude-oauth";
    readonly hostHome: string;
  };
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

/** broker の起動と停止のうち、このサービスが使う部分。 */
export interface SessionBrokerLifecycle {
  start(socketPath: string): Promise<void>;
  close(): Promise<void>;
}

export interface SessionBrokerStartDeps {
  readonly openAgentCredential: (
    hostHome: string,
  ) => Promise<AgentCredentialSource>;
  readonly createBroker: (
    options: ConstructorParameters<typeof SessionBroker>[0],
  ) => SessionBrokerLifecycle;
}

const liveStartDeps: SessionBrokerStartDeps = {
  openAgentCredential: (hostHome) =>
    ClaudeOAuthCredentialSource.open(liveClaudeOAuthSourceDeps(hostHome)),
  createBroker: (options) => new SessionBroker(options),
};

/**
 * broker を起動し、レジストリに登録する。
 *
 * credential source を開いたあとに失敗したら、source を閉じてから失敗を
 * 返す。返した handle の close は、broker の停止が失敗しても source を閉じ、
 * レジストリと pending dir を削除する。source の close は予約した refresh を
 * 取り消し、host の credentials file へ書き戻せていない refresh 済みの token を
 * 保存する。close を呼ばないと、セッションの終了後も refresh が実行されるか、
 * host の file に失効した token が残る。
 *
 * @internal Exported for the colocated test file.
 */
export async function startSessionBroker(
  config: SessionBrokerConfig,
  deps: SessionBrokerStartDeps,
): Promise<SessionBrokerHandle> {
  const agentCredential: AgentCredentialSource | undefined =
    config.agentCredential
      ? await deps.openAgentCredential(config.agentCredential.hostHome)
      : undefined;
  let broker: SessionBrokerLifecycle;
  try {
    broker = deps.createBroker({
      paths: config.paths,
      sessionId: config.sessionId,
      document: config.document,
      pendingTimeoutSeconds: config.pendingTimeoutSeconds,
      pendingNotify: config.pendingNotify,
      uiEnabled: config.uiEnabled,
      uiPort: config.uiPort,
      uiIdleTimeout: config.uiIdleTimeout,
      auditDir: config.auditDir,
      secretValues: config.secretValues,
      proxyMasking: config.proxyMasking,
      requestBodyAudit: config.requestBodyAudit,
      agentCredentials: agentCredential
        ? [claudeAgentCredential(agentCredential)]
        : undefined,
    });
    await broker.start(config.socketPath);
  } catch (error) {
    await agentCredential?.close();
    throw error;
  }
  try {
    await writeSessionRegistry(config.paths, {
      version: 1,
      sessionId: config.sessionId,
      tokenHash: config.tokenHash,
      brokerSocket: config.socketPath,
      profileName: config.profileName,
      requestBodyAudit: config.requestBodyAudit,
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
    await agentCredential?.close();
    throw error;
  }

  return {
    close: () =>
      Effect.tryPromise({
        try: async () => {
          try {
            await broker.close();
          } finally {
            await agentCredential
              ?.close()
              .catch((e) =>
                logInfo(
                  `[nas] SessionBrokerService teardown: failed to close the agent credential source: ${e}`,
                ),
              );
            await removeSessionRegistry(config.paths, config.sessionId).catch(
              (e) =>
                logInfo(
                  `[nas] SessionBrokerService teardown: failed to remove session registry: ${e}`,
                ),
            );
            await removePendingDir(config.paths, config.sessionId).catch((e) =>
              logInfo(
                `[nas] SessionBrokerService teardown: failed to remove pending dir: ${e}`,
              ),
            );
          }
        },
        catch: (e) =>
          new Error(
            `SessionBrokerService close failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.ignoreLogged),
  };
}

export const SessionBrokerServiceLive: Layer.Layer<SessionBrokerService> =
  Layer.succeed(
    SessionBrokerService,
    SessionBrokerService.of({
      start: (config) =>
        Effect.tryPromise({
          try: () => startSessionBroker(config, liveStartDeps),
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
