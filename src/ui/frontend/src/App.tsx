import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import {
  type AuditLogEntry,
  api,
  type ContainerInfo,
  type HostExecPendingItem,
  type NetworkPendingItem,
  type SessionsData,
} from "./api.ts";
import { AuditTab } from "./components/AuditTab.tsx";
import { ContainersTab } from "./components/ContainersTab.tsx";
import { PendingTab } from "./components/PendingTab.tsx";
import { TerminalModal } from "./components/TerminalModal.tsx";
import { useFaviconBadge } from "./hooks/useFaviconBadge.ts";
import { useSSE } from "./hooks/useSSE.ts";

type TabId = "pending" | "sessions" | "audit" | "sidecars";

const TABS: { id: TabId; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "sessions", label: "Sessions" },
  { id: "audit", label: "Audit" },
  { id: "sidecars", label: "Sidecars" },
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
  const [hostExecPending, setHostExecPending] = useState<HostExecPendingItem[]>(
    [],
  );
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [sessions, setSessions] = useState<SessionsData>({
    network: [],
    hostexec: [],
  });
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [termSessionId, setTermSessionId] = useState<string | null>(null);
  const [termVisible, setTermVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getContainers()
      .then((res) => {
        if (!cancelled) setContainers(res.items);
      })
      .catch((e) => {
        console.error("Failed to fetch containers:", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const deepLink = useMemo<DeepLink | null>(() => {
    const params = new URLSearchParams(globalThis.location?.search ?? "");
    const type = params.get("type");
    const sessionId = params.get("sessionId");
    const requestId = params.get("requestId");
    if ((type === "network" || type === "hostexec") && sessionId && requestId) {
      return { type, sessionId, requestId };
    }
    return null;
  }, []);

  useEffect(() => {
    if (deepLink) {
      setActiveTab("pending");
    }
  }, [deepLink]);

  const SIDECAR_KINDS = new Set(["dind", "proxy", "envoy"]);
  const sessionContainers = containers.filter(
    (c) => !SIDECAR_KINDS.has(c.labels["nas.kind"] ?? ""),
  );
  const sidecarContainers = containers.filter((c) =>
    SIDECAR_KINDS.has(c.labels["nas.kind"] ?? ""),
  );

  const totalPending = networkPending.length + hostExecPending.length;
  const userTurnCount = sessionContainers.filter(
    (c) => c.turn === "user-turn",
  ).length;

  useFaviconBadge(totalPending, userTurnCount);

  const handleAttach = useCallback((sessionId: string) => {
    setTermSessionId(sessionId);
    setTermVisible(true);
  }, []);

  const handleAckTurn = useCallback(async (sessionId: string) => {
    try {
      const { item } = await api.ackSessionTurn(sessionId);
      setContainers((current) =>
        current.map((container) =>
          container.sessionId === sessionId
            ? {
                ...container,
                turn: item.turn,
                lastEventAt: item.lastEventAt,
                lastEventKind: item.lastEventKind,
                lastEventMessage: item.lastEventMessage,
              }
            : container,
        ),
      );
    } catch (e) {
      console.error("Failed to acknowledge turn:", e);
    }
  }, []);

  const handleTermClose = useCallback(() => {
    setTermSessionId(null);
    setTermVisible(false);
  }, []);

  const handleTermMinimize = useCallback(() => {
    setTermVisible(false);
  }, []);

  const handleTermRestore = useCallback(() => {
    setTermVisible(true);
  }, []);

  const handleSSE = useCallback((event: string, data: unknown) => {
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
      case "containers":
        setContainers(d.items as ContainerInfo[]);
        break;
    }
  }, []);

  const { connected } = useSSE("/api/events", handleSSE);
  const activeTermContainer = useMemo(
    () =>
      termSessionId
        ? containers.find((container) => container.sessionId === termSessionId)
        : undefined,
    [containers, termSessionId],
  );
  const terminalCanAckTurn = activeTermContainer?.turn === "user-turn";
  const terminalTurnAcked = activeTermContainer?.turn === "ack-turn";

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

      <nav class="tabs">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const badge: { count: number; warn?: boolean } | null =
            tab.id === "pending" && totalPending > 0
              ? { count: totalPending }
              : tab.id === "sessions" && userTurnCount > 0
                ? { count: userTurnCount, warn: true }
                : null;
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
              {badge && (
                <span class={`count${badge.warn ? " warn" : ""}`}>
                  {badge.count}
                </span>
              )}
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
        {activeTab === "sessions" && (
          <ContainersTab
            containers={sessionContainers}
            onContainersChange={setContainers}
            onAttach={handleAttach}
            onAckTurn={handleAckTurn}
          />
        )}
        {activeTab === "audit" && (
          <AuditTab liveItems={auditLogs} sessions={sessions} />
        )}
        {activeTab === "sidecars" && (
          <ContainersTab
            containers={sidecarContainers}
            onContainersChange={setContainers}
            title="Sidecars"
          />
        )}
      </div>

      {termSessionId && (
        <TerminalModal
          key={termSessionId}
          sessionId={termSessionId}
          visible={termVisible}
          onClose={handleTermClose}
          onAckTurn={handleAckTurn}
          canAckTurn={terminalCanAckTurn}
          turnAcked={terminalTurnAcked}
          onMinimize={handleTermMinimize}
        />
      )}

      {termSessionId && !termVisible && (
        <div class="terminal-minimized-bar" onClick={handleTermRestore}>
          <span class="chip chip-good">terminal</span>
          <code>{termSessionId}</code>
          <span class="terminal-minimized-restore">Restore</span>
        </div>
      )}
    </div>
  );
}
