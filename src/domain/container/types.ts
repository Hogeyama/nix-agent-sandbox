/**
 * container domain — IO-free pure helpers + shape 定義 + typed errors のみ。
 *
 * Effect 依存なし。`NasContainerInfo` interface と
 * `joinSessionsToContainers` 純関数 (ラベルベースで session record を
 * overlay する) と `ContainerLifecycleService` 系の typed error class
 * を提供する。
 */

import { NAS_SESSION_ID_LABEL } from "../../docker/nas_resources.ts";
import type {
  SessionEventKind,
  SessionRecord,
  SessionTurn,
} from "../../sessions/store.ts";

// ---------------------------------------------------------------------------
// Typed errors (used by ContainerLifecycleService.startShellSession;
// `ui/routes/api.ts` does `instanceof` 分岐 to map to HTTP 403/409.)
// ---------------------------------------------------------------------------

/** Thrown when a shell session is requested for a container that is not running. */
export class ContainerNotRunningError extends Error {
  constructor(containerName: string) {
    super(`Container is not running: ${containerName}`);
    this.name = "ContainerNotRunningError";
  }
}

/** Thrown when an operation targets a container not managed by nas. */
export class NotNasManagedContainerError extends Error {
  constructor(containerName: string) {
    super(`Not a nas-managed container: ${containerName}`);
    this.name = "NotNasManagedContainerError";
  }
}

export interface NasContainerInfo {
  name: string;
  running: boolean;
  labels: Record<string, string>;
  /**
   * Docker network names this container is attached to. Always populated by
   * `ContainerQueryService` from `DockerService.inspect`. Backend 必須。
   * Frontend (`ui/frontend/src/api.ts#ContainerInfo`) は読み手不在のため
   * forward-compat の optional として宣言される非対称設計。
   */
  networks: string[];
  startedAt: string;
  // Session-derived fields — populated by joinSessionsToContainers when a
  // container carries a `nas.session_id` label matching a live record.
  sessionId?: string;
  sessionName?: string;
  turn?: SessionTurn;
  sessionAgent?: string;
  sessionProfile?: string;
  worktree?: string;
  sessionStartedAt?: string;
  lastEventAt?: string;
  lastEventKind?: SessionEventKind;
  lastEventMessage?: string;
}

/**
 * Pure function: overlay session record data onto containers via the
 * `nas.session_id` label. Containers without a label, or with a label
 * that has no matching record, are returned unchanged (shallow-copied).
 *
 * IO-free。`ContainerQueryService.listManagedWithSessions` の D2 compose
 * 部分として使われる。
 */
export function joinSessionsToContainers(
  containers: NasContainerInfo[],
  sessions: SessionRecord[],
): NasContainerInfo[] {
  const bySessionId = new Map<string, SessionRecord>();
  for (const record of sessions) {
    bySessionId.set(record.sessionId, record);
  }

  return containers.map((container) => {
    const sessionId = container.labels[NAS_SESSION_ID_LABEL];
    if (!sessionId) return { ...container };
    const record = bySessionId.get(sessionId);
    if (!record) return { ...container };
    return {
      ...container,
      sessionId: record.sessionId,
      sessionName: record.name,
      turn: record.turn,
      sessionAgent: record.agent,
      sessionProfile: record.profile,
      worktree: record.worktree,
      sessionStartedAt: record.startedAt,
      lastEventAt: record.lastEventAt,
      lastEventKind: record.lastEventKind,
      lastEventMessage: record.lastEventMessage,
    };
  });
}
