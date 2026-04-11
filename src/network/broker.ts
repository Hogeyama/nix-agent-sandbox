import { rm } from "node:fs/promises";
import { appendAuditLog } from "../audit/store.ts";
import type { AuditLogEntry } from "../audit/types.ts";
import { TtlLruCache } from "../lib/ttl_lru_cache.ts";
import {
  connectUnix,
  createUnixServer,
  readJsonLine,
  type Server,
  type Socket,
  writeJsonLine,
} from "../lib/unix_socket.ts";
import { logInfo } from "../log.ts";
import {
  closeNotification,
  notifyPendingRequest,
  type ResolvedNotifyBackend,
} from "./notify.ts";
import {
  type ApprovalScope,
  type AuthorizeRequest,
  type DecisionResponse,
  denyReasonForTarget,
  matchesAllowlist,
  type PendingEntry,
  targetKey,
  targetKeyForScope,
} from "./protocol.ts";
import type { NetworkRuntimePaths } from "./registry.ts";
import {
  brokerSocketPath,
  listPendingEntries,
  removePendingDir,
  removePendingEntry,
  writePendingEntry,
} from "./registry.ts";

interface BrokerOptions {
  paths: NetworkRuntimePaths;
  sessionId: string;
  allowlist: string[];
  denylist: string[];
  promptEnabled: boolean;
  timeoutSeconds: number;
  defaultScope: ApprovalScope;
  notify: ResolvedNotifyBackend;
  uiEnabled?: boolean;
  uiPort?: number;
  uiIdleTimeout?: number;
  /** Override negative-cache TTL for testing. Default: 30 000 ms. */
  negativeCacheTtlMs?: number;
  /** Directory for audit JSONL logs. If set, decisions are recorded. */
  auditDir?: string;
}

interface PendingWaiter {
  resolve: (response: DecisionResponse) => void;
  reject: (error: unknown) => void;
}

interface PendingGroup {
  groupKey: string;
  targetKey: string;
  createdAt: string;
  target: AuthorizeRequest["target"];
  requests: Map<string, AuthorizeRequest>;
  waiters: Map<string, PendingWaiter>;
  timer: ReturnType<typeof setTimeout>;
  notificationAbort: AbortController;
}

type BrokerMessage =
  | AuthorizeRequest
  | { type: "approve"; requestId: string; scope?: ApprovalScope }
  | { type: "deny"; requestId: string; scope?: ApprovalScope }
  | { type: "list_pending" };

type BrokerResponse =
  | DecisionResponse
  | { type: "pending"; items: PendingEntry[] }
  | { type: "ack"; requestId: string; decision: "approve" | "deny" }
  | { type: "error"; requestId: string; message: string };

export class SessionBroker {
  private readonly paths: NetworkRuntimePaths;
  private readonly sessionId: string;
  private readonly allowlist: string[];
  private readonly denylist: string[];
  private readonly promptEnabled: boolean;
  private readonly timeoutSeconds: number;
  private readonly defaultScope: ApprovalScope;
  private readonly notify: ResolvedNotifyBackend;
  private readonly uiEnabled?: boolean;
  private readonly uiPort?: number;
  private readonly uiIdleTimeout?: number;
  private readonly auditDir?: string;
  private socketPath: string | null = null;
  private server: Server | null = null;
  private readonly approvedTargets = new Set<string>();
  private readonly approvedHosts = new Set<string>();
  private readonly deniedTargets = new Set<string>();
  private readonly deniedHosts = new Set<string>();
  private readonly negativeCache: TtlLruCache<string, true>;
  private readonly groups = new Map<string, PendingGroup>();
  private readonly requestIndex = new Map<string, string>();
  private readonly notificationTasks = new Set<Promise<void>>();

  constructor(options: BrokerOptions) {
    this.paths = options.paths;
    this.sessionId = options.sessionId;
    this.allowlist = options.allowlist;
    this.denylist = options.denylist;
    this.promptEnabled = options.promptEnabled;
    this.timeoutSeconds = options.timeoutSeconds;
    this.defaultScope = options.defaultScope;
    this.notify = options.notify;
    this.uiEnabled = options.uiEnabled;
    this.uiPort = options.uiPort;
    this.uiIdleTimeout = options.uiIdleTimeout;
    this.auditDir = options.auditDir;
    this.negativeCache = new TtlLruCache<string, true>({
      maxSize: 1024,
      ttlMs: options.negativeCacheTtlMs ?? 30_000,
    });
  }

