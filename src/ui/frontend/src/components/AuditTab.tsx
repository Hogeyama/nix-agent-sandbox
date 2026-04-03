import { useMemo, useState } from "preact/hooks";
import type { AuditLogEntry, SessionsData } from "../api.ts";

export interface AuditTabProps {
  items: AuditLogEntry[];
  sessions: SessionsData;
}

export function AuditTab({ items, sessions }: AuditTabProps) {
  const [domainFilter, setDomainFilter] = useState<string>("all");
  const [sessionFilter, setSessionFilter] = useState<string>("");
  const [activeOnly, setActiveOnly] = useState<boolean>(true);

  const activeSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of sessions.network) ids.add(s.sessionId);
    for (const s of sessions.hostexec) ids.add(s.sessionId);
    return ids;
  }, [sessions]);

  const filtered = useMemo(() => {
    let result = items;
    if (activeOnly) {
      result = result.filter((e) => activeSessionIds.has(e.sessionId));
    }
    if (domainFilter !== "all") {
      result = result.filter((e) => e.domain === domainFilter);
    }
    if (sessionFilter.trim()) {
      const q = sessionFilter.trim().toLowerCase();
      result = result.filter((e) => e.sessionId.toLowerCase().includes(q));
    }
    // Sort by timestamp descending (newest first)
    result = [...result].sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp)
    );
    return result;
  }, [items, domainFilter, sessionFilter, activeOnly, activeSessionIds]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: "12px",
          marginBottom: "16px",
          alignItems: "center",
        }}
      >
        <label style={{ color: "#94a3b8", fontSize: "13px" }}>
          Domain:
          <select
            value={domainFilter}
            onChange={(e) =>
              setDomainFilter((e.target as HTMLSelectElement).value)}
            style={selectStyle}
          >
            <option value="all">All</option>
            <option value="network">network</option>
            <option value="hostexec">hostexec</option>
          </select>
        </label>
        <label style={{ color: "#94a3b8", fontSize: "13px" }}>
          Session:
          <input
            type="text"
            placeholder="filter by session ID"
            value={sessionFilter}
            onInput={(e) =>
              setSessionFilter((e.target as HTMLInputElement).value)}
            style={inputStyle}
          />
        </label>
        <label
          style={{
            color: "#94a3b8",
            fontSize: "13px",
            display: "flex",
            alignItems: "center",
            gap: "4px",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) =>
              setActiveOnly((e.target as HTMLInputElement).checked)}
          />
          Active sessions only
        </label>
        <span style={{ color: "#64748b", fontSize: "12px", marginLeft: "auto" }}>
          {filtered.length} / {items.length} entries
        </span>
      </div>

      {filtered.length === 0
        ? <p style={{ color: "#94a3b8" }}>No audit log entries.</p>
        : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Timestamp</th>
                <th style={thStyle}>Session</th>
                <th style={thStyle}>Domain</th>
                <th style={thStyle}>Decision</th>
                <th style={thStyle}>Reason</th>
                <th style={thStyle}>Target / Command</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr key={entry.id}>
                  <td style={tdStyle}>
                    {formatTimestamp(entry.timestamp)}
                  </td>
                  <td style={tdSessionStyle} title={entry.sessionId}>
                    {entry.sessionId.slice(0, 8)}
                  </td>
                  <td style={tdStyle}>{entry.domain}</td>
                  <td style={tdStyle}>
                    <span
                      style={{
                        color: entry.decision === "allow"
                          ? "#22c55e"
                          : "#ef4444",
                        fontWeight: "bold",
                      }}
                    >
                      {entry.decision}
                    </span>
                  </td>
                  <td style={tdReasonStyle} title={entry.reason}>
                    {entry.reason}
                  </td>
                  <td style={tdTargetStyle} title={entry.target || entry.command}>
                    {entry.target || entry.command || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " " + d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
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
const tdSessionStyle = {
  ...tdStyle,
  fontFamily: "monospace",
  fontSize: "13px",
  color: "#94a3b8",
};
const tdReasonStyle = {
  ...tdStyle,
  maxWidth: "250px",
  overflow: "hidden" as const,
  textOverflow: "ellipsis" as const,
  whiteSpace: "nowrap" as const,
  fontSize: "13px",
};
const tdTargetStyle = {
  ...tdStyle,
  maxWidth: "200px",
  overflow: "hidden" as const,
  textOverflow: "ellipsis" as const,
  whiteSpace: "nowrap" as const,
  fontSize: "13px",
  color: "#94a3b8",
};
const selectStyle = {
  marginLeft: "6px",
  background: "#0f172a",
  color: "#e2e8f0",
  border: "1px solid #334155",
  borderRadius: "4px",
  padding: "4px 8px",
  fontSize: "13px",
};
const inputStyle = {
  marginLeft: "6px",
  background: "#0f172a",
  color: "#e2e8f0",
  border: "1px solid #334155",
  borderRadius: "4px",
  padding: "4px 8px",
  fontSize: "13px",
  width: "180px",
};
