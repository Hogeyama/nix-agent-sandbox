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
import {
  closeNotification,
  type NotifyBackend,
  notifyPendingRequest,
} from "./notify.ts";

interface BrokerOptions {
  paths: NetworkRuntimePaths;
  sessionId: string;
  allowlist: string[];
  denylist: string[];
  promptEnabled: boolean;
  timeoutSeconds: number;
  defaultScope: ApprovalScope;
  notify: NotifyBackend;
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
  timer: number;
  notificationAbort: AbortController;
}

type BrokerMessage =
  | AuthorizeRequest
  | { type: "approve"; requestId: string; scope?: ApprovalScope }
  | { type: "deny"; requestId: string }
  | { type: "list_pending" };

type BrokerResponse =
  | DecisionResponse
  | { type: "pending"; items: PendingEntry[] }
  | { type: "ack"; requestId: string; decision: "approve" | "deny" };

export class SessionBroker {
  private readonly paths: NetworkRuntimePaths;
  private readonly sessionId: string;
  private readonly allowlist: string[];
  private readonly denylist: string[];
  private readonly promptEnabled: boolean;
  private readonly timeoutSeconds: number;
  private readonly defaultScope: ApprovalScope;
  private readonly notify: NotifyBackend;
  private socketPath: string | null = null;
  private listener: Deno.Listener | null = null;
  private closing = false;
  private readonly approvedTargets = new Set<string>();
  private readonly approvedHosts = new Set<string>();
  private readonly negativeCache = new Map<string, number>();
  private readonly groups = new Map<string, PendingGroup>();
  private readonly requestIndex = new Map<string, string>();
  private acceptLoop: Promise<void> | null = null;

  constructor(options: BrokerOptions) {
    this.paths = options.paths;
    this.sessionId = options.sessionId;
    this.allowlist = options.allowlist;
    this.denylist = options.denylist;
    this.promptEnabled = options.promptEnabled;
    this.timeoutSeconds = options.timeoutSeconds;
    this.defaultScope = options.defaultScope;
    this.notify = options.notify;
  }

