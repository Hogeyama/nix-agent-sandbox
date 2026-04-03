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

  useSSE("/api/events", handleSSE);

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "20px" }}>
      <h1 style={{ marginBottom: "20px", fontSize: "24px" }}>
        nas Dashboard
      </h1>

      <div style={{ display: "flex", gap: "4px", marginBottom: "20px" }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "8px 20px",
              border: "none",
              borderRadius: "6px 6px 0 0",
              cursor: "pointer",
              background: activeTab === tab.id ? "#1e293b" : "#0f172a",
              color: activeTab === tab.id ? "#38bdf8" : "#94a3b8",
              fontWeight: activeTab === tab.id ? "bold" : "normal",
              fontSize: "14px",
            }}
          >
            {tab.label}
            {tab.id === "pending" && totalPending > 0 && (
              <span style={badgeStyle}>{totalPending}</span>
            )}
          </button>
        ))}
      </div>

      <div
        style={{
          background: "#1e293b",
          borderRadius: "0 8px 8px 8px",
          padding: "20px",
          minHeight: "400px",
        }}
      >
        {activeTab === "pending" && (
          <PendingTab
            networkItems={networkPending}
            hostExecItems={hostExecPending}
            deepLink={deepLink}
          />
        )}
        {activeTab === "containers" && <ContainersTab />}
        {activeTab === "audit" && (
          <AuditTab items={auditLogs} sessions={sessions} />
        )}
      </div>
    </div>
  );
}

const badgeStyle = {
  marginLeft: "6px",
  background: "#ef4444",
  color: "white",
  borderRadius: "10px",
  padding: "1px 7px",
  fontSize: "12px",
};
