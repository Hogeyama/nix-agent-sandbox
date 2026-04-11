import { useEffect, useMemo, useState } from "preact/hooks";
import { api, type ContainerInfo } from "../api.ts";

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || Number.isNaN(ms)) return "-";
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
  return Number.isNaN(t) ? 0 : t;
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

interface ContainersTabProps {
  containers: ContainerInfo[];
  onContainersChange: (items: ContainerInfo[]) => void;
}

export function ContainersTab({
  containers,
  onContainersChange,
}: ContainersTabProps) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [cleaning, setCleaning] = useState(false);
  const [, setTick] = useState(0);

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
          type="button"
          style={cleanBtnStyle}
          disabled={cleaning}
          onClick={handleCleanAll}
        >
          {cleaning ? "Cleaning..." : "Clean All"}
        </button>
      </div>

      {sorted.length === 0 ? (
        <p style={{ color: "#94a3b8" }}>No nas-managed containers found.</p>
      ) : (
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
              const pwd = kind === "agent" ? c.labels["nas.pwd"] || "-" : "";
              return (
                <tr key={c.name}>
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
                        type="button"
                        style={stopBtnStyle}
                        disabled={busy.has(c.name)}
                        onClick={() => handleStop(c.name)}
                      >
                        Stop
                      </button>
                    )}
                  </td>
                </tr>
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
const tdStyle = { padding: "8px", borderBottom: "1px solid #1e293b" };
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
