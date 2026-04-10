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
    result = [...result].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return result;
  }, [items, domainFilter, sessionFilter, activeOnly, activeSessionIds]);

  return (
    <div>
      <div class="filter-bar">
        <label>
          Domain
          <select
            class="select"
            value={domainFilter}
            onChange={(e) =>
              setDomainFilter((e.target as HTMLSelectElement).value)}
          >
            <option value="all">All</option>
            <option value="network">network</option>
            <option value="hostexec">hostexec</option>
          </select>
        </label>
        <label>
          Session
          <input
            type="text"
            class="input"
            placeholder="filter by id…"
            value={sessionFilter}
            onInput={(e) =>
              setSessionFilter((e.target as HTMLInputElement).value)}
            style="width:180px"
          />
        </label>
        <label class="checkbox">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) =>
              setActiveOnly((e.target as HTMLInputElement).checked)}
          />
          Active only
        </label>
        <span class="counter">
          {filtered.length} / {items.length}
        </span>
      </div>

      {filtered.length === 0
        ? (
          <div class="empty">
            <div class="icon">○</div>
            <div class="msg">No audit entries</div>
            <div class="sub">Nothing matches the current filters.</div>
          </div>
        )
        : (
          <table class="table">
            <colgroup>
              <col style="width:14%" />
              <col style="width:10%" />
              <col style="width:10%" />
              <col style="width:10%" />
              <col style="width:30%" />
              <col style="width:26%" />
            </colgroup>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Session</th>
                <th>Domain</th>
                <th>Decision</th>
                <th>Reason</th>
                <th>Target / Command</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr key={entry.id}>
                  <td class="time">{formatTimestamp(entry.timestamp)}</td>
                  <td class="session" title={entry.sessionId}>
                    {entry.sessionId.slice(0, 8)}
                  </td>
                  <td><span class="chip">{entry.domain}</span></td>
                  <td>
                    <span class={`decision ${entry.decision}`}>
                      {entry.decision}
                    </span>
                  </td>
                  <td title={entry.reason}>{entry.reason}</td>
                  <td class="mono" title={entry.target || entry.command}>
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
