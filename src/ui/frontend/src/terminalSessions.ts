import type { ContainerInfo, DtachSession } from "./api.ts";

export interface TerminalSessionTabData {
  sessionId: string;
  sessionName?: string;
  canAckTurn: boolean;
  turnAcked: boolean;
  isOpen: boolean;
  kind: "agent" | "shell";
  /** shell セッションの場合、親 agent の sessionId */
  parentSessionId?: string;
  /** shell セッションの場合、コンテナ単位で何番目の shell か */
  shellSeq?: number;
}

/**
 * shell dtach セッション ID の形式:
 *   shell-<parentSessionId>.<seq>
 * backend の `parseShellSessionId` (src/ui/data.ts) と対応。
 */
export function parseShellSessionId(
  id: string,
): { parentSessionId: string; seq: number } | null {
  if (!id.startsWith("shell-")) return null;
  const rest = id.slice("shell-".length);
  const dotIdx = rest.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === rest.length - 1) return null;
  const parent = rest.slice(0, dotIdx);
  const seqStr = rest.slice(dotIdx + 1);
  if (!/^\d+$/.test(seqStr)) return null;
  const seq = Number.parseInt(seqStr, 10);
  if (seq <= 0) return null;
  return { parentSessionId: parent, seq };
}

export function buildTerminalSessionTabs(
  openSessionIds: string[],
  dtachSessions: DtachSession[],
  sessionContainers: Array<ContainerInfo & { sessionId: string }>,
): TerminalSessionTabData[] {
  const containerById = new Map(
    sessionContainers.map((container) => [container.sessionId, container]),
  );
  const liveIds = new Set(dtachSessions.map((session) => session.sessionId));
  const orderedIds = [
    ...openSessionIds.filter((sessionId) => liveIds.has(sessionId)),
    ...dtachSessions
      .map((session) => session.sessionId)
      .filter((sessionId) => !openSessionIds.includes(sessionId)),
  ];

  return orderedIds.map((sessionId) => {
    const shell = parseShellSessionId(sessionId);
    if (shell) {
      const parent = containerById.get(shell.parentSessionId);
      const parentLabel = parent?.sessionName ?? shell.parentSessionId;
      return {
        sessionId,
        sessionName: `${parentLabel} (shell#${shell.seq})`,
        canAckTurn: false,
        turnAcked: false,
        isOpen: openSessionIds.includes(sessionId),
        kind: "shell",
        parentSessionId: shell.parentSessionId,
        shellSeq: shell.seq,
      };
    }
    const container = containerById.get(sessionId);
    return {
      sessionId,
      sessionName: container?.sessionName,
      canAckTurn: container?.turn === "user-turn",
      turnAcked: container?.turn === "ack-turn",
      isOpen: openSessionIds.includes(sessionId),
      kind: "agent",
    };
  });
}
