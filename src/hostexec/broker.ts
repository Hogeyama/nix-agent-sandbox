import { mkdir, realpath, rm, rmdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendAuditLog } from "../audit/store.ts";
import type { AuditLogEntry } from "../audit/types.ts";
import type {
  HostExecConfig,
  HostExecPromptScope,
  HostExecRule,
} from "../config/types.ts";
import { DEFAULT_HOSTEXEC_CONFIG } from "../config/types.ts";
import { expandTilde } from "../lib/fs_utils.ts";
import {
  connectUnix,
  createUnixServer,
  readJsonLine,
  type Server,
  type Socket,
  writeJsonLine,
} from "../lib/unix_socket.ts";
import { logInfo, logWarn } from "../log.ts";
import {
  BufferedGatewayLineReader,
  type GatewayLineReader,
  type GatewayReadMonitorEvent,
  RawLineReader,
  runGatewayExecution,
} from "./gateway_execution.ts";
import {
  type BrokerToGatewayMessage,
  parseBrokerToGatewayLine,
  parseGatewayToBrokerLine,
} from "./gateway_protocol.ts";
import {
  decideIntegrity,
  type IntegritySnapshot,
  type IntegrityVerdict,
  readFileIntegrity,
} from "./integrity.ts";
import type { MatchContext } from "./match.ts";
import { isRelativeHostExecArgv0, matchRule } from "./match.ts";
import {
  closeNotification,
  notifyHostExecPendingRequest,
  type ResolvedNotifyBackend,
} from "./notify.ts";
import {
  HostExecProcessDiagnostics,
  readProcessIdentity,
} from "./process_diagnostics.ts";
import {
  type HostExecRuntimePaths,
  hostExecBrokerSocketPath,
  listHostExecPendingEntries,
  removeHostExecPendingDir,
  removeHostExecPendingEntry,
  removeHostExecSessionRegistry,
  writeHostExecPendingEntry,
} from "./registry.ts";
import { SecretStore } from "./secret_store.ts";
import type {
  ExecuteRequest,
  HostExecControlRequest,
  HostExecControlResponse,
  HostExecErrorResponse,
  HostExecPendingEntry,
  ResolvedExecution,
  ResolvedExecutionCapability,
} from "./types.ts";

/**
 * Shared shape describing the host-side nas-mask-filter binary and the
 * secrets frame file it reads to redact stdout/stderr. Used wherever a
 * mask-filter configuration is threaded through hostexec (broker options,
 * broker service config, and the stage that resolves the binary path).
 */
export interface MaskFilterConfig {
  readonly binaryPath: string;
  readonly secretsFramePath: string;
}

interface HostExecBrokerOptions {
  paths: HostExecRuntimePaths;
  sessionId: string;
  profileName: string;
  workspaceRoot: string;
  sessionTmpDir: string;
  hostexec?: HostExecConfig;
  notify: ResolvedNotifyBackend;
  uiEnabled?: boolean;
  uiPort?: number;
  uiIdleTimeout?: number;
  /** Directory for audit JSONL logs. If set, decisions are recorded. */
  auditDir?: string;
  /** If set, stdout/stderr of host commands are piped through nas-mask-filter. */
  maskFilter?: MaskFilterConfig;
  /**
   * LD_PRELOAD 型 argv0 が指すホスト絶対パス集合。ブローカー起動時に各ファイルの
   * integrity を snapshot し、execute ごとに再検証する。
   */
  integrityTargets?: readonly string[];
}

interface PendingWaiter {
  /** Internal gateway socket retained while approval is pending. */
  socket: Socket;
  reader: GatewayLineReader;
  lifecycle: GatewayRequestLifecycle;
  resolve: () => void;
  reject: (error: unknown) => void;
}

type GatewayLifecycleState =
  | "preflight"
  | "awaiting_approval"
  | "running"
  | "terminal"
  | "cancelled";

/**
 * Owns the gateway connection while policy and approval are asynchronous.
 * The socket/read monitor is installed before policy, registry, or
 * notification work begins so a peer cannot disappear leaving an orphaned
 * pending request behind.
 */
class GatewayRequestLifecycle {
  private state: GatewayLifecycleState = "preflight";
  private cancelledError: Error | null = null;
  private readonly cancellation = new AbortController();
  private deferredMonitorEvent: GatewayReadMonitorEvent | null = null;
  private cleanup: (() => Promise<void>) | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private cleanupRequested = false;

  private readonly onClose = (): void => {
    this.cancel(new Error("gateway disconnected"));
  };
  private readonly onError = (error: Error): void => {
    this.cancel(new Error(`gateway transport error: ${error.message}`));
  };

  constructor(
    private readonly socket: Socket,
    private readonly reader: GatewayLineReader,
  ) {
    socket.once("close", this.onClose);
    socket.once("error", this.onError);
  }

  get isCancelled(): boolean {
    return this.cancelledError !== null;
  }

  get currentState(): GatewayLifecycleState {
    return this.state;
  }

  get cancellationSignal(): AbortSignal {
    return this.cancellation.signal;
  }

  setCleanup(cleanup: () => Promise<void>): void {
    this.cleanup = cleanup;
    if (this.cleanupRequested) this.startCleanup();
  }

  markAwaitingApproval(): GatewayReadMonitorEvent | null {
    if (!this.isCancelled && this.state === "preflight") {
      this.state = "awaiting_approval";
    }
    const event = this.deferredMonitorEvent;
    this.deferredMonitorEvent = null;
    return event;
  }

  deferMonitorEvent(event: GatewayReadMonitorEvent): void {
    if (this.state === "preflight" && !this.isCancelled) {
      this.deferredMonitorEvent = event;
    }
  }

  markRunning(): void {
    if (!this.isCancelled) this.state = "running";
  }

  markTerminal(): void {
    if (!this.isCancelled) this.state = "terminal";
  }

