/**
 * Minimal payload and view-row types for the Solid frontend stores.
 *
 * These shapes are intentionally kept local to `frontend-next` and do not
 * import from the Preact `frontend/src/api.ts`. The "Like" suffix denotes
 * a defensive subset of the wire payload: each upstream-optional field
 * is typed as `T | null | undefined` so normalizers can absorb both
 * representations via `?? null`.
 */

// SSE-received payload subset describing a container.
export type ContainerInfoLike = {
  name: string;
  running: boolean;
  labels: Record<string, string>;
  sessionId?: string | null;
  sessionName?: string | null;
  turn?: string | null; // "user-turn" | "agent-turn" | "ack-turn" | "done" | etc
  sessionProfile?: string | null;
  worktree?: { name: string; baseBranch: string } | null;
  lastEventAt?: string | null;
  // ISO-8601 timestamp at which the container was started, or `null`
  // when the daemon does not (yet) know. The Sidecars settings page
  // reads this to render an uptime column; the sessions normalizer
  // ignores the field, so making it optional adds no regression to
  // any consumer that does not opt in.
  startedAt?: string | null;
};

export type NetworkPendingItemLike = {
  requestId: string;
  sessionId: string;
  createdAt: string; // ISO
  method?: string | null; // "GET" / "POST" / etc
  target: { host: string; port: number };
};

export type HostExecPendingItemLike = {
  requestId: string;
  sessionId: string;
  createdAt: string;
  argv0: string;
  args: string[];
  cwd?: string | null;
};

// SSE-received payload subset describing one dtach socket exposed by the
// backend (one entry per attachable terminal session).
export type DtachSessionLike = {
  name: string;
  sessionId: string;
  socketPath: string;
  createdAt: number;
};

// SSE-received payload subset describing one audit log entry, mirroring
// the wire shape of `AuditLogEntry` in `src/audit/types.ts`. Optional
// fields are typed as `T | null | undefined` so the store's normalizer
// can absorb either representation.
export type AuditLogEntryLike = {
  id: string;
  timestamp: string; // ISO-8601
  domain: "network" | "hostexec";
  sessionId: string;
  requestId: string;
  decision: "allow" | "deny";
  reason: string;
  scope?: string | null;
  target?: string | null;
  command?: string | null;
};

export type SessionTurn = "user-turn" | "ack-turn" | "agent-turn" | "done";

/**
 * Subset of the backend `SessionRecord` shape that the UI cares about.
 *
 * - `name` mirrors `SessionRecord.name?: string` from the backend
 *   (`src/sessions/store.ts`). It is the **mutable display name** of the
 *   session and is what `PATCH /api/sessions/:id/name` writes. The field
 *   is optional on the wire (the backend omits it when unset), so
 *   consumers must treat `undefined` as "no custom name".
 * - `name` is intentionally distinct from `SessionRow.containerName`,
 *   which is the **immutable Docker container name**. The two never
 *   alias.
 * - `turn` / `lastEventAt` mirror `SessionRecord` and are also optional
 *   on the wire; we keep them optional here so the type is structurally
 *   assignable from `{ item: SessionRecord }`.
 */
export interface SessionRecordLike {
  sessionId: string;
  name?: string;
  turn?: SessionTurn;
  lastEventAt?: string;
}

// Normalized row consumed by the sessions pane.
export type SessionRow = {
  id: string; // sessionId, used as key
  shortId: string; // e.g. "7a3f12"
  name: string; // sessionName, falls back to container name
  // Docker container name. `containerName` is the destination of left-pane
  // Stop / Shell actions and is always populated from `ContainerInfoLike.name`.
  containerName: string;
  dir: string | null; // labels["nas.pwd"]
  profile: string | null; // sessionProfile
  worktreeName: string | null;
  baseBranch: string | null;
  turn: string | null;
  // ISO 8601 timestamp of the most recent session event, or `null` when
  // the backend has not reported one yet. Drives Ack optimistic updates.
  lastEventAt: string | null;
  isAgent: boolean; // labels["nas.kind"] === "agent"
};
