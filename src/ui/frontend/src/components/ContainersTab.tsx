import { useEffect, useState } from "preact/hooks";
import { api, type ContainerInfo } from "../api.ts";

export function ContainersTab() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [cleaning, setCleaning] = useState(false);

  async function refresh() {
    try {
      const res = await api.getContainers();
      setContainers(res.items);
    } catch (e) {
      console.error("Failed to fetch containers:", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

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

  if (loading) {
    return <p style={{ color: "#94a3b8" }}>Loading containers...</p>;
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
          NAS Managed Containers ({containers.length})
        </h3>
        <button
          style={cleanBtnStyle}
          disabled={cleaning}
          onClick={handleCleanAll}
        >
          {cleaning ? "Cleaning..." : "Clean All"}
        </button>
      </div>

      {containers.length === 0
        ? <p style={{ color: "#94a3b8" }}>No nas-managed containers found.</p>
        : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Kind</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((c) => (
                <tr key={c.name}>
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
                  <td style={tdStyle}>{c.labels["nas.kind"] || "-"}</td>
                  <td style={tdStyle}>
                    {c.running && (
                      <button
                        style={stopBtnStyle}
                        disabled={busy.has(c.name)}
                        onClick={() => handleStop(c.name)}
                      >
                        Stop
                      </button>
                    )}
                  </td>
                </tr>
              ))}
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
