import { Fragment } from "preact";
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

function isAckEligibleTurn(turn: ContainerInfo["turn"]): boolean {
  return turn === "user-turn" || turn === "ack-turn";
}

function startedTimestamp(c: ContainerInfo): number {
  const iso = c.sessionStartedAt ?? c.startedAt;
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

export function sortContainers(items: ContainerInfo[]): ContainerInfo[] {
  return [...items].sort((a, b) => {
    // Most-recently-started first.
    return startedTimestamp(b) - startedTimestamp(a);
  });
}

interface TurnCellProps {
  turn: ContainerInfo["turn"];
}

function TurnCell({ turn }: TurnCellProps) {
  if (turn === "user-turn") {
    return <span style={turnBadgeUserStyle}>Your turn</span>;
  }
  if (turn === "ack-turn") {
    return <span style={turnBadgeAckStyle}>Thinking (ACK)</span>;
  }
  if (turn === "agent-turn") {
    return <span style={turnBadgeAgentStyle}>Agent working</span>;
  }
  if (turn === "done") {
    return <span style={turnBadgeDoneStyle}>Done</span>;
  }
  return <span style={{ color: "#64748b" }}>-</span>;
}

interface ContainerDetailPanelProps {
  container: ContainerInfo;
}

function EditableSessionName({
  sessionId,
  currentName,
  fallbackName,
  onRename,
}: {
  sessionId: string;
  currentName?: string;
  fallbackName?: string;
  onRename?: (sessionId: string, name: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentName ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!onRename || !value.trim()) return;
    setSaving(true);
    try {
      await onRename(sessionId, value.trim());
      setEditing(false);
    } catch (e) {
      console.error("Rename failed:", e);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <span
        style={{ cursor: "pointer", borderBottom: "1px dashed #475569" }}
        onClick={(e) => {
          e.stopPropagation();
          setValue(currentName ?? "");
          setEditing(true);
        }}
      >
        {currentName || fallbackName || (
          <span style={{ color: "#64748b" }}>-</span>
        )}
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
      <input
        type="text"
        value={value}
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleSave();
          if (e.key === "Escape") setEditing(false);
        }}
        onClick={(e) => e.stopPropagation()}
        disabled={saving}
        style={nameInputStyle}
        // biome-ignore lint/a11y/noAutofocus: intentional for inline edit
        autoFocus
      />
      <button
        type="button"
        style={nameSaveBtnStyle}
        disabled={saving || !value.trim()}
        onClick={(e) => {
          e.stopPropagation();
          void handleSave();
        }}
      >
        {saving ? "..." : "OK"}
      </button>
      <button
        type="button"
        style={nameCancelBtnStyle}
        disabled={saving}
        onClick={(e) => {
          e.stopPropagation();
          setEditing(false);
        }}
      >
        Cancel
      </button>
    </span>
  );
}

