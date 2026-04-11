import { useEffect, useState } from "preact/hooks";
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

export function ContainersTab() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [cleaning, setCleaning] = useState(false);
  const [, setTick] = useState(0);

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

  // Update relative times every 30s
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
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
    return (
      <div class="empty">
        <div class="icon">◐</div>
        <div class="msg">Loading containers…</div>
      </div>
    );
  }

  return (
    <div>
      <div class="toolbar">
        <h3>
          Managed Containers
          <span class="badge">{containers.length}</span>
        </h3>
        <button
          type="button"
          class="btn btn-primary"
          disabled={cleaning}
          onClick={handleCleanAll}
        >
          {cleaning ? "Cleaning…" : "Clean All"}
        </button>
      </div>

      {containers.length === 0 ? (
        <div class="empty">
          <div class="icon">∅</div>
          <div class="msg">No nas-managed containers</div>
          <div class="sub">
            Launch an agent with <span class="kbd">nas run</span> to get
            started.
          </div>
        </div>
      ) : (
        <table class="table">
          <colgroup>
            <col style="width:28%" />
            <col style="width:11%" />
            <col style="width:10%" />
            <col style="width:13%" />
            <col style="width:26%" />
            <col style="width:12%" />
          </colgroup>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Kind</th>
              <th>Uptime</th>
              <th>PWD</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {containers.map((c) => {
              const kind = c.labels["nas.kind"] || "-";
              const pwd = kind === "agent" ? c.labels["nas.pwd"] || "-" : "";
              return (
                <tr key={c.name}>
                  <td class="mono" title={c.name}>
                    {c.name}
                  </td>
                  <td>
                    <span
                      class={`chip ${c.running ? "chip-good" : "chip-muted"}`}
                    >
                      {c.running ? "running" : "stopped"}
                    </span>
                  </td>
                  <td>
                    <span class="chip">{kind}</span>
                  </td>
                  <td class="time">
                    {c.running && c.startedAt
                      ? formatRelativeTime(c.startedAt)
                      : "-"}
                  </td>
                  <td class="mono" title={pwd}>
                    {pwd}
                  </td>
                  <td>
                    {c.running && (
                      <button
                        type="button"
                        class="btn btn-warn"
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
