import { useEffect, useRef, useState } from "preact/hooks";
import {
  api,
  type HostExecPendingItem,
  type NetworkPendingItem,
} from "../api.ts";
import type { DeepLink } from "../App.tsx";

// FIXME: バックエンドからHOMEを渡すようにして正確に判定する
function shortenHome(path: string): string {
  const m = path.match(/^\/home\/[^/]+/);
  if (!m) return path;
  if (path === m[0]) return "~";
  return "~" + path.slice(m[0].length);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      style={copyBtnStyle}
      title="Copy"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "\u2713" : "\u2398"}
    </button>
  );
}

interface Props {
  networkItems: NetworkPendingItem[];
  hostExecItems: HostExecPendingItem[];
  deepLink?: DeepLink | null;
}

const NETWORK_SCOPES = ["once", "host-port", "host"] as const;
const HOSTEXEC_SCOPES = ["once", "capability"] as const;

export function PendingTab({ networkItems, hostExecItems, deepLink }: Props) {
  const [scopeMap, setScopeMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const highlightRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [deepLink]);

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
                <th style={{ ...thStyle, width: "10%" }}>Session</th>
                <th style={{ ...thStyle, width: "25%" }}>Target</th>
                <th style={{ ...thStyle, width: "10%" }}>Method</th>
                <th style={{ ...thStyle, width: "10%" }}>Kind</th>
                <th style={{ ...thStyle, width: "10%" }}>Created</th>
                <th style={{ ...thStyle, width: "10%" }}>Scope</th>
                <th style={{ ...thStyle, width: "25%" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {networkItems.map((item) => {
                const key = `net:${item.sessionId}:${item.requestId}`;
                const disabled = busy.has(key);
                const isHighlighted = deepLink?.type === "network" &&
                  deepLink.sessionId === item.sessionId &&
                  deepLink.requestId === item.requestId;
                return (
                  <tr
                    key={key}
                    ref={isHighlighted ? highlightRef : undefined}
                    style={isHighlighted ? highlightRowStyle : undefined}
                  >
                    <td style={tdStyle}>{item.sessionId.slice(0, 8)}</td>
                    <td style={tdStyle}>
                      <div style={scrollBox}>
                        {item.target.host}:{item.target.port}
                      </div>
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
                    <td style={tdActionsStyle}>
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
                <th style={{ ...thStyle, width: "10%" }}>Session</th>
                <th style={{ ...thStyle, width: "10%" }}>Rule</th>
                <th style={{ ...thStyle, width: "30%" }}>Command</th>
                <th style={{ ...thStyle, width: "15%" }}>CWD</th>
                <th style={{ ...thStyle, width: "10%" }}>Created</th>
                <th style={{ ...thStyle, width: "10%" }}>Scope</th>
                <th style={{ ...thStyle, width: "15%" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {hostExecItems.map((item) => {
                const key = `he:${item.sessionId}:${item.requestId}`;
                const disabled = busy.has(key);
                const cmd = [item.argv0, ...item.args].join(" ");
                const isHighlighted = deepLink?.type === "hostexec" &&
                  deepLink.sessionId === item.sessionId &&
                  deepLink.requestId === item.requestId;
                return (
                  <tr
                    key={key}
                    ref={isHighlighted ? highlightRef : undefined}
                    style={isHighlighted ? highlightRowStyle : undefined}
                  >
                    <td style={tdStyle}>{item.sessionId.slice(0, 8)}</td>
                    <td style={tdStyle}>{item.ruleId}</td>
                    <td style={tdStyle}>
                      <div style={scrollCopyBox}>
                        <div style={scrollBox}>
                          <code style={cmdStyle} title={cmd}>{cmd}</code>
                        </div>
                        <CopyButton text={cmd} />
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <div style={scrollCopyBox}>
                        <div style={{ ...scrollBox, fontSize: "13px" }}>{shortenHome(item.cwd)}</div>
                        <CopyButton text={item.cwd} />
                      </div>
                    </td>
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
const tableStyle = {
  width: "100%",
  borderCollapse: "collapse" as const,
  tableLayout: "fixed" as const,
};
const thStyle = {
  textAlign: "left" as const,
  padding: "8px",
  borderBottom: "1px solid #334155",
  color: "#94a3b8",
  fontSize: "12px",
  textTransform: "uppercase" as const,
};
const tdStyle = {
  padding: "8px",
  borderBottom: "1px solid #1e293b",
  overflow: "hidden" as const,
  textOverflow: "ellipsis" as const,
  whiteSpace: "nowrap" as const,
};
const scrollCopyBox = {
  display: "flex" as const,
  alignItems: "center" as const,
  gap: "4px",
};
const scrollBox = {
  overflowX: "auto" as const,
  whiteSpace: "nowrap" as const,
  flex: "1",
  minWidth: "0",
};
const copyBtnStyle = {
  flexShrink: 0,
  background: "none",
  border: "1px solid #334155",
  borderRadius: "4px",
  color: "#94a3b8",
  cursor: "pointer",
  padding: "2px 5px",
  fontSize: "12px",
  lineHeight: "1",
};
const tdActionsStyle = {
  padding: "8px",
  borderBottom: "1px solid #1e293b",
  whiteSpace: "nowrap" as const,
};
const cmdStyle = {
  fontSize: "13px",
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
const highlightRowStyle = {
  background: "rgba(56, 189, 248, 0.15)",
  outline: "1px solid #38bdf8",
};
