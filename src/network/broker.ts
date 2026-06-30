import { mkdir, rm, rmdir } from "node:fs/promises";
import * as path from "node:path";
import { appendAuditLog } from "../audit/store.ts";
import type { AuditLogEntry } from "../audit/types.ts";
import type { ReviewRule } from "../config/types.ts";
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
import { findMatchingCredentials } from "./credential_matching.ts";
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
  matchesHostPattern,
  type PendingEntry,
  type ResolvedCredential,
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
  reviewRules: ReviewRule[];
  pendingTimeoutSeconds: number;
  pendingDefaultScope: ApprovalScope;
  pendingNotify: ResolvedNotifyBackend;
  uiEnabled?: boolean;
  uiPort?: number;
  uiIdleTimeout?: number;
  /** Override negative-cache TTL for testing. Default: 30 000 ms. */
  negativeCacheTtlMs?: number;
  /** Directory for audit JSONL logs. If set, decisions are recorded. */
  auditDir?: string;
  /** Pre-resolved credentials to inject into matching allow responses. */
  resolvedCredentials?: ResolvedCredential[];
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
  /**
   * Set of approval scopes the UI/client is permitted to select when
   * approving this pending group. An approve/deny message with a scope
   * outside this set is rejected, preventing a caller that reads
   * /api/network/pending and POSTs arbitrary JSON from escalating beyond
   * what was advertised.
   */
  allowedScopes: ReadonlySet<ApprovalScope>;
}

/**
 * Scopes a client may pick when approving a network request. This mirrors
 * what the UI exposes today and is the defensive cap enforced by the
 * broker regardless of what the HTTP layer forwards.
 */
const ALLOWED_NETWORK_SCOPES: ReadonlySet<ApprovalScope> = new Set([
  "once",
  "host-port",
  "host",
]);

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
  private readonly reviewRules: ReviewRule[];
  private readonly timeoutSeconds: number;
  private readonly defaultScope: ApprovalScope;
  private readonly notify: ResolvedNotifyBackend;
  private readonly uiEnabled?: boolean;
  private readonly uiPort?: number;
  private readonly uiIdleTimeout?: number;
  private readonly auditDir?: string;
  private readonly resolvedCredentials: ResolvedCredential[];
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
    this.reviewRules = options.reviewRules;
    this.timeoutSeconds = options.pendingTimeoutSeconds;
    this.defaultScope = options.pendingDefaultScope;
    this.notify = options.pendingNotify;
    this.uiEnabled = options.uiEnabled;
    this.uiPort = options.uiPort;
    this.uiIdleTimeout = options.uiIdleTimeout;
    this.auditDir = options.auditDir;
    this.resolvedCredentials = options.resolvedCredentials ?? [];
    this.negativeCache = new TtlLruCache<string, true>({
      maxSize: 1024,
      ttlMs: options.negativeCacheTtlMs ?? 30_000,
    });
  }

  async start(socketPath: string): Promise<void> {
    this.socketPath = socketPath;
    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    await rm(socketPath, { force: true });
    this.server = await createUnixServer(
      socketPath,
      (socket) => void this.handleConnection(socket),
    );
  }

  async close(): Promise<void> {
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
    await rmdir(path.dirname(sock)).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        logInfo(
          `[nas] NetworkBroker: failed to remove session broker dir: ${e}`,
        );
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
    // are always blocked regardless of reviewRules.
    const denyReason = denyReasonForTarget(message.target);
    if (denyReason) {
      await this.recordAudit(message.requestId, "deny", denyReason, targetStr);
      return denyDecision(message.requestId, denyReason);
    }

    const targetCacheKey = targetKey(message.target);

    // Session-scoped deny/approve caches (set by user decisions) take priority
    // over rule evaluation.
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
      const decision = this.injectCredentialHeaders(
        allowDecision(message.requestId, "approved"),
        message,
      );
      const headerNames = decision.injectHeaders?.map((h) => h.name);
      await this.recordAudit(
        message.requestId,
        "allow",
        "approved",
        targetStr,
        headerNames,
      );
      return decision;
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

    // First-match evaluation of reviewRules.
    const matchedRule = this.findMatchingRule(message);
    if (matchedRule !== null) {
      if (matchedRule.action === "allow") {
        const decision = this.injectCredentialHeaders(
          allowDecision(message.requestId, "review-rule"),
          message,
        );
        const headerNames = decision.injectHeaders?.map((h) => h.name);
        await this.recordAudit(
          message.requestId,
          "allow",
          "review-rule",
          targetStr,
          headerNames,
        );
        return decision;
      }
      if (matchedRule.action === "deny") {
        await this.recordAudit(
          message.requestId,
          "deny",
          "review-rule",
          targetStr,
        );
        return denyDecision(message.requestId, "review-rule");
      }
      // action === "review": fall through to pending queue
    } else {
      // No rule matched — deny by default.
      await this.recordAudit(
        message.requestId,
        "deny",
        "no-matching-rule",
        targetStr,
      );
      return denyDecision(message.requestId, "no-matching-rule");
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
      allowedScopes: ALLOWED_NETWORK_SCOPES,
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
    if (scope !== undefined && !group.allowedScopes.has(scope)) {
      return {
        type: "error",
        requestId,
        message: `scope not allowed for this request: ${scope}`,
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
    if (scope !== undefined && !group.allowedScopes.has(scope)) {
      return {
        type: "error",
        requestId,
        message: `scope not allowed for this request: ${scope}`,
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
      const baseWithId: DecisionResponse = {
        ...baseDecision,
        requestId: request.requestId,
      };
      const decision =
        outcome === "allow"
          ? this.injectCredentialHeaders(baseWithId, request)
          : baseWithId;
      const targetStr = `${request.target.host}:${request.target.port}`;
      const headerNames = decision.injectHeaders?.map((h) => h.name);
      await this.recordAudit(
        requestId,
        outcome === "allow" ? "allow" : "deny",
        baseDecision.reason,
        targetStr,
        headerNames,
      );
      const waiter = group.waiters.get(requestId);
      waiter?.resolve(decision);
    }
  }

  private findMatchingRule(message: AuthorizeRequest): ReviewRule | null {
    for (const rule of this.reviewRules) {
      if (
        rule.method !== undefined &&
        rule.method.toUpperCase() !== message.method.toUpperCase()
      )
        continue;
      if (
        rule.host !== undefined &&
        !matchesHostPattern(message.target, [rule.host])
      )
        continue;
      if (rule.pathPrefix !== undefined) {
        const p = message.reviewContext?.path ?? "";
        if (!p.startsWith(rule.pathPrefix)) continue;
      }
      return rule;
    }
    return null;
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
    injectedHeaders?: string[],
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
      injectedHeaders,
    };
    await appendAuditLog(entry, this.auditDir);
  }

  private injectCredentialHeaders(
    decision: DecisionResponse,
    message: AuthorizeRequest,
  ): DecisionResponse {
    if (
      decision.decision !== "allow" ||
      this.resolvedCredentials.length === 0
    ) {
      return decision;
    }
    const path = message.reviewContext?.path ?? "";
    const headers = findMatchingCredentials(
      this.resolvedCredentials,
      message.target.host,
      message.target.port,
      message.method,
      path,
    );
    if (headers.length === 0) return decision;
    return { ...decision, injectHeaders: headers };
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
    reviewContext: message.reviewContext,
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
