import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { PendingTab } from "./components/PendingTab.tsx";
import { ContainersTab } from "./components/ContainersTab.tsx";
import { AuditTab } from "./components/AuditTab.tsx";
import { useSSE } from "./hooks/useSSE.ts";
import { useFaviconBadge } from "./hooks/useFaviconBadge.ts";
import type {
  AuditLogEntry,
  HostExecPendingItem,
  NetworkPendingItem,
  SessionsData,
} from "./api.ts";

type TabId = "pending" | "containers" | "audit";

const TABS: { id: TabId; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "containers", label: "Containers" },
  { id: "audit", label: "Audit" },
];

export interface DeepLink {
  type: "network" | "hostexec";
  sessionId: string;
  requestId: string;
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>("pending");
  const [networkPending, setNetworkPending] = useState<NetworkPendingItem[]>(
    [],
  );
  const [hostExecPending, setHostExecPending] = useState<
    HostExecPendingItem[]
  >([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [sessions, setSessions] = useState<SessionsData>({
    network: [],
    hostexec: [],
  });

  const deepLink = useMemo<DeepLink | null>(() => {
    const params = new URLSearchParams(globalThis.location?.search ?? "");
    const type = params.get("type");
    const sessionId = params.get("sessionId");
    const requestId = params.get("requestId");
    if (
      (type === "network" || type === "hostexec") && sessionId && requestId
    ) {
      return { type, sessionId, requestId };
    }
    return null;
  }, []);

  useEffect(() => {
    if (deepLink) {
      setActiveTab("pending");
    }
  }, [deepLink]);

  const totalPending = networkPending.length + hostExecPending.length;

  useFaviconBadge(totalPending);

  const handleSSE = useCallback(
    (event: string, data: unknown) => {
      const d = data as Record<string, unknown>;
      switch (event) {
        case "network:pending":
          setNetworkPending(d.items as NetworkPendingItem[]);
          break;
        case "hostexec:pending":
          setHostExecPending(d.items as HostExecPendingItem[]);
          break;
        case "sessions":
          setSessions(d as unknown as SessionsData);
          break;
        case "audit:logs":
          setAuditLogs(d.items as AuditLogEntry[]);
          break;
      }
    },
    [],
  );

  const { connected } = useSSE("/api/events", handleSSE);

  return (
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="logo" aria-hidden="true"></div>
          <span class="name">nas</span>
          <span class="sub">· dashboard</span>
        </div>
        <div
          class={`status-dot${connected ? "" : " offline"}`}
          title={connected ? "Live" : "Disconnected — retrying…"}
        >
          {connected ? "live" : "offline"}
        </div>
      </header>

      <nav class="tabs" role="tablist">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const showBadge = tab.id === "pending" && totalPending > 0;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              class={`tab${isActive ? " active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              {showBadge && <span class="count">{totalPending}</span>}
            </button>
          );
        })}
      </nav>

      <div class="panel">
        {activeTab === "pending" && (
          <PendingTab
            networkItems={networkPending}
            hostExecItems={hostExecPending}
            deepLink={deepLink}
          />
        )}
        {activeTab === "containers" && <ContainersTab />}
        {activeTab === "audit" && (
          <AuditTab liveItems={auditLogs} sessions={sessions} />
        )}
      </div>
    </div>
  );
}