  cancel(error: Error): void {
    if (this.isCancelled || this.state === "terminal") return;
    this.cancelledError = error;
    this.state = "cancelled";
    this.cleanupRequested = true;
    this.cancellation.abort(error);
    this.detachSocketListeners();
    this.reader.abort(error);
    this.socket.destroy();
    this.startCleanup();
  }

  async waitForCleanup(): Promise<void> {
    await this.cleanupPromise;
  }

  finish(): void {
    this.detachSocketListeners();
  }

  private startCleanup(): void {
    if (!this.cleanup || this.cleanupPromise) return;
    this.cleanupPromise = Promise.resolve()
      .then(() => this.cleanup?.())
      .catch((error) => {
        logWarn(
          `[nas] HostExecBroker: pending request cleanup failed: ${error}`,
        );
      });
  }

  private detachSocketListeners(): void {
    this.socket.off("close", this.onClose);
    this.socket.off("error", this.onError);
  }
}

interface PendingGroup {
  approvalKey: string;
  createdAt: string;
  ruleId: string;
  requestIds: Set<string>;
  waiters: Map<string, PendingWaiter>;
  pendingEntries: Map<string, HostExecPendingEntry>;
  requests: Map<
    string,
    { request: ExecuteRequest; resolved: ResolvedExecution }
  >;
  timer: ReturnType<typeof setTimeout>;
  notificationAbort: AbortController;
  /**
   * Scopes the client may pick when approving this pending group. An
   * approve request carrying a scope outside this set is rejected,
   * defending against a caller that reads /api/hostexec/pending and
   * then POSTs a broader scope than was advertised.
   */
  allowedScopes: ReadonlySet<HostExecPromptScope>;
}

/**
 * Scopes a client may pick when approving a hostexec request. Matches
 * what the UI exposes today.
 */
const ALLOWED_HOSTEXEC_SCOPES: ReadonlySet<HostExecPromptScope> = new Set([
  "once",
  "capability",
]);

