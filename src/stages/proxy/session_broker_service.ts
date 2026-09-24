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
import { dockerKill } from "../../docker/client.ts";
import { containerNameForSession } from "../../docker/nas_resources.ts";
import type { ResolvedNotifyBackend } from "../../lib/notify_utils.ts";
import { logDebug, logInfo, logWarn } from "../../log.ts";
import {
  type AgentCredential,
  claudeAgentCredential,
  codexAgentCredential,
} from "../../network/agent_credential.ts";
import type { ResolvedDocument } from "../../network/authz/resolve.ts";
import { SessionBroker } from "../../network/broker.ts";
import {
  ClaudeOAuthCredentialSource,
  liveClaudeOAuthSourceDeps,
} from "../../network/claude_oauth_source.ts";
import {
  liveCodexAuthWatchDeps,
  watchCodexAuthFile,
} from "../../network/codex_auth_watch.ts";
import {
  CodexOAuthCredentialSource,
  liveCodexOAuthSourceDeps,
  resolveNasStateHome,
} from "../../network/codex_oauth_source.ts";
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

export interface AgentCredentialConfig {
  readonly kind: "claude-oauth" | "codex-oauth";
  readonly hostHome: string;
}

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
   * 1つでも取得できなければ start が失敗し、セッションを開始しない。
   */
  readonly agentCredentials?: readonly AgentCredentialConfig[];
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
  /**
   * credential を開く。ホストの credential が使えなくなったら（注入をやめた
   * うえで）`onRevoked` を呼ぶ。
   */
  readonly openAgentCredential: (
    config: AgentCredentialConfig,
    onRevoked: () => void,
  ) => Promise<AgentCredential>;
  readonly createBroker: (
    options: ConstructorParameters<typeof SessionBroker>[0],
  ) => SessionBrokerLifecycle;
  /**
   * container を猶予なしで止める。container が無いか、まだ動き出していなければ
   * 失敗する。
   */
  readonly killContainer: (containerName: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
}

/** credential の失効後に container を止められなかったとき、やり直すまでの間隔。 */
const KILL_RETRY_INTERVAL_MS = 250;

const liveStartDeps: SessionBrokerStartDeps = {
  openAgentCredential: openLiveAgentCredential,
  createBroker: (options) => new SessionBroker(options),
  killContainer: (containerName) => dockerKill(containerName),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    }),
};

async function openLiveAgentCredential(
  config: AgentCredentialConfig,
  onRevoked: () => void,
): Promise<AgentCredential> {
  switch (config.kind) {
    case "claude-oauth":
      return claudeAgentCredential(
        await ClaudeOAuthCredentialSource.open(
          liveClaudeOAuthSourceDeps(config.hostHome),
        ),
      );
    case "codex-oauth":
      return await openLiveCodexCredential(config.hostHome, onRevoked);
  }
}

/**
 * Codex の credential を開き、ホストの auth.json の監視を始める。
 *
 * container の auth.json はホストの auth.json の上に被せたダミーなので、
 * ホストのファイルが消えるか置き換わると外れ、以後にホストで書かれる本物が
 * container から見える。そうなったら注入をやめて `onRevoked` を呼ぶ。
 * セッションを止めるのは呼び出し側である。
 */
async function openLiveCodexCredential(
  hostHome: string,
  onRevoked: () => void,
): Promise<AgentCredential> {
  const source = await CodexOAuthCredentialSource.open(
    liveCodexOAuthSourceDeps(hostHome, resolveNasStateHome(hostHome)),
  );
  let stopWatching: () => void;
  try {
    stopWatching = await watchCodexAuthFile(
      liveCodexAuthWatchDeps(hostHome),
      () => {
        source.revoke();
        logWarn(
          `[nas] the host ~/.codex/auth.json was removed or replaced (for example by "codex logout"); stopping the session so the container cannot read the new file`,
        );
        onRevoked();
      },
    );
  } catch (error) {
    await source.close();
    throw error;
  }
  const credential = codexAgentCredential(source);
  return {
    ...credential,
    close: async () => {
      stopWatching();
      await credential.close();
    },
  };
}

export interface SessionBrokerStartHooks {
  /**
   * ホストの credential が使えなくなったときに呼ぶ。live の service は、
   * start を呼んだ fiber（パイプライン）を中断して、まだ起動していない
   * container を起動させない。
   */
  readonly onCredentialRevoked?: () => void;
}

