import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import {
  type AuditLogEntry,
  api,
  type ContainerInfo,
  type DtachSession,
  type HostExecPendingItem,
  type NetworkPendingItem,
  type SessionsData,
} from "./api.ts";
import { AuditTab } from "./components/AuditTab.tsx";
import { ContainersTab } from "./components/ContainersTab.tsx";
import { NewSessionDialog } from "./components/NewSessionDialog.tsx";
import { PendingTab } from "./components/PendingTab.tsx";
import { TerminalModal } from "./components/TerminalModal.tsx";
import { useFaviconBadge } from "./hooks/useFaviconBadge.ts";
import { useSSE } from "./hooks/useSSE.ts";
import { buildTerminalSessionTabs } from "./terminalSessions.ts";

type TabId = "pending" | "sessions" | "audit" | "sidecars";

const TABS: { id: TabId; label: string }[] = [
  { id: "sessions", label: "Sessions" },
  { id: "pending", label: "Pending" },
  { id: "audit", label: "Audit" },
  { id: "sidecars", label: "Sidecars" },
];

export interface DeepLink {
  type: "network" | "hostexec";
  sessionId: string;
  requestId: string;
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>("sessions");
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
  const [dtachSessions, setDtachSessions] = useState<DtachSession[]>([]);
  const [openTermSessionIds, setOpenTermSessionIds] = useState<string[]>([]);
  const [activeTermSessionId, setActiveTermSessionId] = useState<string | null>(
    null,
  );
  const [termVisible, setTermVisible] = useState(false);
  const [dtachAvailable, setDtachAvailable] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getLaunchInfo()
      .then((info) => {
        if (!cancelled) setDtachAvailable(info.dtachAvailable);
      })
      .catch(() => {
        setDtachAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  useEffect(() => {
    let cancelled = false;
    api
      .getTerminalSessions()
      .then((res) => {
        if (!cancelled) setDtachSessions(res.items);
      })
      .catch((e) => {
        console.error("Failed to fetch terminal sessions:", e);
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
    setOpenTermSessionIds((current) =>
      current.includes(sessionId) ? current : [...current, sessionId],
    );
    setActiveTermSessionId(sessionId);
    setTermVisible(true);
  }, []);

  const handleShell = useCallback(async (containerName: string) => {
    try {
      const { dtachSessionId } = await api.startShell(containerName);
      // Optimistically register the new session so the reconciliation
      // effect keyed on availableTerminalIds does not drop it (and reset
      // activeTermSessionId to the first tab) while we wait for the SSE
      // `terminal:sessions` event to catch up.
      setDtachSessions((current) =>
        current.some((session) => session.sessionId === dtachSessionId)
          ? current
          : [
              ...current,
              {
                name: dtachSessionId,
                sessionId: dtachSessionId,
                socketPath: "",
                createdAt: Math.floor(Date.now() / 1000),
              },
            ],
      );
      setOpenTermSessionIds((current) =>
        current.includes(dtachSessionId)
          ? current
          : [...current, dtachSessionId],
      );
      setActiveTermSessionId(dtachSessionId);
      setTermVisible(true);
    } catch (e) {
      console.error("Failed to start shell:", e);
    }
  }, []);

  const handleTerminalShell = useCallback(
    (sessionId: string) => {
      const container = containers.find((c) => c.sessionId === sessionId);
      if (!container) {
        console.error(
          `Cannot open shell: no container found for session ${sessionId}`,
        );
        return;
      }
      void handleShell(container.name);
    },
    [containers, handleShell],
  );

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

  const handleRename = useCallback(async (sessionId: string, name: string) => {
    try {
      await api.renameSession(sessionId, name);
      setContainers((current) =>
        current.map((container) =>
          container.sessionId === sessionId
            ? { ...container, sessionName: name }
            : container,
        ),
      );
    } catch (e) {
      console.error("Failed to rename session:", e);
    }
  }, []);

  const handleTermMinimize = useCallback(() => {
    setTermVisible(false);
  }, []);

  const handleNewSession = useCallback(() => {
    setNewSessionOpen(true);
  }, []);

  const handleSessionLaunched = useCallback((_sessionId: string) => {
    setNewSessionOpen(false);
  }, []);

  const handleTermRestore = useCallback(() => {
    setActiveTermSessionId(
      (current) => current ?? openTermSessionIds[0] ?? null,
    );
    setTermVisible(true);
  }, [openTermSessionIds]);

  const handleTermSelect = useCallback((sessionId: string) => {
    setOpenTermSessionIds((current) =>
      current.includes(sessionId) ? current : [...current, sessionId],
    );
    setActiveTermSessionId(sessionId);
    setTermVisible(true);
  }, []);

  const handleTermClose = useCallback((sessionId: string) => {
    setOpenTermSessionIds((current) => {
      const next = current.filter((id) => id !== sessionId);
      setActiveTermSessionId((activeCurrent) => {
        if (activeCurrent === sessionId) {
          return next[0] ?? null;
        }
        return activeCurrent && next.includes(activeCurrent)
          ? activeCurrent
          : (next[0] ?? null);
      });
      if (next.length === 0) {
        setTermVisible(false);
      }
      return next;
    });
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
      case "terminal:sessions":
        setDtachSessions(d.items as DtachSession[]);
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
  const terminalMetadataCandidates = useMemo(
    () =>
      sessionContainers.filter(
        (container): container is ContainerInfo & { sessionId: string } =>
          typeof container.sessionId === "string",
      ),
    [sessionContainers],
  );
  const availableTerminalIds = useMemo(
    () => dtachSessions.map((session) => session.sessionId),
    [dtachSessions],
  );
  useEffect(() => {
    const availableIds = new Set(availableTerminalIds);
    setOpenTermSessionIds((current) => {
      const next = current.filter((id) => availableIds.has(id));
      const unchanged =
        next.length === current.length &&
        next.every((sessionId, index) => sessionId === current[index]);
      setActiveTermSessionId((activeCurrent) =>
        activeCurrent && availableIds.has(activeCurrent)
          ? activeCurrent
          : (next[0] ?? null),
      );
      if (next.length === 0) {
        setTermVisible(false);
      }
      return unchanged ? current : next;
    });
  }, [availableTerminalIds]);
  const terminalSessions = useMemo(() => {
    return buildTerminalSessionTabs(
      openTermSessionIds,
      dtachSessions,
      terminalMetadataCandidates,
    );
  }, [dtachSessions, openTermSessionIds, terminalMetadataCandidates]);
  const activeTerminalLabel = useMemo(() => {
    if (!activeTermSessionId) return null;
    const activeSession = terminalSessions.find(
      (session) => session.sessionId === activeTermSessionId,
    );
    return activeSession?.sessionName || activeTermSessionId;
  }, [activeTermSessionId, terminalSessions]);

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
            onShell={handleShell}
            onAckTurn={handleAckTurn}
            onRename={handleRename}
            onNewSession={handleNewSession}
            dtachAvailable={dtachAvailable}
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

      <NewSessionDialog
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        onLaunched={handleSessionLaunched}
      />

      {terminalSessions.length > 0 && activeTermSessionId && (
        <TerminalModal
          sessions={terminalSessions}
          activeSessionId={activeTermSessionId}
          visible={termVisible}
          onSelectSession={handleTermSelect}
          onCloseSession={handleTermClose}
          onRenameSession={handleRename}
          onAckTurn={handleAckTurn}
          onShell={handleTerminalShell}
          onMinimize={handleTermMinimize}
        />
      )}

      {openTermSessionIds.length > 0 && !termVisible && (
        <button
          type="button"
          class="terminal-minimized-bar"
          onClick={handleTermRestore}
        >
          <span class="chip chip-good">
            terminal
            {openTermSessionIds.length > 1
              ? ` +${openTermSessionIds.length - 1}`
              : ""}
          </span>
          <code>{activeTerminalLabel || openTermSessionIds[0]}</code>
          <span class="terminal-minimized-restore">Restore</span>
        </button>
      )}
    </div>
  );
}
