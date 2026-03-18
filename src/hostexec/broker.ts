import * as path from "@std/path";
import type { HostExecConfig, HostExecRule } from "../config/types.ts";
import { DEFAULT_HOSTEXEC_CONFIG } from "../config/types.ts";
import { SecretStore } from "./secret_store.ts";
import { notifyHostExecPendingRequest } from "./notify.ts";
import {
  hostExecBrokerSocketPath,
  type HostExecRuntimePaths,
  listHostExecPendingEntries,
  removeHostExecPendingDir,
  removeHostExecPendingEntry,
  removeHostExecSessionRegistry,
  writeHostExecPendingEntry,
} from "./registry.ts";
import { matchRule } from "./match.ts";
import type {
  ExecuteRequest,
  HostExecBrokerMessage,
  HostExecBrokerResponse,
  HostExecPendingEntry,
  ResolvedExecution,
  ResolvedExecutionCapability,
} from "./types.ts";

interface HostExecBrokerOptions {
  paths: HostExecRuntimePaths;
  sessionId: string;
  profileName: string;
  workspaceRoot: string;
  sessionTmpDir: string;
  hostexec?: HostExecConfig;
}

interface PendingWaiter {
  resolve: (response: HostExecBrokerResponse) => void;
  reject: (error: unknown) => void;
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
  timer: number;
  notificationAbort: AbortController;
}

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
  private readonly secretStore: SecretStore;
  private socketPath: string | null = null;
  private listener: Deno.Listener | null = null;
  private acceptLoop: Promise<void> | null = null;
  private closing = false;
  private readonly approvedKeys = new Set<string>();
  private readonly groups = new Map<string, PendingGroup>();
  private readonly requestToApprovalKey = new Map<string, string>();
  private readonly notificationTasks = new Set<Promise<void>>();

  constructor(options: HostExecBrokerOptions) {
    this.paths = options.paths;
    this.sessionId = options.sessionId;
    this.profileName = options.profileName;
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.sessionTmpDir = path.resolve(options.sessionTmpDir);
    this.config = options.hostexec ?? structuredClone(DEFAULT_HOSTEXEC_CONFIG);
    this.secretStore = new SecretStore(this.config.secrets);
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
      group.notificationAbort.abort();
      for (const waiter of group.waiters.values()) {
        waiter.resolve({
          type: "error",
          requestId: "",
          message: "hostexec broker closed",
        });
      }
    }
    await Promise.allSettled(this.notificationTasks);
    this.groups.clear();
    this.requestToApprovalKey.clear();
    await removeHostExecPendingDir(this.paths, this.sessionId);
    await removeHostExecSessionRegistry(this.paths, this.sessionId);
    const target = this.socketPath ??
      hostExecBrokerSocketPath(this.paths, this.sessionId);
    await Deno.remove(target).catch(() => {});
  }

  async listPending(): Promise<HostExecPendingEntry[]> {
    return await listHostExecPendingEntries(this.paths, this.sessionId);
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
      const message = JSON.parse(line) as HostExecBrokerMessage;
      const response = await this.handleMessage(message).catch((error) =>
        toErrorResponse(message, (error as Error).message)
      );
      await conn.write(
        new TextEncoder().encode(JSON.stringify(response) + "\n"),
      );
    } finally {
      conn.close();
    }
  }

  private async handleMessage(
    message: HostExecBrokerMessage,
  ): Promise<HostExecBrokerResponse> {
    if (message.type === "list_pending") {
      return { type: "pending", items: await this.listPending() };
    }
    if (message.type === "approve") {
      return await this.approve(message.requestId);
    }
    if (message.type === "deny") {
      return await this.deny(message.requestId);
    }
    return await this.execute(message);
  }

  private async execute(
    message: ExecuteRequest,
  ): Promise<HostExecBrokerResponse> {
    const resolved = await this.resolveRequest(message);
    if (!resolved) {
      return { type: "fallback", requestId: message.requestId };
    }
    if (resolved.rule.approval === "deny") {
      return {
        type: "error",
        requestId: message.requestId,
        message: "permission denied by hostexec policy",
      };
    }

    const approvalKey = await buildApprovalKey(resolved.capability);
    if (
      resolved.rule.approval === "allow" ||
      this.approvedKeys.has(approvalKey) ||
      !this.config.prompt.enable
    ) {
      if (resolved.rule.approval === "prompt" && !this.config.prompt.enable) {
        return {
          type: "error",
          requestId: message.requestId,
          message: "hostexec prompt is disabled",
        };
      }
      return await this.runResolved(message, resolved);
    }

    const group = this.groups.get(approvalKey) ?? await this.createPendingGroup(
      approvalKey,
      message,
      resolved,
    );
    if (!group.requests.has(message.requestId)) {
      group.requestIds.add(message.requestId);
      group.requests.set(message.requestId, { request: message, resolved });
      this.requestToApprovalKey.set(message.requestId, approvalKey);
      const entry = toPendingEntry(
        message,
        resolved,
        approvalKey,
        group.createdAt,
      );
      group.pendingEntries.set(message.requestId, entry);
      await writeHostExecPendingEntry(this.paths, entry);
    }
    const deferred = Promise.withResolvers<HostExecBrokerResponse>();
    group.waiters.set(message.requestId, {
      resolve: deferred.resolve,
      reject: deferred.reject,
    });
    return await deferred.promise;
  }

  private async createPendingGroup(
    approvalKey: string,
    message: ExecuteRequest,
    resolved: ResolvedExecution,
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
    };
    this.groups.set(approvalKey, group);
    this.requestToApprovalKey.set(message.requestId, approvalKey);
    const entry = toPendingEntry(message, resolved, approvalKey, createdAt);
    group.pendingEntries.set(message.requestId, entry);
    await writeHostExecPendingEntry(this.paths, entry);
    const notificationTask = notifyHostExecPendingRequest({
      backend: this.config.prompt.notify,
      brokerSocket: this.socketPath ??
        hostExecBrokerSocketPath(this.paths, this.sessionId),
      pending: entry,
      signal: notificationAbort.signal,
    }).catch(() => {});
    this.notificationTasks.add(notificationTask);
    void notificationTask.finally(() => {
      this.notificationTasks.delete(notificationTask);
    });
    return group;
  }

  private async approve(requestId: string): Promise<HostExecBrokerResponse> {
    const group = this.findGroupByRequestId(requestId);
    if (!group) {
      throw new Error(`Pending request not found: ${requestId}`);
    }
    this.approvedKeys.add(group.approvalKey);
    await this.resolveGroup(group.approvalKey, "approve");
    return { type: "ack", requestId, decision: "approve" };
  }

  private async deny(requestId: string): Promise<HostExecBrokerResponse> {
    const group = this.findGroupByRequestId(requestId);
    if (!group) {
      throw new Error(`Pending request not found: ${requestId}`);
    }
    await this.resolveGroup(group.approvalKey, "deny", {
      type: "error",
      requestId,
      message: "permission denied by user",
    });
    return { type: "ack", requestId, decision: "deny" };
  }

  private async resolveGroup(
    approvalKey: string,
    mode: "approve" | "deny",
    denyResponse?: HostExecBrokerResponse,
  ): Promise<void> {
    const group = this.groups.get(approvalKey);
    if (!group) return;
    clearTimeout(group.timer);
    this.groups.delete(approvalKey);
    group.notificationAbort.abort();

    for (const [requestId, pending] of group.requests.entries()) {
      this.requestToApprovalKey.delete(requestId);
      await removeHostExecPendingEntry(this.paths, this.sessionId, requestId);
      const waiter = group.waiters.get(requestId);
      if (!waiter) continue;
      if (mode === "deny") {
        waiter.resolve({
          ...(denyResponse ?? {
            type: "error",
            requestId,
            message: "permission denied by user",
          }),
          requestId,
        } as HostExecBrokerResponse);
        continue;
      }
      try {
        waiter.resolve(
          await this.runResolved(pending.request, pending.resolved),
        );
      } catch (error) {
        waiter.resolve({
          type: "error",
          requestId,
          message: (error as Error).message,
        });
      }
    }
  }

  private findGroupByRequestId(requestId: string): PendingGroup | null {
    const approvalKey = this.requestToApprovalKey.get(requestId);
    if (!approvalKey) return null;
    return this.groups.get(approvalKey) ?? null;
  }

  private async resolveRequest(
    message: ExecuteRequest,
  ): Promise<ResolvedExecution | null> {
    const argv0 = path.basename(message.argv0);
    const result = matchRule(
      this.config.rules,
      argv0,
      message.args,
      this.config.subcommand,
    );
    if (!result) return null;
    const { rule, subcommand } = result;

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
      subcommand,
      envVars,
      capability: {
        ruleId: rule.id,
        argv0,
        normalizedArgv: [argv0, ...message.args],
        normalizedSubcommand: subcommand,
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
    const hostEnv = Deno.env.toObject();
    const envVars: Record<string, string> = {};
    if (rule.inheritEnv.mode === "unsafe-inherit-all") {
      Object.assign(envVars, hostEnv);
    } else {
      for (const key of MINIMAL_ENV_KEYS) {
        const value = hostEnv[key];
        if (value !== undefined) envVars[key] = value;
      }
      envVars["PATH"] = envVars["PATH"] ?? DEFAULT_PATH;
    }
    for (const key of rule.inheritEnv.keys) {
      const value = hostEnv[key];
      if (value !== undefined) envVars[key] = value;
    }
    for (const [key, ref] of Object.entries(rule.env)) {
      const secretName = ref.slice("secret:".length);
      envVars[key] = await this.secretStore.require(secretName);
    }
    envVars["GIT_TERMINAL_PROMPT"] = envVars["GIT_TERMINAL_PROMPT"] ?? "0";
    return envVars;
  }

  private async runResolved(
    request: ExecuteRequest,
    resolved: ResolvedExecution,
  ): Promise<HostExecBrokerResponse> {
    const stdin = request.stdin
      ? Uint8Array.from(atob(request.stdin), (c) => c.charCodeAt(0))
      : undefined;
    const output = await new Deno.Command(request.argv0, {
      args: request.args,
      cwd: resolved.cwd,
      env: resolved.envVars,
      stdin: stdin ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    if (stdin) {
      const writer = output.stdin.getWriter();
      await writer.write(stdin);
      await writer.close();
    }
    const status = await output.output();
    const secretValues = Object.keys(resolved.rule.env)
      .map((key) => resolved.envVars[key])
      .filter((value): value is string =>
        typeof value === "string" && value !== ""
      );
    const stdout = redactSecrets(
      new TextDecoder().decode(status.stdout),
      secretValues,
    );
    const stderr = redactSecrets(
      new TextDecoder().decode(status.stderr),
      secretValues,
    );
    return {
      type: "result",
      requestId: request.requestId,
      exitCode: status.code,
      stdout,
      stderr,
    };
  }
}

export async function sendHostExecBrokerRequest<
  T extends HostExecBrokerResponse,
>(
  socketPath: string,
  message: HostExecBrokerMessage,
): Promise<T> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  try {
    await conn.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));
    const response = await readJsonLine(conn);
    if (!response) throw new Error("empty broker response");
    return JSON.parse(response) as T;
  } finally {
    conn.close();
  }
}

