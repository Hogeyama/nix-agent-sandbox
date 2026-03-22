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

export const api = {
  getNetworkPending: () =>
    request<{ items: NetworkPendingItem[] }>("GET", "/api/network/pending"),
  approveNetwork: (sessionId: string, requestId: string, scope?: string) =>
    request("POST", "/api/network/approve", { sessionId, requestId, scope }),
  denyNetwork: (sessionId: string, requestId: string) =>
    request("POST", "/api/network/deny", { sessionId, requestId }),

  getHostExecPending: () =>
    request<{ items: HostExecPendingItem[] }>("GET", "/api/hostexec/pending"),
  approveHostExec: (sessionId: string, requestId: string, scope?: string) =>
    request("POST", "/api/hostexec/approve", { sessionId, requestId, scope }),
  denyHostExec: (sessionId: string, requestId: string) =>
    request("POST", "/api/hostexec/deny", { sessionId, requestId }),

  getSessions: () =>
    request<SessionsData>("GET", "/api/sessions"),

  getContainers: () =>
    request<{ items: ContainerInfo[] }>("GET", "/api/containers"),
  stopContainer: (name: string) =>
    request("POST", `/api/containers/${encodeURIComponent(name)}/stop`),
  cleanContainers: () =>
    request<ContainerCleanResult>("POST", "/api/containers/clean"),
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
}

export interface HostExecSession {
  sessionId: string;
  profileName: string;
  createdAt: string;
  pid: number;
  brokerSocket: string;
}

export interface SessionsData {
  network: NetworkSession[];
  hostexec: HostExecSession[];
}

export interface ContainerInfo {
  name: string;
  running: boolean;
  labels: Record<string, string>;
}

export interface ContainerCleanResult {
  removedContainers: string[];
  removedNetworks: string[];
  removedVolumes: string[];
}
