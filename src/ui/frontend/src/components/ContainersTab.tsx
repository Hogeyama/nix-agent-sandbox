import { Fragment } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { api, type ContainerInfo } from "../api.ts";

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || isNaN(ms)) return "-";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}min ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h ago`;
}

// Sort priority: user-turn (0) → agent-turn (1) → done (2) → absent (3).
function turnPriority(turn: ContainerInfo["turn"]): number {
  switch (turn) {
    case "user-turn":
      return 0;
    case "agent-turn":
      return 1;
    case "done":
      return 2;
    default:
      return 3;
  }
}

function tieBreakTimestamp(c: ContainerInfo): number {
  const iso = c.lastEventAt ?? c.startedAt;
  const t = iso ? new Date(iso).getTime() : NaN;
  return isNaN(t) ? 0 : t;
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

export function sortContainers(items: ContainerInfo[]): ContainerInfo[] {
  return [...items].sort((a, b) => {
    const pa = turnPriority(a.turn);
    const pb = turnPriority(b.turn);
    if (pa !== pb) return pa - pb;
    // Most-recently-updated first within the same bucket.
    return tieBreakTimestamp(b) - tieBreakTimestamp(a);
  });
}

interface TurnCellProps {
  turn: ContainerInfo["turn"];
}

function TurnCell({ turn }: TurnCellProps) {
  if (turn === "user-turn") {
    return <span style={turnBadgeUserStyle}>You're up</span>;
  }
  if (turn === "agent-turn") {
    return <span style={turnBadgeAgentStyle}>Working</span>;
  }
  if (turn === "done") {
    return <span style={turnBadgeDoneStyle}>Done</span>;
  }
  return <span style={{ color: "#64748b" }}>-</span>;
}

interface ContainerDetailPanelProps {
  container: ContainerInfo;
}

function ContainerDetailPanel({ container: c }: ContainerDetailPanelProps) {
  if (c.turn === undefined) {
    return (
      <div style={detailPanelStyle}>
        <div style={detailMutedStyle}>
          No session data (sidecar container).
        </div>
      </div>
    );
  }

  const rawSession = {
    sessionId: c.sessionId,
    turn: c.turn,
    sessionAgent: c.sessionAgent,
    sessionProfile: c.sessionProfile,
    worktree: c.worktree,
    sessionStartedAt: c.sessionStartedAt,
    lastEventAt: c.lastEventAt,
    lastEventKind: c.lastEventKind,
    lastEventMessage: c.lastEventMessage,
  };

  const lastEventLabel = c.lastEventKind
    ? `${c.lastEventKind}${
      c.lastEventAt ? ` (${formatRelativeTime(c.lastEventAt)})` : ""
    }`
    : "-";

  return (
    <div style={detailPanelStyle}>
      {c.lastEventMessage
        ? <div style={lastMessageStyle}>{c.lastEventMessage}</div>
        : <div style={detailMutedStyle}>No recent message.</div>}

      <div style={kvGridStyle}>
        <div style={kvLabelStyle}>Session ID</div>
        <div style={kvValueStyle}>{c.sessionId ?? "-"}</div>
        <div style={kvLabelStyle}>Agent</div>
        <div style={kvValueStyle}>{c.sessionAgent ?? "-"}</div>
        <div style={kvLabelStyle}>Profile</div>
        <div style={kvValueStyle}>{c.sessionProfile ?? "-"}</div>
        {c.worktree && (
          <>
            <div style={kvLabelStyle}>Worktree</div>
            <div style={kvValueStyle}>{c.worktree}</div>
          </>
        )}
        <div style={kvLabelStyle}>Turn</div>
        <div style={kvValueStyle}>{c.turn}</div>
        <div style={kvLabelStyle}>Started at</div>
        <div style={kvValueStyle}>{formatDateTime(c.sessionStartedAt)}</div>
        <div style={kvLabelStyle}>Last event</div>
        <div style={kvValueStyle}>{lastEventLabel}</div>
      </div>

      <details style={rawDetailsStyle}>
        <summary style={rawSummaryStyle}>Raw session</summary>
        <pre style={rawPreStyle}>{JSON.stringify(rawSession, null, 2)}</pre>
      </details>
    </div>
  );
}

interface ContainersTabProps {
  containers: ContainerInfo[];
  onContainersChange: (items: ContainerInfo[]) => void;
}

export function ContainersTab(
  { containers, onContainersChange }: ContainersTabProps,
) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [cleaning, setCleaning] = useState(false);
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [, setTick] = useState(0);

  function toggleExpand(name: string) {
    setExpandedName((cur) => (cur === name ? null : name));
  }

  async function refresh() {
    try {
      const res = await api.getContainers();
      onContainersChange(res.items);
    } catch (e) {
      console.error("Failed to fetch containers:", e);
    }
  }

  // Update relative times every 30s
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const sorted = useMemo(() => sortContainers(containers), [containers]);

  async function handleStop(name: string) {
    setBusy((s) => new Set(s).add(name));
    try {
      await api.stopContainer(name);
      await refresh();
    } catch (e) {
      console.error("Stop failed:", e);
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(name);
        return next;
      });
    }
  }

  async function handleCleanAll() {
    setCleaning(true);
    try {
      const result = await api.cleanContainers();
      const parts: string[] = [];
      if (result.removedContainers.length > 0) {
        parts.push(`${result.removedContainers.length} container(s)`);
      }
      if (result.removedNetworks.length > 0) {
        parts.push(`${result.removedNetworks.length} network(s)`);
      }
      if (result.removedVolumes.length > 0) {
        parts.push(`${result.removedVolumes.length} volume(s)`);
      }
      if (parts.length > 0) {
        console.log(`Cleaned: ${parts.join(", ")}`);
      }
      await refresh();
    } catch (e) {
      console.error("Clean failed:", e);
    } finally {
      setCleaning(false);
    }
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: "16px",
        }}
      >
        <h3 style={{ fontSize: "16px", color: "#cbd5e1" }}>
          NAS Managed Containers ({sorted.length})
        </h3>
        <button
          style={cleanBtnStyle}
          disabled={cleaning}
          onClick={handleCleanAll}
        >
          {cleaning ? "Cleaning..." : "Clean All"}
        </button>
      </div>

      {sorted.length === 0
        ? <p style={{ color: "#94a3b8" }}>No nas-managed containers found.</p>
        : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Turn</th>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Kind</th>
                <th style={thStyle}>Uptime</th>
                <th style={thStyle}>PWD</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => {
                const kind = c.labels["nas.kind"] || "-";
                const pwd = kind === "agent"
                  ? (c.labels["nas.pwd"] || "-")
                  : "";
                const isExpanded = expandedName === c.name;
                return (
                  <Fragment key={c.name}>
                    <tr
                      style={rowStyle}
                      onClick={() => toggleExpand(c.name)}
                    >
                      <td style={tdStyle}>
                        <TurnCell turn={c.turn} />
                      </td>
                      <td style={tdStyle}>{c.name}</td>
                      <td style={tdStyle}>
                        <span
                          style={{
                            color: c.running ? "#22c55e" : "#94a3b8",
                          }}
                        >
                          {c.running ? "running" : "stopped"}
                        </span>
                      </td>
                      <td style={tdStyle}>{kind}</td>
                      <td style={tdStyle}>
                        {c.running && c.startedAt
                          ? formatRelativeTime(c.startedAt)
                          : "-"}
                      </td>
                      <td style={tdPwdStyle}>{pwd}</td>
                      <td style={tdStyle}>
                        {c.running && (
                          <button
                            style={stopBtnStyle}
                            disabled={busy.has(c.name)}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStop(c.name);
                            }}
                          >
                            Stop
                          </button>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={7} style={detailCellStyle}>
                          <ContainerDetailPanel container={c} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
    </div>
  );
}

const tableStyle = { width: "100%", borderCollapse: "collapse" as const };
const thStyle = {
  textAlign: "left" as const,
  padding: "8px",
  borderBottom: "1px solid #334155",
  color: "#94a3b8",
  fontSize: "12px",
  textTransform: "uppercase" as const,
};
const rowStyle = { cursor: "pointer" as const };
const tdStyle = { padding: "8px", borderBottom: "1px solid #1e293b" };
const detailCellStyle = {
  padding: "0",
  borderBottom: "1px solid #1e293b",
  background: "#0f172a",
};
const detailPanelStyle = {
  padding: "12px 16px",
  display: "flex",
  flexDirection: "column" as const,
  gap: "12px",
};
const detailMutedStyle = { color: "#64748b", fontStyle: "italic" as const };
const lastMessageStyle = {
  fontSize: "15px",
  color: "#e2e8f0",
  padding: "8px 12px",
  background: "#1e293b",
  borderLeft: "3px solid #6366f1",
  borderRadius: "4px",
  whiteSpace: "pre-wrap" as const,
};
const kvGridStyle = {
  display: "grid",
  gridTemplateColumns: "140px 1fr",
  rowGap: "4px",
  columnGap: "12px",
  fontSize: "13px",
};
const kvLabelStyle = {
  color: "#94a3b8",
  textTransform: "uppercase" as const,
  fontSize: "11px",
};
const kvValueStyle = {
  color: "#cbd5e1",
  wordBreak: "break-all" as const,
};
const rawDetailsStyle = {
  marginTop: "4px",
  fontSize: "12px",
};
const rawSummaryStyle = {
  color: "#64748b",
  cursor: "pointer" as const,
  userSelect: "none" as const,
};
const rawPreStyle = {
  marginTop: "6px",
  padding: "8px",
  background: "#020617",
  color: "#94a3b8",
  fontSize: "11px",
  borderRadius: "4px",
  overflow: "auto" as const,
  maxHeight: "200px",
};
const tdPwdStyle = {
  ...tdStyle,
  maxWidth: "200px",
  overflow: "hidden" as const,
  textOverflow: "ellipsis" as const,
  whiteSpace: "nowrap" as const,
  fontSize: "13px",
  color: "#94a3b8",
};
const stopBtnStyle = {
  background: "#f59e0b",
  color: "white",
  border: "none",
  borderRadius: "4px",
  padding: "4px 12px",
  cursor: "pointer",
};
const cleanBtnStyle = {
  background: "#6366f1",
  color: "white",
  border: "none",
  borderRadius: "6px",
  padding: "6px 16px",
  cursor: "pointer",
  fontSize: "14px",
};

const turnBadgeBaseStyle = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "10px",
  fontSize: "12px",
  lineHeight: "16px",
  whiteSpace: "nowrap" as const,
};
const turnBadgeUserStyle = {
  ...turnBadgeBaseStyle,
  background: "#fbbf24",
  color: "#1f2937",
  fontWeight: "bold" as const,
};
const turnBadgeAgentStyle = {
  ...turnBadgeBaseStyle,
  background: "#334155",
  color: "#cbd5e1",
};
const turnBadgeDoneStyle = {
  ...turnBadgeBaseStyle,
  background: "transparent",
  color: "#64748b",
  fontSize: "11px",
  padding: "2px 6px",
};
