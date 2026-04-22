import type { ContainerInfo } from "../api.ts";
import { formatDateTime, formatRelativeTime } from "./containersHelpers.ts";
import {
  detailMutedStyle,
  detailPanelStyle,
  kvGridStyle,
  kvLabelStyle,
  kvValueStyle,
  lastMessageStyle,
  rawDetailsStyle,
  rawPreStyle,
  rawSummaryStyle,
} from "./containersTab.styles.ts";

interface ContainerDetailPanelProps {
  container: ContainerInfo;
}

export function ContainerDetailPanel({
  container: c,
}: ContainerDetailPanelProps) {
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
