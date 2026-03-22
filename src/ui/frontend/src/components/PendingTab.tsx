import { useState } from "preact/hooks";
import {
  api,
  type HostExecPendingItem,
  type NetworkPendingItem,
} from "../api.ts";

interface Props {
  networkItems: NetworkPendingItem[];
  hostExecItems: HostExecPendingItem[];
}

const NETWORK_SCOPES = ["once", "host-port", "host"] as const;
const HOSTEXEC_SCOPES = ["once", "capability"] as const;

export function PendingTab({ networkItems, hostExecItems }: Props) {
  const [scopeMap, setScopeMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const empty = networkItems.length === 0 && hostExecItems.length === 0;

  function setScope(key: string, value: string) {
    setScopeMap((m) => ({ ...m, [key]: value }));
  }

  async function handleNetworkAction(
    item: NetworkPendingItem,
    action: "approve" | "deny",
  ) {
    const key = `net:${item.sessionId}:${item.requestId}`;
    setBusy((s) => new Set(s).add(key));
    try {
      if (action === "approve") {
        await api.approveNetwork(
          item.sessionId,
          item.requestId,
          scopeMap[key] || "once",
        );
      } else {
        await api.denyNetwork(item.sessionId, item.requestId);
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

  async function handleHostExecAction(
    item: HostExecPendingItem,
    action: "approve" | "deny",
  ) {
    const key = `he:${item.sessionId}:${item.requestId}`;
    setBusy((s) => new Set(s).add(key));
    try {
      if (action === "approve") {
        await api.approveHostExec(
          item.sessionId,
          item.requestId,
          scopeMap[key] || "once",
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

  if (empty) {
    return <p style={{ color: "#94a3b8" }}>No pending approvals.</p>;
  }

  return (
    <div>
      {networkItems.length > 0 && (
        <section style={{ marginBottom: hostExecItems.length > 0 ? "24px" : 0 }}>
          <h3 style={sectionTitle}>
            Network
            <span style={countBadge}>{networkItems.length}</span>
          </h3>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Session</th>
                <th style={thStyle}>Target</th>
                <th style={thStyle}>Method</th>
                <th style={thStyle}>Kind</th>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Scope</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {networkItems.map((item) => {
                const key = `net:${item.sessionId}:${item.requestId}`;
                const disabled = busy.has(key);
                return (
                  <tr key={key}>
                    <td style={tdStyle}>{item.sessionId.slice(0, 8)}</td>
                    <td style={tdStyle}>
                      {item.target.host}:{item.target.port}
                    </td>
                    <td style={tdStyle}>{item.method}</td>
                    <td style={tdStyle}>{item.requestKind}</td>
                    <td style={tdStyle}>
                      {new Date(item.createdAt).toLocaleTimeString()}
                    </td>
                    <td style={tdStyle}>
                      <select
                        style={selectStyle}
                        value={scopeMap[key] || "once"}
                        onChange={(e) =>
                          setScope(
                            key,
                            (e.target as HTMLSelectElement).value,
                          )}
                      >
                        {NETWORK_SCOPES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                    <td style={tdStyle}>
                      <button
                        style={approveBtnStyle}
                        disabled={disabled}
                        onClick={() => handleNetworkAction(item, "approve")}
                      >
                        Approve
                      </button>
                      <button
                        style={denyBtnStyle}
                        disabled={disabled}
                        onClick={() => handleNetworkAction(item, "deny")}
                      >
                        Deny
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {hostExecItems.length > 0 && (
        <section>
          <h3 style={sectionTitle}>
            HostExec
            <span style={countBadge}>{hostExecItems.length}</span>
          </h3>
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
              {hostExecItems.map((item) => {
                const key = `he:${item.sessionId}:${item.requestId}`;
                const disabled = busy.has(key);
                const cmd = [item.argv0, ...item.args].join(" ");
                return (
                  <tr key={key}>
                    <td style={tdStyle}>{item.sessionId.slice(0, 8)}</td>
                    <td style={tdStyle}>{item.ruleId}</td>
                    <td style={tdStyle}>
                      <code style={cmdStyle} title={cmd}>{cmd}</code>
                    </td>
                    <td style={tdStyle}>{item.cwd}</td>
                    <td style={tdStyle}>
                      {new Date(item.createdAt).toLocaleTimeString()}
                    </td>
                    <td style={tdStyle}>
                      <select
                        style={selectStyle}
                        value={scopeMap[key] || "once"}
                        onChange={(e) =>
                          setScope(
                            key,
                            (e.target as HTMLSelectElement).value,
                          )}
                      >
                        {HOSTEXEC_SCOPES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                    <td style={tdStyle}>
                      <button
                        style={approveBtnStyle}
                        disabled={disabled}
                        onClick={() => handleHostExecAction(item, "approve")}
                      >
                        Approve
                      </button>
                      <button
                        style={denyBtnStyle}
                        disabled={disabled}
                        onClick={() => handleHostExecAction(item, "deny")}
                      >
                        Deny
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

const sectionTitle = {
  fontSize: "14px",
  color: "#94a3b8",
  marginBottom: "8px",
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
};
const countBadge = {
  marginLeft: "8px",
  background: "#ef4444",
  color: "white",
  borderRadius: "10px",
  padding: "1px 7px",
  fontSize: "12px",
  fontWeight: "normal" as const,
};
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
const cmdStyle = {
  fontSize: "13px",
  display: "inline-block",
  maxWidth: "300px",
  overflow: "hidden" as const,
  textOverflow: "ellipsis" as const,
  whiteSpace: "nowrap" as const,
  verticalAlign: "middle",
};
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
