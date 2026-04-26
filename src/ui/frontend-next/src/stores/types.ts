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
};

export type NetworkPendingItemLike = {
  id: string; // request id
  sessionId: string;
  sessionName?: string | null;
  createdAt: string; // ISO
  method?: string | null; // "GET" / "POST" / etc
  host: string;
  port: number;
};

export type HostExecPendingItemLike = {
  id: string;
  sessionId: string;
  sessionName?: string | null;
  createdAt: string;
  argv: string[]; // ["git", "push"] etc
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

// Normalized row consumed by the sessions pane.
export type SessionRow = {
  id: string; // sessionId, used as key
  shortId: string; // e.g. "s_7a3f12"
  name: string; // sessionName, falls back to container name
  dir: string | null; // labels["nas.pwd"]
  profile: string | null; // sessionProfile
  worktreeName: string | null;
  baseBranch: string | null;
  turn: string | null;
  isAgent: boolean; // labels["nas.kind"] === "agent"
};
