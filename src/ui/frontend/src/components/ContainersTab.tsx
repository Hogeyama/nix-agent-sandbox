import { Fragment } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { api, type ContainerInfo } from "../api.ts";
import { ContainerDetailPanel } from "./ContainerDetailPanel.tsx";
import {
  formatRelativeTime,
  isAckEligibleTurn,
  sortContainers,
} from "./containersHelpers.ts";
import {
  ackBtnStyle,
  ackedBtnStyle,
  attachBtnStyle,
  cleanBtnStyle,
  detailCellStyle,
  rowStyle,
  stopBtnStyle,
  tableStyle,
  tdNameStyle,
  tdPwdStyle,
  tdStyle,
  thStyle,
} from "./containersTab.styles.ts";
import { EditableSessionName } from "./EditableSessionName.tsx";
import { TurnCell } from "./TurnCell.tsx";

interface ContainersTabProps {
  containers: ContainerInfo[];
  onContainersChange: (items: ContainerInfo[]) => void;
  onAttach?: (sessionId: string) => void;
  onAckTurn?: (sessionId: string) => Promise<void> | void;
  onRename?: (sessionId: string, name: string) => Promise<void> | void;
  onNewSession?: () => void;
  dtachAvailable?: boolean;
  title?: string;
}

export function ContainersTab({
  containers,
  onContainersChange,
  onAttach,
  onAckTurn,
  onRename,
  onNewSession,
  dtachAvailable,
  title = "Sessions",
}: ContainersTabProps) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [acking, setAcking] = useState<Set<string>>(new Set());
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
        <div style={{ display: "flex", gap: "8px" }}>
          {dtachAvailable && onNewSession && (
            <button type="button" style={cleanBtnStyle} onClick={onNewSession}>
              New Session
            </button>
          )}
        </div>
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
