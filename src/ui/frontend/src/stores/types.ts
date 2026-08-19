/**
 * Minimal payload and view-row types for the Solid frontend stores.
 *
 * These shapes are intentionally kept local to the frontend module and do not
 * import from the daemon's wire-payload types directly. The "Like" suffix denotes
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
  // Agent identifier sourced from `SessionRecord.agent` (e.g. `"claude"`,
  // `"copilot"`, `"codex"`, `"unknown"`). The backend overlays this onto
  // the container payload so the frontend can resolve agent-specific
  // terminal traits without re-querying the sessions API.
  sessionAgent?: string | null;
};

export type ReviewContextLike = {
  path: string;
  contentType: string | null;
  bodySize: number;
};

export type NetworkPendingItemLike = {
  requestId: string;
  sessionId: string;
  createdAt: string; // ISO
  method?: string | null; // "GET" / "POST" / etc
  target: { host: string; port: number };
  reviewContext?: ReviewContextLike | null;
  // Rule that raised the confirmation, or a `$fallback` pseudo ID. Together
  // with the target it is the identity of the approval the buttons produce.
  ruleId?: string | null;
  // Grains this confirmation may be approved at, narrowest first. The
  // backend derives them from how specific the matched rule is and refuses
  // anything outside the list.
  approvalScopes?: string[] | null;
  // Headers the request gains if it is approved: the header name and the
  // names of the secrets its value is built from. Values never travel here.
  injectHeaders?: InjectHeaderPreviewLike[] | null;
  // Acceptance-condition violations this confirmation covers. Present when
  // the confirmation came from a body inspection rather than from a rule
  // asking to be reviewed: then these are exactly what approving remembers.
  violations?: ViolationFindingLike[] | null;
};

// One violation, as the approval UI shows it. Every body-derived field
// arrives masked and length-bounded; the UI adds no interpretation.
export type ViolationFindingLike = {
  // Selector of the condition that was violated, when it had one.
  at?: string | null;
  kind?: string | null;
  // JSON Pointer of the offending node.
  pointer?: string | null;
  // The offending value — the unknown tag itself. Null for a condition
  // that has no value to approve, such as "the body must be empty".
  value?: string | null;
  // The offending node on its own, pruned and masked.
  excerpt?: string | null;
  // How many nodes violated the same condition with the same value.
  count?: number | null;
};

export type InjectHeaderPreviewLike = {
  name: string;
  secrets?: string[] | null;
};

export type HostExecPendingItemLike = {
  requestId: string;
  sessionId: string;
  createdAt: string;
  argv0: string;
  args: string[];
  cwd?: string | null;
  integrityChanged?: boolean | null;
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
  // Agent identifier propagated from `ContainerInfoLike.sessionAgent`
  // (e.g. `"claude"`, `"copilot"`, `"codex"`, `"unknown"`), or `null`
  // when the backend has not reported one. The terminal layer consults
  // this field to resolve agent-specific traits (e.g. mouse-mode
  // recovery rules) without coupling to the sessions wire shape.
  agent: string | null;
};
