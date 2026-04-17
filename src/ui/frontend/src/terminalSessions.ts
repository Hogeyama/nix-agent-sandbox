import { parseShellSessionId } from "../../shell_session_id.ts";
import type { ContainerInfo, DtachSession } from "./api.ts";

export { parseShellSessionId } from "../../shell_session_id.ts";

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
