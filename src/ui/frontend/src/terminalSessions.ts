import type { ContainerInfo, DtachSession } from "./api.ts";

export interface TerminalSessionTabData {
  sessionId: string;
  sessionName?: string;
  canAckTurn: boolean;
  turnAcked: boolean;
  isOpen: boolean;
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
    const container = containerById.get(sessionId);
    return {
      sessionId,
      sessionName: container?.sessionName,
      canAckTurn: container?.turn === "user-turn",
      turnAcked: container?.turn === "ack-turn",
      isOpen: openSessionIds.includes(sessionId),
    };
  });
}
