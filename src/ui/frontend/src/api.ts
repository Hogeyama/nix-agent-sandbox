const BASE = "";

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export interface SessionTurnRecord {
  sessionId: string;
  turn: "user-turn" | "ack-turn" | "agent-turn" | "done";
  lastEventAt: string;
  lastEventKind?: "start" | "attention" | "ack" | "stop";
  lastEventMessage?: string;
}

export const api = {
  getNetworkPending: () =>
    request<{ items: NetworkPendingItem[] }>("GET", "/api/network/pending"),
  approveNetwork: (sessionId: string, requestId: string, scope?: string) =>
    request("POST", "/api/network/approve", { sessionId, requestId, scope }),
  denyNetwork: (sessionId: string, requestId: string, scope?: string) =>
    request("POST", "/api/network/deny", { sessionId, requestId, scope }),

  getHostExecPending: () =>
    request<{ items: HostExecPendingItem[] }>("GET", "/api/hostexec/pending"),
  approveHostExec: (sessionId: string, requestId: string, scope?: string) =>
    request("POST", "/api/hostexec/approve", { sessionId, requestId, scope }),
  denyHostExec: (sessionId: string, requestId: string) =>
    request("POST", "/api/hostexec/deny", { sessionId, requestId }),

  getSessions: () => request<SessionsData>("GET", "/api/sessions"),
  ackSessionTurn: (sessionId: string) =>
    request<{ item: SessionTurnRecord }>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/ack`,
    ),
  renameSession: (sessionId: string, name: string) =>
    request<{ item: SessionTurnRecord }>(
      "PATCH",
      `/api/sessions/${encodeURIComponent(sessionId)}/name`,
      { name },
    ),

  getContainers: () =>
    request<{ items: ContainerInfo[] }>("GET", "/api/containers"),
  stopContainer: (name: string) =>
    request("POST", `/api/containers/${encodeURIComponent(name)}/stop`),
  cleanContainers: () =>
    request<ContainerCleanResult>("POST", "/api/containers/clean"),

  getTerminalSessions: () =>
    request<{ items: DtachSession[] }>("GET", "/api/terminal/sessions"),

  getAuditLogs: (params?: {
    domain?: string;
    /** Restrict to entries whose sessionId is a member of this set. */
    sessionIds?: string[];
    /** Substring match on sessionId (case-insensitive). */
    sessionContains?: string;
    limit?: number;
    /** ISO-8601 timestamp cursor — return entries strictly older than this. */
    before?: string;
  }) => {
    const q = new URLSearchParams();
    if (params?.domain) q.set("domain", params.domain);
    if (params?.sessionIds !== undefined) {
      q.set("sessions", params.sessionIds.join(","));
    }
    if (params?.sessionContains) {
      q.set("sessionContains", params.sessionContains);
    }
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.before) q.set("before", params.before);
    const qs = q.toString();
    return request<{ items: AuditLogEntry[] }>(
      "GET",
      `/api/audit${qs ? `?${qs}` : ""}`,
    );
  },
};

// Types matching backend responses

export interface NetworkPendingItem {
  sessionId: string;
  requestId: string;
  target: { host: string; port: number };
  method: string;
  requestKind: string;
  state: string;
  createdAt: string;
}

export interface HostExecPendingItem {
  sessionId: string;
  requestId: string;
  approvalKey: string;
  ruleId: string;
  argv0: string;
  args: string[];
  cwd: string;
  state: string;
  createdAt: string;
}

export interface NetworkSession {
  sessionId: string;
  profileName: string;
  createdAt: string;
  pid: number;
  promptEnabled: boolean;
  brokerSocket: string;
  allowlist: string[];
  agent?: string;
}

export interface HostExecSession {
  sessionId: string;
  profileName: string;
  createdAt: string;
  pid: number;
  brokerSocket: string;
  agent?: string;
}

export interface SessionsData {
  network: NetworkSession[];
  hostexec: HostExecSession[];
}

export interface ContainerInfo {
  name: string;
  running: boolean;
  labels: Record<string, string>;
  startedAt: string;
  // Session-derived fields — populated by the backend when a container
  // carries a `nas.session_id` label matching a live session record.
  sessionId?: string;
  sessionName?: string;
  turn?: "user-turn" | "ack-turn" | "agent-turn" | "done";
  sessionAgent?: string;
  sessionProfile?: string;
  worktree?: string;
  sessionStartedAt?: string;
  lastEventAt?: string;
  lastEventKind?: "start" | "attention" | "ack" | "stop";
  lastEventMessage?: string;
}

export interface ContainerCleanResult {
  removedContainers: string[];
  removedNetworks: string[];
  removedVolumes: string[];
}

export interface DtachSession {
  name: string;
  sessionId: string;
  socketPath: string;
  createdAt: number;
}

export type AuditDomain = "network" | "hostexec";
export type AuditDecision = "allow" | "deny";

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  domain: AuditDomain;
  sessionId: string;
  requestId: string;
  decision: AuditDecision;
  reason: string;
  scope?: string;
  target?: string;
  command?: string;
}
