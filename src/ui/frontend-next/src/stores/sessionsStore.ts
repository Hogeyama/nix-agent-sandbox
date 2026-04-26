/**
 * Solid store for the sessions pane.
 *
 * Normalizes raw container payloads into UI-facing `SessionRow`s and
 * exposes them via an accessor function so consumers cannot mutate the
 * underlying Solid store shape directly.
 */

import { createStore } from "solid-js/store";
import { shortenSessionId } from "./sessionId";
import type { ContainerInfoLike, SessionRow } from "./types";

const NAS_KIND_AGENT = "agent";

export function normalizeContainersToSessions(
  items: ContainerInfoLike[],
): SessionRow[] {
  const out: SessionRow[] = [];
  for (const c of items) {
    const kind = c.labels["nas.kind"];
    if (kind !== NAS_KIND_AGENT) continue;
    const sessionId = c.sessionId ?? null;
    if (sessionId === null) continue; // agent container without a session binding yet
    out.push({
      id: sessionId,
      shortId: shortenSessionId(sessionId),
      name: c.sessionName ?? c.name,
      dir: c.labels["nas.pwd"] ?? null,
      profile: c.sessionProfile ?? null,
      worktreeName: c.worktree?.name ?? null,
      baseBranch: c.worktree?.baseBranch ?? null,
      turn: c.turn ?? null,
      isAgent: true,
    });
  }
  return out;
}

export type SessionsStore = {
  rows: () => SessionRow[];
  setSessions: (items: ContainerInfoLike[]) => void;
};

export function createSessionsStore(): SessionsStore {
  const [state, setState] = createStore<{ rows: SessionRow[] }>({ rows: [] });
  return {
    rows: () => state.rows,
    setSessions: (items) =>
      setState("rows", normalizeContainersToSessions(items)),
  };
}