  async start(socketPath: string): Promise<void> {
    this.socketPath = socketPath;
    try {
      await Deno.remove(socketPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    this.listener = Deno.listen({ transport: "unix", path: socketPath });
    this.acceptLoop = this.runAcceptLoop();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.listener) {
      this.listener.close();
      this.listener = null;
    }
    if (this.acceptLoop) {
      await this.acceptLoop.catch(() => {});
    }
    for (const group of this.groups.values()) {
      clearTimeout(group.timer);
      for (const waiter of group.waiters.values()) {
        waiter.resolve({
          version: 1,
          type: "decision",
          requestId: "",
          decision: "deny",
          reason: "broker closed",
        });
      }
    }
    this.groups.clear();
    this.requestIndex.clear();
    await removePendingDir(this.paths, this.sessionId);
    if (this.socketPath) {
      await Deno.remove(this.socketPath).catch(() => {});
    } else {
      await Deno.remove(brokerSocketPath(this.paths, this.sessionId)).catch(
        () => {},
      );
    }
  }

  async listPending(): Promise<PendingEntry[]> {
    return await listPendingEntries(this.paths, this.sessionId);
  }

  private async runAcceptLoop(): Promise<void> {
    while (!this.closing && this.listener) {
      let conn: Deno.Conn;
      try {
        conn = await this.listener.accept();
      } catch (error) {
        if (this.closing) return;
        throw error;
      }
      void this.handleConnection(conn);
    }
  }

  private async handleConnection(conn: Deno.Conn): Promise<void> {
    try {
      const line = await readJsonLine(conn);
      if (!line) return;
      const response = await this.handleMessage(
        JSON.parse(line) as BrokerMessage,
      );
      await conn.write(
        new TextEncoder().encode(JSON.stringify(response) + "\n"),
      );
    } finally {
      conn.close();
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
      return await this.deny(message.requestId);
    }
    return { type: "pending", items: await this.listPending() };
  }

  private async authorize(
    message: AuthorizeRequest,
  ): Promise<DecisionResponse> {
    const allowlistHit = matchesAllowlist(
      message.target.host,
      this.allowlist,
    );
    if (allowlistHit) {
      return allowDecision(message.requestId, "allowlist");
    }

    const targetCacheKey = targetKey(message.target);
    if (
      this.approvedTargets.has(targetCacheKey) ||
      this.approvedHosts.has(message.target.host)
    ) {
      return allowDecision(message.requestId, "approved");
    }

    const denyReason = denyReasonForTarget(message.target);
    if (denyReason) {
      return denyDecision(message.requestId, denyReason);
    }

    if (matchesAllowlist(message.target.host, this.denylist)) {
      return denyDecision(message.requestId, "denylist");
    }

    const denyUntil = this.negativeCache.get(targetCacheKey);
    if (denyUntil && denyUntil > Date.now()) {
      return denyDecision(message.requestId, "recent-deny");
    }

    if (!this.promptEnabled) {
      return denyDecision(message.requestId, "not-in-allowlist");
    }

    const groupKey = `${this.sessionId}:${targetCacheKey}`;
    const group = this.groups.get(groupKey) ?? await this.createPendingGroup(
      groupKey,
      message,
    );

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
    void notifyPendingRequest({
      backend: this.notify,
      brokerSocket: this.socketPath ??
        brokerSocketPath(this.paths, this.sessionId),
      sessionId: this.sessionId,
      requestId: message.requestId,
      target: group.target,
      signal: notificationAbort.signal,
    });
    return group;
  }

  private async approve(
    requestId: string,
    scope?: ApprovalScope,
  ): Promise<BrokerResponse> {
    const group = this.findGroupByRequestId(requestId);
    if (!group) {
      throw new Error(`Pending request not found: ${requestId}`);
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

  private async deny(requestId: string): Promise<BrokerResponse> {
    const group = this.findGroupByRequestId(requestId);
    if (!group) {
      throw new Error(`Pending request not found: ${requestId}`);
    }
    await this.resolveGroup(
      group.groupKey,
      denyDecision(requestId, "denied-by-user"),
      "deny",
    );
    return { type: "ack", requestId, decision: "deny" };
  }

  private async resolveGroup(
    groupKey: string,
    baseDecision: DecisionResponse,
    outcome: "allow" | "deny",
  ): Promise<void> {
    const group = this.groups.get(groupKey);
    if (!group) return;
    clearTimeout(group.timer);
    this.groups.delete(groupKey);
    group.notificationAbort.abort();
    await closeNotification();
    if (outcome === "deny") {
      this.negativeCache.set(group.targetKey, Date.now() + 30_000);
    }

    for (const [requestId, request] of group.requests.entries()) {
      this.requestIndex.delete(requestId);
      await removePendingEntry(this.paths, this.sessionId, requestId);
      const decision: DecisionResponse = {
        ...baseDecision,
        requestId: request.requestId,
      };
      const waiter = group.waiters.get(requestId);
      waiter?.resolve(decision);
    }
  }

  private findGroupByRequestId(requestId: string): PendingGroup | null {
    const groupKey = this.requestIndex.get(requestId);
    if (!groupKey) return null;
    return this.groups.get(groupKey) ?? null;
  }
}

export async function sendBrokerRequest<T extends BrokerResponse>(
  socketPath: string,
  message: BrokerMessage,
): Promise<T> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  try {
    await conn.write(
      new TextEncoder().encode(JSON.stringify(message) + "\n"),
    );
    const response = await readJsonLine(conn);
    if (!response) {
      throw new Error("empty broker response");
    }
    return JSON.parse(response) as T;
  } finally {
    conn.close();
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
): DecisionResponse {
  return {
    version: 1,
    type: "decision",
    requestId,
    decision: "deny",
    reason,
    message: reason,
  };
}

async function readJsonLine(conn: Deno.Conn): Promise<string | null> {
  const decoder = new TextDecoder();
  let text = "";
  const chunk = new Uint8Array(1024);
  while (true) {
    const size = await conn.read(chunk);
    if (size === null) break;
    text += decoder.decode(chunk.subarray(0, size));
    const newlineIdx = text.indexOf("\n");
    if (newlineIdx !== -1) {
      return text.slice(0, newlineIdx);
    }
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}