async function normalizeAllowedCwd(
  cwd: string,
  workspaceRoot: string,
  sessionTmpDir: string,
  rule: HostExecRule,
): Promise<string> {
  const normalized = await Deno.realPath(cwd).catch(() => path.resolve(cwd));
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
          resolveAllowEntry(entry, workspaceRoot, sessionTmpDir)
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

async function resolveAllowEntry(
  entry: string,
  workspaceRoot: string,
  sessionTmpDir: string,
): Promise<string> {
  if (entry.startsWith("workspace:")) {
    return path.resolve(workspaceRoot, entry.slice("workspace:".length));
  }
  if (entry.startsWith("session_tmp:")) {
    return path.resolve(sessionTmpDir, entry.slice("session_tmp:".length));
  }
  return await Deno.realPath(entry).catch(() => path.resolve(entry));
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function buildApprovalKey(
  capability: ResolvedExecutionCapability,
): Promise<string> {
  const data = canonicalJson(capability);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(digest)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
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
): HostExecPendingEntry {
  return {
    version: 1,
    sessionId: request.sessionId,
    requestId: request.requestId,
    approvalKey,
    ruleId: resolved.rule.id,
    argv0: request.argv0,
    args: request.args,
    subcommand: resolved.subcommand,
    cwd: resolved.cwd,
    state: "pending",
    createdAt,
    updatedAt: new Date().toISOString(),
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
    const newlineIndex = text.indexOf("\n");
    if (newlineIndex !== -1) {
      return text.slice(0, newlineIndex);
    }
  }
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

function redactSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function toErrorResponse(
  message: HostExecBrokerMessage,
  errorMessage: string,
): HostExecBrokerResponse {
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
