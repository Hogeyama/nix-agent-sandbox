import type { HostExecSession, NetworkSession } from "../api.ts";

interface Props {
  network: NetworkSession[];
  hostexec: HostExecSession[];
}

export function SessionsTab({ network, hostexec }: Props) {
  const empty = network.length === 0 && hostexec.length === 0;

  if (empty) {
    return <p style={{ color: "#94a3b8" }}>No active sessions.</p>;
  }

  return (
    <div>
      {network.length > 0 && (
        <>
          <h3 style={sectionStyle}>Network Sessions</h3>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Session ID</th>
                <th style={thStyle}>Profile</th>
                <th style={thStyle}>PID</th>
                <th style={thStyle}>Prompt</th>
                <th style={thStyle}>Created</th>
              </tr>
            </thead>
            <tbody>
              {network.map((s) => (
                <tr key={s.sessionId}>
                  <td style={tdStyle}>{s.sessionId.slice(0, 12)}</td>
                  <td style={tdStyle}>{s.profileName}</td>
                  <td style={tdStyle}>{s.pid}</td>
                  <td style={tdStyle}>
                    {s.promptEnabled ? "enabled" : "disabled"}
                  </td>
                  <td style={tdStyle}>
                    {new Date(s.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {hostexec.length > 0 && (
        <>
          <h3 style={{ ...sectionStyle, marginTop: "24px" }}>
            HostExec Sessions
          </h3>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Session ID</th>
                <th style={thStyle}>Profile</th>
                <th style={thStyle}>PID</th>
                <th style={thStyle}>Created</th>
              </tr>
            </thead>
            <tbody>
              {hostexec.map((s) => (
                <tr key={s.sessionId}>
                  <td style={tdStyle}>{s.sessionId.slice(0, 12)}</td>
                  <td style={tdStyle}>{s.profileName}</td>
                  <td style={tdStyle}>{s.pid}</td>
                  <td style={tdStyle}>
                    {new Date(s.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const sectionStyle = {
  fontSize: "16px",
  marginBottom: "12px",
  color: "#cbd5e1",
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