/**
 * broker を起動し、レジストリに登録する。
 *
 * ホストの credential が使えなくなったら、`hooks.onCredentialRevoked` を呼び、
 * セッションの container を猶予なしで kill する。container がまだ無いか
 * 動き出す前なら、kill が通るか credential を閉じるまでやり直す。launch が
 * 既に `docker run` を始めていれば、container は失効の後に動き出しうる。
 * SIGTERM の猶予を与えると、container は外れたダミーの下の本物のファイルを
 * その間に読める。
 *
 * credential を開いたあとに失敗したら、既に開いたものを閉じてから失敗を
 * 返す。返した handle の close は、broker の停止が失敗しても credential を
 * 閉じ、レジストリと pending dir を削除する。credential の close は予約した
 * refresh を取り消し、host の credentials file へ書き戻せていない refresh 済み
 * の token を保存する。close を呼ばないと、セッションの終了後も refresh が
 * 実行されるか、host の file に失効した token が残る。
 *
 * @internal Exported for the colocated test file.
 */
export async function startSessionBroker(
  config: SessionBrokerConfig,
  deps: SessionBrokerStartDeps,
  hooks: SessionBrokerStartHooks = {},
): Promise<SessionBrokerHandle> {
  const agentCredentials: AgentCredential[] = [];
  let credentialsClosed = false;
  let killStarted = false;
  const killSessionContainer = async () => {
    const containerName = containerNameForSession(config.sessionId);
    let warned = false;
    while (!credentialsClosed) {
      try {
        await deps.killContainer(containerName);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!warned) {
          warned = true;
          logWarn(
            `[nas] could not kill the session container ${containerName} (it may not have started yet); retrying until the session ends: ${message}`,
          );
        } else {
          logDebug(
            `[nas] retrying to kill the session container ${containerName}: ${message}`,
          );
        }
      }
      await deps.sleep(KILL_RETRY_INTERVAL_MS);
    }
  };
  const onRevoked = () => {
    hooks.onCredentialRevoked?.();
    if (killStarted) return;
    killStarted = true;
    void killSessionContainer();
  };
  const closeCredentials = async () => {
    credentialsClosed = true;
    for (const credential of agentCredentials) {
      await credential
        .close()
        .catch((e) =>
          logInfo(
            `[nas] SessionBrokerService: failed to close an agent credential: ${e}`,
          ),
        );
    }
  };
  try {
    for (const credentialConfig of config.agentCredentials ?? []) {
      agentCredentials.push(
        await deps.openAgentCredential(credentialConfig, onRevoked),
      );
    }
  } catch (error) {
    await closeCredentials();
    throw error;
  }
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
      agentCredentials,
    });
    await broker.start(config.socketPath);
  } catch (error) {
    await closeCredentials();
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
    await closeCredentials();
    throw error;
  }

  return {
    close: () =>
      Effect.tryPromise({
        try: async () => {
          try {
            await broker.close();
          } finally {
            await closeCredentials();
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

/**
 * ホストの credential が使えなくなったら、start を呼んだ fiber を中断する。
 * パイプラインがまだ launch に届いていなければ、それ以降のステージは動かず、
 * `docker run` は始まらない。launch の最中なら、中断は `docker run` が
 * 終わるまで待たされ、その間に startSessionBroker が container を kill する。
 *
 * @internal Exported for the colocated test file.
 */
export function makeSessionBrokerServiceLayer(
  deps: SessionBrokerStartDeps,
): Layer.Layer<SessionBrokerService> {
  return Layer.succeed(
    SessionBrokerService,
    SessionBrokerService.of({
      start: (config) =>
        Effect.withFiberRuntime<SessionBrokerHandle>((fiber) =>
          Effect.tryPromise({
            try: () =>
              startSessionBroker(config, deps, {
                onCredentialRevoked: () =>
                  fiber.unsafeInterruptAsFork(fiber.id()),
              }),
            catch: (e) =>
              new Error(
                `SessionBrokerService start failed: ${e instanceof Error ? e.message : String(e)}`,
              ),
          }).pipe(Effect.orDie),
        ),
    }),
  );
}

export const SessionBrokerServiceLive: Layer.Layer<SessionBrokerService> =
  makeSessionBrokerServiceLayer(liveStartDeps);

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
