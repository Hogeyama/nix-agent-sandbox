import { useState } from "preact/hooks";
import { api, type HostExecPendingItem } from "../api.ts";

interface Props {
  items: HostExecPendingItem[];
}

const SCOPES = ["once", "capability"] as const;
const DEFAULT_SCOPE = "capability";

export function HostExecTab({ items }: Props) {
  const [scopeMap, setScopeMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());

  if (items.length === 0) {
    return <p style={{ color: "#94a3b8" }}>No pending hostexec approvals.</p>;
  }

  async function handleAction(
    item: HostExecPendingItem,
    action: "approve" | "deny",
  ) {
    const key = `${item.sessionId}:${item.requestId}`;
    setBusy((s) => new Set(s).add(key));
    try {
      if (action === "approve") {
        await api.approveHostExec(
          item.sessionId,
          item.requestId,
          scopeMap[key] || DEFAULT_SCOPE,
        );
      } else {
        await api.denyHostExec(item.sessionId, item.requestId);
      }
    } catch (e) {
      console.error("Action failed:", e);
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={thStyle}>Session</th>
          <th style={thStyle}>Rule</th>
          <th style={thStyle}>Command</th>
          <th style={thStyle}>CWD</th>
          <th style={thStyle}>Created</th>
          <th style={thStyle}>Scope</th>
          <th style={thStyle}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const key = `${item.sessionId}:${item.requestId}`;
          const disabled = busy.has(key);
          const cmd = [item.argv0, ...item.args].join(" ");
          return (
            <tr key={key}>
              <td style={tdStyle}>{item.sessionId.slice(0, 8)}</td>
              <td style={tdStyle}>{item.ruleId}</td>
              <td style={tdStyle}>
                <code style={{ fontSize: "13px" }}>{cmd}</code>
              </td>
              <td style={tdStyle}>{item.cwd}</td>
              <td style={tdStyle}>
                {new Date(item.createdAt).toLocaleTimeString()}
              </td>
              <td style={tdStyle}>
                <select
                  style={selectStyle}
                  value={scopeMap[key] || DEFAULT_SCOPE}
                  onChange={(e) =>
                    setScopeMap((m) => ({
                      ...m,
                      [key]: (e.target as HTMLSelectElement).value,
                    }))
                  }
                >
                  {SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </td>
              <td style={tdStyle}>
                <button
                  type="button"
                  style={approveBtnStyle}
                  disabled={disabled}
                  onClick={() => handleAction(item, "approve")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  style={denyBtnStyle}
                  disabled={disabled}
                  onClick={() => handleAction(item, "deny")}
                >
                  Deny
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
const selectStyle = {
  background: "#0f172a",
  color: "#e2e8f0",
  border: "1px solid #334155",
  borderRadius: "4px",
  padding: "4px",
};
const approveBtnStyle = {
  background: "#22c55e",
  color: "white",
  border: "none",
  borderRadius: "4px",
  padding: "4px 12px",
  cursor: "pointer",
  marginRight: "4px",
};
const denyBtnStyle = {
  background: "#ef4444",
  color: "white",
  border: "none",
  borderRadius: "4px",
  padding: "4px 12px",
  cursor: "pointer",
};