const MINIMAL_ENV_KEYS = ["HOME", "PATH", "LANG", "TERM", "USER", "LOGNAME"];
const DEFAULT_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export class HostExecBroker {
  private readonly paths: HostExecRuntimePaths;
  private readonly sessionId: string;
  private readonly profileName: string;
  private readonly workspaceRoot: string;
  private readonly sessionTmpDir: string;
  private readonly config: HostExecConfig;
  private readonly notify: ResolvedNotifyBackend;
  private readonly uiEnabled?: boolean;
  private readonly uiPort?: number;
  private readonly uiIdleTimeout?: number;
  private readonly auditDir?: string;
  private readonly secretStore: SecretStore;
  private internalSocketPath: string | null = null;
  private controlSocketPath: string | null = null;
  private internalServer: Server | null = null;
  private controlServer: Server | null = null;
  private readonly approvedKeys = new Set<string>();
  private readonly activeRequestIds = new Set<string>();
  private readonly groups = new Map<string, PendingGroup>();
  private readonly requestToApprovalKey = new Map<string, string>();
  private readonly notificationTasks = new Set<Promise<void>>();
  private readonly maskFilter?: MaskFilterConfig;
  private readonly integrityTargets: readonly string[];
  private readonly integrityBaseline = new Map<string, IntegritySnapshot>();
  private readonly diagnostics: HostExecProcessDiagnostics;

  constructor(options: HostExecBrokerOptions) {
    this.paths = options.paths;
    this.sessionId = options.sessionId;
    this.profileName = options.profileName;
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.sessionTmpDir = path.resolve(options.sessionTmpDir);
    this.config = options.hostexec ?? structuredClone(DEFAULT_HOSTEXEC_CONFIG);
    this.notify = options.notify;
    this.uiEnabled = options.uiEnabled;
    this.uiPort = options.uiPort;
    this.uiIdleTimeout = options.uiIdleTimeout;
    this.auditDir = options.auditDir;
    this.secretStore = new SecretStore(this.config.secrets);
    this.maskFilter = options.maskFilter;
    this.integrityTargets = options.integrityTargets ?? [];
    this.diagnostics = new HostExecProcessDiagnostics(
      options.paths.runtimeDir,
      options.sessionId,
    );
  }

  async start(
    internalSocketPath: string,
    controlSocketPath: string,
  ): Promise<void> {
    await this.diagnostics.record("broker_started");
    this.internalSocketPath = internalSocketPath;
    this.controlSocketPath = controlSocketPath;
    // Both sockets listened to by this process are host-only. The gateway,
    // which is the only process that may be mounted into the container,
    // owns the external exec socket and is deliberately absent here.
    await mkdir(path.dirname(controlSocketPath), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(path.dirname(internalSocketPath), {
      recursive: true,
      mode: 0o700,
    });
    await rm(controlSocketPath, { force: true });
    await rm(internalSocketPath, { force: true });
    this.controlServer = await createUnixServer(
      controlSocketPath,
      (socket) => void this.handleConnection(socket, "control"),
    );
    this.internalServer = await createUnixServer(
      internalSocketPath,
      (socket) => void this.handleConnection(socket, "internal"),
    );
    // ブローカー起動時点（コンテナ起動より前）に対象ファイルの baseline を取る。
    // この時点でコンテナプロセスは存在せず、差し替えは不可能。baseline のキーは
    // execute 時の lookup（integrityVerdict）と同じ canonicalizeIntegrityPath を
    // 通すことで、ワークスペースパスに symlink が含まれていてもキーが一致する
    // ようにする。
    for (const target of this.integrityTargets) {
      const canonicalTarget = await canonicalizeIntegrityPath(target);
      try {
        this.integrityBaseline.set(
          canonicalTarget,
          await readFileIntegrity(canonicalTarget),
        );
      } catch (e) {
        // EACCES（root 所有ファイルなど）や ENOTDIR 等、stat/read が失敗する
        // ケースでブローカー起動全体を落とさない。baseline に登録しないことで
        // execute 時の lookup が undefined を返し、decideIntegrity(undefined, …)
        // が prompt に倒す（fail-safe）。エラーは黙殺せず警告として記録する。
        logWarn(
          `[nas] HostExecBroker: failed to snapshot integrity target ${canonicalTarget}: ${e}`,
        );
      }
    }
  }

  async close(): Promise<void> {
    await this.diagnostics.record("broker_closing");
    if (this.internalServer) {
      this.internalServer.close();
      this.internalServer = null;
    }
    if (this.controlServer) {
      this.controlServer.close();
      this.controlServer = null;
    }
    for (const group of this.groups.values()) {
      clearTimeout(group.timer);
      group.notificationAbort.abort();
      for (const [requestId, waiter] of group.waiters.entries()) {
        try {
          await writeGatewayError(
            waiter.socket,
            requestId,
            "hostexec broker closed",
            "awaiting_decision",
          );
        } catch {
          // Client socket may already be gone; nothing to notify.
        }
        waiter.lifecycle.finish();
        waiter.resolve();
      }
    }
    await Promise.allSettled(this.notificationTasks);
    this.groups.clear();
    this.requestToApprovalKey.clear();
    this.activeRequestIds.clear();
    await removeHostExecPendingDir(this.paths, this.sessionId);
    await removeHostExecSessionRegistry(this.paths, this.sessionId);
    if (this.maskFilter) {
      await rm(this.maskFilter.secretsFramePath, { force: true }).catch((e) => {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          logInfo(
            `[nas] HostExecBroker: failed to remove mask secrets frame: ${e}`,
          );
        }
      });
    }
    const controlTarget =
      this.controlSocketPath ??
      hostExecBrokerSocketPath(this.paths, this.sessionId);
    // The external socket is owned by nas-hostexec-gateway. Only remove the
    // host-only internal endpoint created by this broker.
    if (this.internalSocketPath) {
      await rm(this.internalSocketPath, { force: true }).catch((e) => {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          logInfo(
            `[nas] HostExecBroker: failed to remove internal socket: ${e}`,
          );
        }
      });
      await rmdir(path.dirname(this.internalSocketPath)).catch((e) => {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") {
          logInfo(
            `[nas] HostExecBroker: failed to remove internal socket dir: ${e}`,
          );
        }
      });
    }
    await rm(controlTarget, { force: true }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        logInfo(`[nas] HostExecBroker: failed to remove control socket: ${e}`);
      }
    });
    await rmdir(path.dirname(controlTarget)).catch((e) => {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") {
        logInfo(
          `[nas] HostExecBroker: failed to remove session broker dir: ${e}`,
        );
      }
    });
    await this.diagnostics.record("broker_closed");
  }

  async listPending(): Promise<HostExecPendingEntry[]> {
    return await listHostExecPendingEntries(this.paths, this.sessionId);
  }

  private async handleConnection(
    socket: Socket,
    channel: "internal" | "control",
  ): Promise<void> {
    try {
      if (channel === "internal") {
        try {
          await this.handleGatewayConnection(socket);
        } catch {
          // Invalid internal frames are fail-closed. The gateway owns the
          // external terminal response, so there is no safe request ID to
          // echo when the first frame itself is malformed.
        }
        return;
      }
      const line = await readJsonLine(socket);
      if (!line) return;
      const message = JSON.parse(line) as
        | HostExecControlRequest
        | ExecuteRequest;
      const response = await this.handleControlMessage(message).catch((error) =>
        toErrorResponse(message, (error as Error).message),
      );
      try {
        await writeJsonLine(socket, response);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EPIPE" || code === "ECONNRESET") return;
        throw e;
      }
    } finally {
      socket.destroy();
    }
  }

  private async handleGatewayConnection(socket: Socket): Promise<void> {
    const reader = new BufferedGatewayLineReader(new RawLineReader(socket));
    let requestId: string | undefined;
    let activeRequestReserved = false;
    let lifecycle: GatewayRequestLifecycle | undefined;
    try {
      const line = await reader.read();
      if (line === null) return;
      let message: ReturnType<typeof parseGatewayToBrokerLine>;
      try {
        // Keep the original wire framing visible to the gateway protocol
        // parser so oversized or malformed internal requests fail closed.
        message = parseGatewayToBrokerLine(line, "awaiting_decision");
      } catch (error) {
        throw new Error(
          `invalid gateway execute request: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (message.type !== "execute") {
        throw new Error("internal gateway connection must begin with execute");
      }
      requestId = message.request.requestId;
      if (this.activeRequestIds.has(requestId)) {
        try {
          await writeGatewayError(
            socket,
            requestId,
            "duplicate active request ID",
            "awaiting_decision",
          );
        } catch {
          // The duplicate peer may disconnect while receiving the terminal
          // error; the original request remains the sole active owner.
        }
        return;
      }
      this.activeRequestIds.add(requestId);
      activeRequestReserved = true;
      const requestLifecycle = new GatewayRequestLifecycle(socket, reader);
      lifecycle = requestLifecycle;
      reader.startMonitor((event) => {
        this.handleGatewayLifecycleEvent(
          requestLifecycle,
          message.request.requestId,
          event,
        );
      });
      requestLifecycle.setCleanup(() =>
        this.removePendingRequest(message.request.requestId),
      );
      await this.executeStreaming(
        message.request,
        socket,
        reader,
        requestLifecycle,
      );
    } catch (error) {
      if (!requestId || lifecycle?.isCancelled) return;
      try {
        await writeGatewayError(
          socket,
          requestId,
          error instanceof Error ? error.message : String(error),
          "awaiting_result",
        );
      } catch (writeError) {
        const code = (writeError as NodeJS.ErrnoException).code;
        if (code !== "EPIPE" && code !== "ECONNRESET") throw writeError;
      }
    } finally {
      lifecycle?.finish();
      reader.close();
      if (activeRequestReserved && requestId !== undefined) {
        this.activeRequestIds.delete(requestId);
      }
    }
  }

  private handleGatewayLifecycleEvent(
    lifecycle: GatewayRequestLifecycle,
    requestId: string,
    event: GatewayReadMonitorEvent,
  ): void {
    if (lifecycle.currentState === "preflight") {
      lifecycle.deferMonitorEvent(event);
      return;
    }
    // Once execution starts, the same buffered line belongs to
    // runGatewayExecution. The monitor only owns the pre-approval window.
    if (
      lifecycle.currentState === "running" ||
      lifecycle.currentState === "terminal" ||
      lifecycle.isCancelled
    ) {
      return;
    }
    if (event.error) {
      lifecycle.cancel(event.error);
      return;
    }
    if (event.line === undefined || event.line === null) {
      lifecycle.cancel(new Error("gateway disconnected before approval"));
      return;
    }
    try {
      const message = parseGatewayToBrokerLine(event.line, "awaiting_decision");
      const messageRequestId =
        message.type === "execute"
          ? message.request.requestId
          : message.requestId;
      if (messageRequestId !== requestId) {
        throw new Error(
          `gateway request ID mismatch: expected ${requestId}, got ${messageRequestId}`,
        );
      }
      if (message.type === "cancelled") {
        lifecycle.cancel(
          new Error(`gateway cancelled request: ${message.reason}`),
        );
        return;
      }
      if (message.type === "transport_error") {
        lifecycle.cancel(
          new Error(`gateway transport error: ${message.message}`),
        );
        return;
      }
      throw new Error(
        `gateway message ${message.type} is not accepted before approval`,
      );
    } catch (error) {
      lifecycle.cancel(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private async handleControlMessage(
    message: HostExecControlRequest | ExecuteRequest,
  ): Promise<HostExecControlResponse> {
    if (message.type === "list_pending") {
      return { type: "pending", items: await this.listPending() };
    }
    if (message.type === "approve") {
      return await this.approve(message.requestId, message.scope);
    }
    if (message.type === "deny") {
      return await this.deny(message.requestId);
    }
    return {
      type: "error",
      requestId: message.requestId,
      message: "execute is not accepted on the control channel",
    };
  }

  /**
   * Resolves an execute request and streams its responses directly to the
   * internal gateway socket. The gateway owns the host command; this broker
   * only sends an approved execution spec and receives masked output.
   *
   * The pending-approval flow keeps the socket open: when approval is
   * required, the request waits in `group.waiters` (with the internal socket
   * attached) until `resolveGroup` sends `start` (or writes a denial)
   * directly to that socket.
   */
  private async executeStreaming(
    message: ExecuteRequest,
    socket: Socket,
    reader: GatewayLineReader,
    lifecycle: GatewayRequestLifecycle,
  ): Promise<void> {
    const wasCancelled = async (): Promise<boolean> => {
      if (!lifecycle.isCancelled) return false;
      await lifecycle.waitForCleanup();
      return true;
    };

    const resolved = await this.resolveRequest(message);
    if (await wasCancelled()) return;
    if (!resolved) {
      await writeGatewayMessage(
        socket,
        { type: "fallback", requestId: message.requestId },
        "awaiting_decision",
      );
      lifecycle.markTerminal();
      return;
    }
    const commandStr = [message.argv0, ...message.args].join(" ");
    if (resolved.rule.approval === "deny") {
      if (await wasCancelled()) return;
      await this.recordAudit(
        message.requestId,
        "deny",
        "policy-deny",
        commandStr,
      );
      if (await wasCancelled()) return;
      await writeGatewayMessage(
        socket,
        {
          type: "error",
          requestId: message.requestId,
          message: "permission denied by hostexec policy",
        },
        "awaiting_decision",
      );
      lifecycle.markTerminal();
      return;
    }

    const approvalKey = await buildApprovalKey(resolved.capability);
    if (await wasCancelled()) return;
    let integrity: IntegrityVerdict;
    try {
      integrity = await this.integrityVerdict(message, resolved);
    } catch (e) {
      // stat/read が ENOENT 以外で失敗するケース（実行時に EACCES/ENOTDIR に
      // なった対象など）を想定する。deny 系の他の分岐と同様に監査ログへ記録
      // してからエラー応答を返す。記録せずに throw を伝播させると、この経路
      // だけ audit 証跡が欠落する。
      if (await wasCancelled()) return;
      await this.recordAudit(
        message.requestId,
        "deny",
        "integrity-check-error",
        commandStr,
      );
      if (await wasCancelled()) return;
      await writeGatewayMessage(
        socket,
        {
          type: "error",
          requestId: message.requestId,
          message: `hostexec integrity check failed: ${e}`,
        },
        "awaiting_decision",
      );
      lifecycle.markTerminal();
      return;
    }

    // 対象ファイルが起動時 baseline から変化していれば、allow ルールでも承認
    // キャッシュでも即実行させない。prompt 無効時は承認手段が無いので deny。
    if (integrity === "prompt" && !this.config.prompt.enable) {
      if (await wasCancelled()) return;
      await this.recordAudit(
        message.requestId,
        "deny",
        "integrity-mismatch",
        commandStr,
      );
      if (await wasCancelled()) return;
      await writeGatewayMessage(
        socket,
        {
          type: "error",
          requestId: message.requestId,
          message:
            "hostexec target changed since session start; approval required but prompt is disabled",
        },
        "awaiting_decision",
      );
      lifecycle.markTerminal();
      return;
    }

    if (
      integrity === "pass" &&
      (resolved.rule.approval === "allow" ||
        this.approvedKeys.has(approvalKey) ||
        !this.config.prompt.enable)
    ) {
      if (resolved.rule.approval === "prompt" && !this.config.prompt.enable) {
        if (await wasCancelled()) return;
        await this.recordAudit(
          message.requestId,
          "deny",
          "prompt-disabled",
          commandStr,
        );
        if (await wasCancelled()) return;
        await writeGatewayMessage(
          socket,
          {
            type: "error",
            requestId: message.requestId,
            message: "hostexec prompt is disabled",
          },
          "awaiting_decision",
        );
        lifecycle.markTerminal();
        return;
      }
      const reason =
        resolved.rule.approval === "allow" ? "rule-allow" : "approved-cached";
      if (await wasCancelled()) return;
      await this.recordAudit(message.requestId, "allow", reason, commandStr);
      if (await wasCancelled()) return;
      lifecycle.markRunning();
      await this.runGatewayResolved(
        message,
        resolved,
        socket,
        reader,
        lifecycle.cancellationSignal,
      );
      lifecycle.markTerminal();
      return;
    }

    const deferredMonitorEvent = lifecycle.markAwaitingApproval();
    if (deferredMonitorEvent) {
      this.handleGatewayLifecycleEvent(
        lifecycle,
        message.requestId,
        deferredMonitorEvent,
      );
    }
    if (await wasCancelled()) return;
    const deferred = Promise.withResolvers<void>();
    const waiter: PendingWaiter = {
      socket,
      reader,
      lifecycle,
      resolve: deferred.resolve,
      reject: deferred.reject,
    };
    let group = this.groups.get(approvalKey);
    if (!group) {
      group = await this.createPendingGroup(
        approvalKey,
        message,
        resolved,
        integrity === "prompt",
        waiter,
      );
      if (await wasCancelled()) {
        await this.removePendingRequest(message.requestId);
        return;
      }
    } else {
      if (group.requests.has(message.requestId)) {
        throw new Error(`duplicate pending request ID: ${message.requestId}`);
      }
      group.requestIds.add(message.requestId);
      group.requests.set(message.requestId, { request: message, resolved });
      this.requestToApprovalKey.set(message.requestId, approvalKey);
      const entry = toPendingEntry(
        message,
        resolved,
        approvalKey,
        group.createdAt,
        integrity === "prompt",
      );
      group.pendingEntries.set(message.requestId, entry);
      group.waiters.set(message.requestId, waiter);
      await writeHostExecPendingEntry(this.paths, entry);
    }
    if (await wasCancelled()) {
      await this.removePendingRequest(message.requestId);
      return;
    }
    await deferred.promise;
  }

  private async createPendingGroup(
    approvalKey: string,
    message: ExecuteRequest,
    resolved: ResolvedExecution,
    integrityChanged: boolean,
    waiter: PendingWaiter,
  ): Promise<PendingGroup> {
    const createdAt = new Date().toISOString();
    const notificationAbort = new AbortController();
    const timer = setTimeout(() => {
      void this.resolveGroup(approvalKey, "deny", {
        type: "error",
        requestId: message.requestId,
        message: "pending approval timed out",
      });
    }, this.config.prompt.timeoutSeconds * 1000);
    const group: PendingGroup = {
      approvalKey,
      createdAt,
      ruleId: resolved.rule.id,
      requestIds: new Set([message.requestId]),
      waiters: new Map(),
      pendingEntries: new Map(),
      requests: new Map([[message.requestId, { request: message, resolved }]]),
      timer,
      notificationAbort,
      allowedScopes: ALLOWED_HOSTEXEC_SCOPES,
    };
    this.groups.set(approvalKey, group);
    this.requestToApprovalKey.set(message.requestId, approvalKey);
    // Publish the waiter before the registry write can yield. A control
    // approval racing that write must either resolve this waiter or observe
    // a lifecycle cancellation, never approve an entry with no waiter.
    group.waiters.set(message.requestId, waiter);
    const entry = toPendingEntry(
      message,
      resolved,
      approvalKey,
      createdAt,
      integrityChanged,
    );
    group.pendingEntries.set(message.requestId, entry);
    await writeHostExecPendingEntry(this.paths, entry);
    const notificationTask = notifyHostExecPendingRequest({
      backend: this.notify,
      pending: entry,
      uiEnabled: this.uiEnabled,
      uiPort: this.uiPort,
      uiIdleTimeout: this.uiIdleTimeout,
      signal: notificationAbort.signal,
    }).catch((e) =>
      logInfo(`[nas] HostExecBroker: failed to send notification: ${e}`),
    );
    this.notificationTasks.add(notificationTask);
    void notificationTask.finally(() => {
      this.notificationTasks.delete(notificationTask);
    });
    return group;
  }

  private async approve(
    requestId: string,
    scope?: HostExecPromptScope,
  ): Promise<HostExecControlResponse> {
    const group = this.findGroupByRequestId(requestId);
    if (!group) {
      return {
        type: "error",
        requestId,
        message: `Pending request not found: ${requestId}`,
      };
    }
    if (scope !== undefined && !group.allowedScopes.has(scope)) {
      return {
        type: "error",
        requestId,
        message: `scope not allowed for this request: ${scope}`,
      };
    }
    const selectedScope = scope ?? this.config.prompt.defaultScope;
    if (selectedScope === "capability") {
      this.approvedKeys.add(group.approvalKey);
      await this.resolveGroup(group.approvalKey, "approve");
    } else {
      await this.resolvePendingRequest(requestId, "approve");
    }
    return { type: "ack", requestId, decision: "approve" };
  }

  private async deny(requestId: string): Promise<HostExecControlResponse> {
    const group = this.findGroupByRequestId(requestId);
    if (!group) {
      return {
        type: "error",
        requestId,
        message: `Pending request not found: ${requestId}`,
      };
    }
    await this.resolvePendingRequest(requestId, "deny", {
      type: "error",
      requestId,
      message: "permission denied by user",
    });
    return { type: "ack", requestId, decision: "deny" };
  }

  /**
   * Removes one request from every pending-approval ownership structure.
   * This operation is deliberately idempotent: socket lifecycle, approval,
   * timeout, and broker shutdown can all race for the same request.
   */
  private async removePendingRequest(requestId: string): Promise<void> {
    const approvalKey = this.requestToApprovalKey.get(requestId);
    const group = approvalKey ? this.groups.get(approvalKey) : undefined;
    this.requestToApprovalKey.delete(requestId);

    if (!group) {
      await removeHostExecPendingEntry(this.paths, this.sessionId, requestId);
      return;
    }

    const waiter = group.waiters.get(requestId);
    group.waiters.delete(requestId);
    group.requests.delete(requestId);
    group.requestIds.delete(requestId);
    group.pendingEntries.delete(requestId);
    await removeHostExecPendingEntry(this.paths, this.sessionId, requestId);

    if (group.requests.size === 0) {
      clearTimeout(group.timer);
      if (this.groups.get(group.approvalKey) === group) {
        this.groups.delete(group.approvalKey);
      }
      group.notificationAbort.abort();
      await closeNotification();
    }
    waiter?.lifecycle.finish();
    waiter?.resolve();
  }

  private async resolvePendingRequest(
    requestId: string,
    mode: "approve" | "deny",
    denyResponse?: HostExecErrorResponse,
  ): Promise<void> {
    const group = this.findGroupByRequestId(requestId);
    if (!group) return;
    await this.resolveGroup(group.approvalKey, mode, denyResponse, requestId);
  }

  private async resolveGroup(
    approvalKey: string,
    mode: "approve" | "deny",
    denyResponse?: HostExecErrorResponse,
    selectedRequestId?: string,
  ): Promise<void> {
    const group = this.groups.get(approvalKey);
    if (!group) return;
    if (selectedRequestId === undefined) {
      clearTimeout(group.timer);
      this.groups.delete(approvalKey);
      group.notificationAbort.abort();
      await closeNotification();
    }

    const requestIds =
      selectedRequestId === undefined
        ? [...group.requests.keys()]
        : [selectedRequestId];
    for (const requestId of requestIds) {
      const pending = group.requests.get(requestId);
      if (!pending) continue;
      const waiter = group.waiters.get(requestId);
      if (selectedRequestId !== undefined) {
        group.waiters.delete(requestId);
        group.requests.delete(requestId);
        group.requestIds.delete(requestId);
        group.pendingEntries.delete(requestId);
      }
      this.requestToApprovalKey.delete(requestId);
      await removeHostExecPendingEntry(this.paths, this.sessionId, requestId);
      if (selectedRequestId !== undefined && group.requests.size === 0) {
        clearTimeout(group.timer);
        this.groups.delete(approvalKey);
        group.notificationAbort.abort();
        await closeNotification();
      }
      const commandStr = [pending.request.argv0, ...pending.request.args].join(
        " ",
      );
      if (!waiter) continue;
      try {
        if (mode === "deny") {
          if (waiter.lifecycle.isCancelled) continue;
          const reason =
            denyResponse?.type === "error" &&
            denyResponse.message === "pending approval timed out"
              ? "prompt-timeout"
              : "denied-by-user";
          await this.recordAudit(requestId, "deny", reason, commandStr);
          try {
            await writeGatewayError(
              waiter.socket,
              requestId,
              denyResponse?.type === "error"
                ? denyResponse.message
                : "permission denied by user",
              "awaiting_decision",
            );
          } catch (e) {
            console.error(
              `resolveGroup: failed to write deny response for request ${requestId}`,
              e,
            );
          }
          waiter.lifecycle.markTerminal();
          continue;
        }
        if (waiter.lifecycle.isCancelled) continue;
        await this.recordAudit(
          requestId,
          "allow",
          "approved-by-user",
          commandStr,
        );
        if (waiter.lifecycle.isCancelled) continue;
        waiter.lifecycle.markRunning();
        try {
          await this.runGatewayResolved(
            pending.request,
            pending.resolved,
            waiter.socket,
            waiter.reader,
            waiter.lifecycle.cancellationSignal,
          );
        } catch (error) {
          if (!waiter.lifecycle.isCancelled) {
            try {
              await writeGatewayError(
                waiter.socket,
                requestId,
                error instanceof Error ? error.message : String(error),
                "awaiting_result",
              );
            } catch (e) {
              console.error(
                `resolveGroup: failed to write error response for request ${requestId}`,
                e,
              );
            }
          }
        }
        waiter.lifecycle.markTerminal();
      } catch (error) {
        // A dead/misbehaving socket for one waiter must not prevent the
        // remaining sibling waiters sharing this approvalKey from being
        // processed and cleaned up.
        console.error(
          `resolveGroup: unexpected error processing waiter for request ${requestId}`,
          error,
        );
      } finally {
        waiter.lifecycle.finish();
        waiter.resolve();
      }
    }
  }

  private findGroupByRequestId(requestId: string): PendingGroup | null {
    const approvalKey = this.requestToApprovalKey.get(requestId);
    if (!approvalKey) return null;
    return this.groups.get(approvalKey) ?? null;
  }

  private async recordAudit(
    requestId: string,
    decision: "allow" | "deny",
    reason: string,
    command: string,
  ): Promise<void> {
    if (!this.auditDir) return;
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      domain: "hostexec",
      sessionId: this.sessionId,
      requestId,
      decision,
      reason,
      command,
    };
    await appendAuditLog(entry, this.auditDir);
  }

  /**
   * この execute 要求が実行するホストファイルが、起動時 baseline から変化して
   * いないかを判定する。LD_PRELOAD 型 argv0（絶対・相対）のみが対象。bare name は
   * ホスト PATH 依存で対象外（design の Non-Goals）。
   *
   * `integrityTargets` が一つも設定されていないブローカーでは、この機能自体を
   * 呼び出し側がまだ opt-in していないとみなし常に pass する（stage 側の全面
   * 配線は Task 3）。opt-in 済み（1件以上設定済み）のブローカーでは、個々の
   * パスが baseline 未登録でも安全側に倒して prompt する — 設計上、LD_PRELOAD
   * 型ルールの対象パスは全て integrityTargets に列挙されている前提であり、
   * 未登録は配線漏れを意味するため。
   */
  private async integrityVerdict(
    request: ExecuteRequest,
    resolved: ResolvedExecution,
  ): Promise<IntegrityVerdict> {
    // この early return は冗長な高速パスとして機能する。呼び出し元
    // （HostExecStage）は LD_PRELOAD 型 argv0 が指す全てのホストパスを
    // integrityTargets に列挙する契約として規定されており、integrityTargets が
    // 空集合であることは LD_PRELOAD 型ルールが一件も存在しないことを意味する。
    // 呼び出し元が将来この契約に反し、LD_PRELOAD 型ルールを維持したまま
    // integrityTargets を部分的にしか渡さないように変化した場合でも、パス単位の
    // 照合自体は baseline 未登録（追跡対象外）を検出して安全側の prompt へ
    // フォールバックする（この既定動作は decideIntegrity(undefined, ...) が
    // 処理する）。しかし本 early return はそのフォールバックを経由せず全件を
    // 素通りさせるため、「integrityTargets は全 LD_PRELOAD パスを網羅する」と
    // いう前提が破綻した瞬間に安全性が消失する。したがってこの結合関係を維持
    // することを前提とし、本 guard の動作自体は変更しない。
    if (this.integrityTargets.length === 0) return "pass";
    const ruleArgv0 = resolved.rule.match.argv0;
    if (!path.isAbsolute(ruleArgv0) && !isRelativeHostExecArgv0(ruleArgv0)) {
      return "pass";
    }
    const hostPath = path.isAbsolute(request.argv0)
      ? request.argv0
      : path.resolve(resolved.cwd, request.argv0);
    // baseline は start() で canonicalizeIntegrityPath 済みのパスをキーにして
    // 格納されているため、lookup 側も同じ関数で正規化してからキーを合わせる
    // （symlink を含むワークスペースでキーがずれて baseline 未検出になるのを
    // 防ぐ）。
    const canonicalHostPath = await canonicalizeIntegrityPath(hostPath);
    const baseline = this.integrityBaseline.get(canonicalHostPath);
    // 常に再ハッシュする（inode/mtime/size による fast-path は持たない）。
    // 同一 inode・同一サイズのまま内容を差し替える攻撃（mtime を touch -r で
    // 復元する等）を検出するため、baseline を渡さずに毎回 stat+read+sha256 する。
    const current = await readFileIntegrity(canonicalHostPath);
    return decideIntegrity(baseline, current);
  }

  private async resolveRequest(
    message: ExecuteRequest,
  ): Promise<ResolvedExecution | null> {
    const argv0 = message.argv0;
    const matchContext: MatchContext = {
      cwd: message.cwd,
      workspaceRoot: this.workspaceRoot,
    };
    const result = matchRule(
      this.config.rules,
      argv0,
      message.args,
      matchContext,
    );
    if (!result) return null;
    const { rule } = result;

    const normalizedCwd = await normalizeAllowedCwd(
      message.cwd,
      this.workspaceRoot,
      this.sessionTmpDir,
      rule,
    );
    const envVars = await this.buildEnv(rule);
    return {
      rule,
      cwd: normalizedCwd,
      envVars,
      capability: {
        ruleId: rule.id,
        argv0: path.isAbsolute(argv0) ? argv0 : path.basename(argv0),
        normalizedArgv: [
          path.isAbsolute(argv0) ? argv0 : path.basename(argv0),
          ...message.args,
        ],
        normalizedCwd: normalizedCwd,
        envBindings: Object.entries(rule.env)
          .map(([key, source]) => ({ key, source }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        inheritEnv: {
          mode: rule.inheritEnv.mode,
          keys: [...rule.inheritEnv.keys].sort(),
        },
      },
    };
  }

  private async buildEnv(rule: HostExecRule): Promise<Record<string, string>> {
    const hostEnv = process.env;
    const envVars: Record<string, string> = {};
    if (rule.inheritEnv.mode === "unsafe-inherit-all") {
      Object.assign(envVars, hostEnv);
    } else {
      for (const key of MINIMAL_ENV_KEYS) {
        const value = hostEnv[key];
        if (value !== undefined) envVars[key] = value;
      }
      envVars.PATH = envVars.PATH ?? DEFAULT_PATH;
    }
    for (const key of rule.inheritEnv.keys) {
      const value = hostEnv[key];
      if (value !== undefined) envVars[key] = value;
    }
    for (const [key, ref] of Object.entries(rule.env)) {
      const secretName = ref.slice("secret:".length);
      envVars[key] = await this.secretStore.require(secretName);
    }
    envVars.GIT_TERMINAL_PROMPT = envVars.GIT_TERMINAL_PROMPT ?? "0";
    return envVars;
  }

  private async runGatewayResolved(
    request: ExecuteRequest,
    resolved: ResolvedExecution,
    socket: Socket,
    reader: GatewayLineReader,
    cancellation: AbortSignal,
  ): Promise<void> {
    const commandArgv0 =
      isRelativeHostExecArgv0(resolved.rule.match.argv0) ||
      path.isAbsolute(resolved.rule.match.argv0)
        ? request.argv0
        : path.basename(request.argv0);
    resolved.envVars.PWD = resolved.cwd;
    let processIdentity: Awaited<
      ReturnType<typeof readProcessIdentity>
    > | null = null;
    await runGatewayExecution({
      socket,
      reader,
      requestId: request.requestId,
      start: {
        type: "start",
        requestId: request.requestId,
        argv0: commandArgv0,
        args: request.args,
        cwd: resolved.cwd,
        env: resolved.envVars,
      },
      maskFilter: this.maskFilter,
      cancellation,
      onSpawned: async (pid) => {
        processIdentity = await readProcessIdentity(pid);
        await this.diagnostics.record("command_spawned", {
          requestId: request.requestId,
          command: commandArgv0,
          argumentCount: request.args.length,
          process: processIdentity,
        });
      },
      onProcessExit: async (exitCode) => {
        await this.diagnostics.record("command_exited", {
          requestId: request.requestId,
          command: commandArgv0,
          argumentCount: request.args.length,
          process: processIdentity,
          exitCode,
        });
      },
    });
  }
}

async function writeGatewayMessage(
  socket: Socket,
  message: BrokerToGatewayMessage,
  state: "awaiting_decision" | "awaiting_result" | "running",
): Promise<void> {
  const line = `${JSON.stringify(message)}\n`;
  // Use the raw-line parser on all broker-to-gateway decisions too. This
  // preserves the protocol's 4 MiB limit even for policy/error messages that
  // bypass runGatewayExecution.
  parseBrokerToGatewayLine(line, state);
  await writeJsonLine(socket, message);
}

async function writeGatewayError(
  socket: Socket,
  requestId: string,
  message: string,
  state: "awaiting_decision" | "awaiting_result" | "running",
): Promise<void> {
  await writeGatewayMessage(
    socket,
    { type: "error", requestId, message },
    state,
  );
}

export async function sendHostExecControlRequest<
  T extends HostExecControlResponse = HostExecControlResponse,
>(socketPath: string, message: HostExecControlRequest): Promise<T> {
  const socket = await connectUnix(socketPath);
  try {
    await writeJsonLine(socket, message);
    const response = await readJsonLine(socket);
    if (!response) throw new Error("empty broker response");
    return JSON.parse(response) as T;
  } finally {
    socket.destroy();
  }
}

/**
 * integrity baseline のキーとして使うパスを正規化する。realpath に失敗する
 * パス（存在しない・権限不足など）は path.resolve へフォールバックする。
 * `normalizeAllowedCwd` が cwd を realpath で正規化する挙動と揃えるための
 * もので、snapshot 時（start()）と execute 時（integrityVerdict）の両方で
 * 同じ関数を通すことにより、ワークスペースパスの途中に symlink が挟まって
 * いても baseline のキーと lookup 時のキーが一致するようにする。
 */
async function canonicalizeIntegrityPath(p: string): Promise<string> {
  return await realpath(p).catch(() => path.resolve(p));
}

async function normalizeAllowedCwd(
  cwd: string,
  workspaceRoot: string,
  sessionTmpDir: string,
  rule: HostExecRule,
): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  const normalized = await realpath(cwd).catch(() => path.resolve(cwd));
  const withinWorkspace = isWithin(normalized, workspaceRoot);
  const withinSessionTmp = isWithin(normalized, sessionTmpDir);
  switch (rule.cwd.mode) {
    case "workspace-only":
      if (!withinWorkspace) {
        throw new Error(`cwd is outside workspace: ${normalized}`);
      }
      break;
    case "workspace-or-session-tmp":
      if (!withinWorkspace && !withinSessionTmp) {
        throw new Error(`cwd is outside workspace/session tmp: ${normalized}`);
      }
      break;
    case "allowlist": {
      const allowed = await Promise.all(
        rule.cwd.allow.map((entry) =>
          resolveAllowEntry(entry, workspaceRoot, sessionTmpDir),
        ),
      );
      if (!allowed.some((entry) => isWithin(normalized, entry))) {
        throw new Error(`cwd is outside allowed paths: ${normalized}`);
      }
      break;
    }
    case "any":
      break;
  }
  return normalized;
}

export async function resolveAllowEntry(
  entry: string,
  workspaceRoot: string,
  sessionTmpDir: string,
): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  if (entry.startsWith("workspace:")) {
    const resolved = path.resolve(
      workspaceRoot,
      entry.slice("workspace:".length),
    );
    assertWithinRoot(resolved, workspaceRoot, entry);
    return resolved;
  }
  if (entry.startsWith("session_tmp:")) {
    const resolved = path.resolve(
      sessionTmpDir,
      entry.slice("session_tmp:".length),
    );
    assertWithinRoot(resolved, sessionTmpDir, entry);
    return resolved;
  }
  const expanded = expandTilde(entry, process.env.HOME || os.homedir());
  return await realpath(expanded).catch(() => path.resolve(expanded));
}

function assertWithinRoot(resolved: string, root: string, entry: string): void {
  const relative = path.relative(root, resolved);
  if (
    relative !== "" &&
    (relative.startsWith("..") || path.isAbsolute(relative))
  ) {
    throw new Error(
      `hostexec cwd.allow entry "${entry}" escapes its root (${root})`,
    );
  }
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function buildApprovalKey(
  capability: ResolvedExecutionCapability,
): Promise<string> {
  const data = canonicalJson(capability);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJsonValue(nested)]),
    );
  }
  return value;
}

function toPendingEntry(
  request: ExecuteRequest,
  resolved: ResolvedExecution,
  approvalKey: string,
  createdAt: string,
  integrityChanged: boolean,
): HostExecPendingEntry {
  return {
    version: 1,
    sessionId: request.sessionId,
    requestId: request.requestId,
    approvalKey,
    ruleId: resolved.rule.id,
    argv0: request.argv0,
    args: request.args,
    cwd: resolved.cwd,
    state: "pending",
    createdAt,
    updatedAt: new Date().toISOString(),
    ...(integrityChanged ? { integrityChanged: true } : {}),
  };
}

function toErrorResponse(
  message: HostExecControlRequest | ExecuteRequest,
  errorMessage: string,
): HostExecControlResponse {
  if ("requestId" in message) {
    return {
      type: "error",
      requestId: message.requestId,
      message: errorMessage,
    };
  }
  return {
    type: "pending",
    items: [],
  };
}