function ContainerDetailPanel({ container: c }: ContainerDetailPanelProps) {
  if (c.turn === undefined) {
    return (
      <div style={detailPanelStyle}>
        <div style={detailMutedStyle}>No session data (sidecar container).</div>
      </div>
    );
  }

  const rawSession = {
    sessionId: c.sessionId,
    sessionName: c.sessionName,
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
      {c.lastEventMessage ? (
        <div style={lastMessageStyle}>{c.lastEventMessage}</div>
      ) : (
        <div style={detailMutedStyle}>No recent message.</div>
      )}

      <div style={kvGridStyle}>
        <div style={kvLabelStyle}>Name</div>
        <div style={kvValueStyle}>{c.sessionName || "-"}</div>
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
  onAttach?: (sessionId: string) => void;
  onAckTurn?: (sessionId: string) => Promise<void> | void;
  onRename?: (sessionId: string, name: string) => Promise<void> | void;
  title?: string;
}

export function ContainersTab({
  containers,
  onContainersChange,
  onAttach,
  onAckTurn,
  onRename,
  title = "Sessions",
}: ContainersTabProps) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [acking, setAcking] = useState<Set<string>>(new Set());
  const [cleaning, setCleaning] = useState(false);
  const [expandedNames, setExpandedNames] = useState<Set<string>>(new Set());
  const [, setTick] = useState(0);

  function toggleExpand(name: string) {
    setExpandedNames((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
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

  async function handleAck(sessionId: string) {
    if (!onAckTurn) return;
    setAcking((current) => new Set(current).add(sessionId));
    try {
      await onAckTurn(sessionId);
    } catch (e) {
      console.error("ACK failed:", e);
    } finally {
      setAcking((current) => {
        const next = new Set(current);
        next.delete(sessionId);
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
          {title} ({sorted.length})
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
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Name</th>
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
              const isExpanded = expandedNames.has(c.name);
              const sessionId = c.sessionId;
              return (
                <Fragment key={c.name}>
                  <tr style={rowStyle} onClick={() => toggleExpand(c.name)}>
                    <td style={tdStyle}>
                      <TurnCell turn={c.turn} />
                    </td>
                    <td style={tdNameStyle}>
                      <span style={{ flexGrow: 1 }}>
                        {sessionId ? (
                          <EditableSessionName
                            sessionId={sessionId}
                            currentName={c.sessionName}
                            fallbackName={c.name}
                            onRename={onRename}
                          />
                        ) : (
                          c.name
                        )}
                      </span>
                      {c.running && sessionId && (
                        <>
                          {isAckEligibleTurn(c.turn) && (
                            <button
                              type="button"
                              style={
                                c.turn === "ack-turn"
                                  ? ackedBtnStyle
                                  : ackBtnStyle
                              }
                              disabled={
                                c.turn === "ack-turn" || acking.has(sessionId)
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleAck(sessionId);
                              }}
                            >
                              {c.turn === "ack-turn"
                                ? "ACKed"
                                : acking.has(sessionId)
                                  ? "ACK..."
                                  : "ACK"}
                            </button>
                          )}
                          <button
                            type="button"
                            style={attachBtnStyle}
                            onClick={(e) => {
                              e.stopPropagation();
                              onAttach?.(sessionId);
                            }}
                          >
                            Attach
                          </button>
                        </>
                      )}
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
                      <td colSpan={6} style={detailCellStyle}>
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
const tdNameStyle = {
  ...tdStyle,
  display: "flex" as const,
  alignItems: "center" as const,
  gap: "8px",
  whiteSpace: "nowrap" as const,
};
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
const attachBtnStyle = {
  background: "rgba(124, 196, 255, 0.2)",
  color: "#9dd2ff",
  border: "1px solid rgba(124, 196, 255, 0.4)",
  borderRadius: "4px",
  padding: "4px 12px",
  cursor: "pointer",
};
const ackBtnStyle = {
  background: "rgba(148, 163, 184, 0.2)",
  color: "#cbd5e1",
  border: "1px solid rgba(148, 163, 184, 0.45)",
  borderRadius: "4px",
  padding: "4px 10px",
  cursor: "pointer",
};
const ackedBtnStyle = {
  ...ackBtnStyle,
  background: "rgba(99, 102, 241, 0.2)",
  color: "#c7d2fe",
  border: "1px solid rgba(129, 140, 248, 0.45)",
  cursor: "default",
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

const nameInputStyle = {
  background: "#1e293b",
  color: "#e2e8f0",
  border: "1px solid #475569",
  borderRadius: "3px",
  padding: "2px 6px",
  fontSize: "13px",
  width: "140px",
};
const nameSaveBtnStyle = {
  background: "rgba(99, 102, 241, 0.3)",
  color: "#c7d2fe",
  border: "1px solid rgba(129, 140, 248, 0.45)",
  borderRadius: "3px",
  padding: "2px 8px",
  cursor: "pointer",
  fontSize: "12px",
};
const nameCancelBtnStyle = {
  background: "transparent",
  color: "#94a3b8",
  border: "1px solid #475569",
  borderRadius: "3px",
  padding: "2px 8px",
  cursor: "pointer",
  fontSize: "12px",
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
const turnBadgeAckStyle = {
  ...turnBadgeBaseStyle,
  background: "rgba(148, 163, 184, 0.22)",
  color: "#cbd5e1",
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