  async start(socketPath: string): Promise<void> {
    this.socketPath = socketPath;
    await rm(socketPath, { force: true });
    this.server = await createUnixServer(
      socketPath,
      (socket) => void this.handleConnection(socket),
    );
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    for (const group of this.groups.values()) {
      clearTimeout(group.timer);
      group.notificationAbort.abort();
      for (const [requestId, waiter] of group.waiters.entries()) {
        waiter.resolve({
          version: 1,
          type: "decision",
          requestId,
          decision: "deny",
          reason: "broker closed",
        });
      }
    }
    await Promise.allSettled(this.notificationTasks);
    this.groups.clear();
    this.requestIndex.clear();
    this.approvedTargets.clear();
    this.approvedHosts.clear();
    this.deniedTargets.clear();
    this.deniedHosts.clear();
    this.negativeCache.clear();
    await removePendingDir(this.paths, this.sessionId);
    const sock =
      this.socketPath ?? brokerSocketPath(this.paths, this.sessionId);
    await rm(sock, { force: true }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        logInfo(`[nas] NetworkBroker: failed to remove socket: ${e}`);
      }
    });
  }

  async listPending(): Promise<PendingEntry[]> {
    return await listPendingEntries(this.paths, this.sessionId);
  }

  private async handleConnection(socket: Socket): Promise<void> {
    try {
      const line = await readJsonLine(socket);
      if (!line) return;
      const response = await this.handleMessage(
        JSON.parse(line) as BrokerMessage,
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

  private async handleMessage(message: BrokerMessage): Promise<BrokerResponse> {
    if (message.type === "authorize") {
      return await this.authorize(message);
    }
    if (message.type === "approve") {
      return await this.approve(message.requestId, message.scope);
    }
    if (message.type === "deny") {
      return await this.deny(message.requestId, message.scope);
    }
    return { type: "pending", items: await this.listPending() };
  }

  private async authorize(
    message: AuthorizeRequest,
  ): Promise<DecisionResponse> {
    const targetStr = `${message.target.host}:${message.target.port}`;

    // deny-by-default targets (localhost, loopback, RFC1918, link-local, ULA)
    // are always blocked — even if they appear in the allowlist.
    const denyReason = denyReasonForTarget(message.target);
    if (denyReason) {
      await this.recordAudit(message.requestId, "deny", denyReason, targetStr);
      return denyDecision(message.requestId, denyReason);
    }

    const allowlistHit = matchesAllowlist(message.target, this.allowlist);
    if (allowlistHit) {
      await this.recordAudit(
        message.requestId,
        "allow",
        "allowlist",
        targetStr,
      );
      return allowDecision(message.requestId, "allowlist");
    }

    const targetCacheKey = targetKey(message.target);
    if (matchesAllowlist(message.target, this.denylist)) {
      await this.recordAudit(message.requestId, "deny", "denylist", targetStr);
      return denyDecision(message.requestId, "denylist");
    }

    if (
      this.deniedTargets.has(targetCacheKey) ||
      this.deniedHosts.has(message.target.host)
    ) {
      await this.recordAudit(
        message.requestId,
        "deny",
        "denied-by-user",
        targetStr,
      );
      return denyDecision(message.requestId, "denied-by-user");
    }

    if (
      this.approvedTargets.has(targetCacheKey) ||
      this.approvedHosts.has(message.target.host)
    ) {
      await this.recordAudit(message.requestId, "allow", "approved", targetStr);
      return allowDecision(message.requestId, "approved");
    }

    if (this.negativeCache.get(targetCacheKey) !== undefined) {
      await this.recordAudit(
        message.requestId,
        "deny",
        "recent-deny",
        targetStr,
      );
      return denyDecision(message.requestId, "recent-deny");
    }

    if (!this.promptEnabled) {
      await this.recordAudit(
        message.requestId,
        "deny",
        "not-in-allowlist",
        targetStr,
      );
      return denyDecision(message.requestId, "not-in-allowlist");
    }

    const groupKey = `${this.sessionId}:${targetCacheKey}`;
    const group =
      this.groups.get(groupKey) ??
      (await this.createPendingGroup(groupKey, message));

    if (!group.requests.has(message.requestId)) {
      group.requests.set(message.requestId, message);
      this.requestIndex.set(message.requestId, groupKey);
      await writePendingEntry(
        this.paths,
        toPendingEntry(message, group.createdAt),
      );
    }

    const deferred = Promise.withResolvers<DecisionResponse>();
    group.waiters.set(message.requestId, {
      resolve: deferred.resolve,
      reject: deferred.reject,
    });
    return await deferred.promise;
  }

  private async createPendingGroup(
    groupKey: string,
    message: AuthorizeRequest,
  ): Promise<PendingGroup> {
    const createdAt = new Date().toISOString();
    const notificationAbort = new AbortController();
    const timer = setTimeout(() => {
      void this.resolveGroup(
        groupKey,
        denyDecision(message.requestId, "prompt-timeout"),
        "deny",
      );
    }, this.timeoutSeconds * 1000);
    const group: PendingGroup = {
      groupKey,
      targetKey: targetKey(message.target),
      createdAt,
      target: message.target,
      requests: new Map([[message.requestId, message]]),
      waiters: new Map(),
      timer,
      notificationAbort,
    };
    this.groups.set(groupKey, group);
    this.requestIndex.set(message.requestId, groupKey);
    await writePendingEntry(this.paths, toPendingEntry(message, createdAt));
    const notificationTask = notifyPendingRequest({
      backend: this.notify,
      sessionId: this.sessionId,
      requestId: message.requestId,
      target: group.target,
      uiEnabled: this.uiEnabled,
      uiPort: this.uiPort,
      uiIdleTimeout: this.uiIdleTimeout,
      signal: notificationAbort.signal,
    }).catch((e) =>
      logInfo(`[nas] NetworkBroker: failed to send notification: ${e}`),
    );
    this.notificationTasks.add(notificationTask);
    void notificationTask.finally(() => {
      this.notificationTasks.delete(notificationTask);
    });
    return group;
  }

  private async approve(
    requestId: string,
    scope?: ApprovalScope,
  ): Promise<BrokerResponse> {
    const group = this.findGroupByRequestId(requestId);
    if (!group) {
      return {
        type: "error",
        requestId,
        message: `Pending request not found: ${requestId}`,
      };
    }
    const selectedScope = scope ?? this.defaultScope;
    if (selectedScope === "host") {
      this.approvedHosts.add(group.target.host);
    } else if (selectedScope === "host-port") {
      this.approvedTargets.add(targetKeyForScope(group.target, "host-port"));
    }
    await this.resolveGroup(
      group.groupKey,
      allowDecision(requestId, "approved-by-user", selectedScope),
      "allow",
    );
    return { type: "ack", requestId, decision: "approve" };
  }

  private async deny(
    requestId: string,
    scope?: ApprovalScope,
  ): Promise<BrokerResponse> {
    const group = this.findGroupByRequestId(requestId);
    if (!group) {
      return {
        type: "error",
        requestId,
        message: `Pending request not found: ${requestId}`,
      };
    }
    if (scope === "host") {
      this.deniedHosts.add(group.target.host);
      this.approvedHosts.delete(group.target.host);
    } else if (scope === "host-port") {
      this.deniedTargets.add(targetKeyForScope(group.target, "host-port"));
      this.approvedTargets.delete(targetKeyForScope(group.target, "host-port"));
    }
    await this.resolveGroup(
      group.groupKey,
      denyDecision(requestId, "denied-by-user", scope),
      "deny",
      scope === undefined,
    );
    return { type: "ack", requestId, decision: "deny" };
  }

  private async resolveGroup(
    groupKey: string,
    baseDecision: DecisionResponse,
    outcome: "allow" | "deny",
    useNegativeCache = true,
  ): Promise<void> {
    const group = this.groups.get(groupKey);
    if (!group) return;
    clearTimeout(group.timer);
    this.groups.delete(groupKey);
    group.notificationAbort.abort();
    await closeNotification();
    if (outcome === "deny" && useNegativeCache) {
      this.negativeCache.set(group.targetKey, true);
    }

    for (const [requestId, request] of group.requests.entries()) {
      this.requestIndex.delete(requestId);
      await removePendingEntry(this.paths, this.sessionId, requestId);
      const decision: DecisionResponse = {
        ...baseDecision,
        requestId: request.requestId,
      };
      const targetStr = `${request.target.host}:${request.target.port}`;
      await this.recordAudit(
        requestId,
        outcome === "allow" ? "allow" : "deny",
        baseDecision.reason,
        targetStr,
      );
      const waiter = group.waiters.get(requestId);
      waiter?.resolve(decision);
    }
  }

  private findGroupByRequestId(requestId: string): PendingGroup | null {
    const groupKey = this.requestIndex.get(requestId);
    if (!groupKey) return null;
    return this.groups.get(groupKey) ?? null;
  }

  private async recordAudit(
    requestId: string,
    decision: "allow" | "deny",
    reason: string,
    target: string,
  ): Promise<void> {
    if (!this.auditDir) return;
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      domain: "network",
      sessionId: this.sessionId,
      requestId,
      decision,
      reason,
      target,
    };
    await appendAuditLog(entry, this.auditDir);
  }
}

export async function sendBrokerRequest<T extends BrokerResponse>(
  socketPath: string,
  message: BrokerMessage,
): Promise<T> {
  const socket = await connectUnix(socketPath);
  try {
    await writeJsonLine(socket, message);
    const response = await readJsonLine(socket);
    if (!response) {
      throw new Error("empty broker response");
    }
    return JSON.parse(response) as T;
  } finally {
    socket.destroy();
  }
}

function toPendingEntry(
  message: AuthorizeRequest,
  createdAt: string,
): PendingEntry {
  return {
    version: 1,
    sessionId: message.sessionId,
    requestId: message.requestId,
    target: message.target,
    method: message.method,
    requestKind: message.requestKind,
    state: "pending",
    createdAt,
    updatedAt: new Date().toISOString(),
  };
}

function allowDecision(
  requestId: string,
  reason: string,
  scope?: ApprovalScope,
): DecisionResponse {
  return {
    version: 1,
    type: "decision",
    requestId,
    decision: "allow",
    reason,
    scope,
  };
}

function denyDecision(
  requestId: string,
  reason: string,
  scope?: ApprovalScope,
): DecisionResponse {
  return {
    version: 1,
    type: "decision",
    requestId,
    decision: "deny",
    reason,
    scope,
    message: reason,
  };
}
