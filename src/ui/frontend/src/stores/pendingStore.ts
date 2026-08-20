/**
 * Solid store for the pending pane (network + host-exec approval queues).
 *
 * Normalizes raw pending payloads into UI-facing rows and exposes them
 * via accessor functions so consumers cannot mutate the underlying
 * Solid store shape directly.
 */

import { createStore } from "solid-js/store";
import { pendingRequestKey } from "./pendingRequestKey";
import { shortenSessionId } from "./sessionId";
import type {
  HostExecPendingItemLike,
  InjectHeaderPreviewLike,
  NetworkPendingItemLike,
  ReviewContextLike,
  ViolationFindingLike,
} from "./types";

export type NetworkPendingRow = {
  // Stable composite identity `(domain, sessionId, requestId)` produced by
  // `pendingRequestKey`. Used to key per-card UI state (selected scope,
  // busy flag, error message) so entries do not collide with hostexec
  // rows that happen to share a `requestId`.
  key: string;
  // Alias of `requestId`. Retained as an informational handle for any
  // consumer that already reads `id` from the row; per-card state lookup
  // uses `key` instead.
  id: string;
  sessionId: string;
  sessionShortId: string;
  sessionName: string | null;
  verb: string;
  summary: string;
  createdAtMs: number | null; // null when ISO parse fails
  reviewContext: ReviewContextLike | null;
  // Rule the confirmation came from, or null when the payload omits it.
  // Presentation only; the backend decides what an approval covers.
  ruleId: string | null;
  // Why this confirmation is being asked, or null when the payload does not
  // say — violation cards never do. Passed through verbatim: the vocabulary
  // belongs to the backend and the view resolves it to a sentence.
  askReason: string | null;
  // Grains this entry may be approved at, narrowest first. Never empty:
  // an entry that advertises nothing usable is treated as `once` only.
  approvalScopes: string[];
  // Headers approving this request would add, by header name and by the
  // names of the secrets the value is built from. Never a value: the
  // wire payload does not carry one and this row must not invent one.
  injectHeaders: { name: string; secrets: string[] }[];
  // Violations approving this row would remember. Empty for a confirmation
  // a rule raised on its own: those cover a request, not a set of values.
  violations: NetworkViolationRow[];
};

export type NetworkViolationRow = {
  at: string;
  kind: string;
  pointer: string;
  value: string | null;
  excerpt: string | null;
  count: number;
};

// Grains the backend understands (`ApprovalScope` in
// `src/network/protocol.ts`). Anything else in a payload is dropped rather
// than rendered, so a chip can never offer a grain no one can act on.
const KNOWN_APPROVAL_SCOPES = [
  "once",
  "rule",
  "host-port",
  "host",
  "violation",
];

const NARROWEST_APPROVAL_SCOPE = "once";

export type HostExecPendingRow = {
  // See `NetworkPendingRow.key`.
  key: string;
  // See `NetworkPendingRow.id`.
  id: string;
  sessionId: string;
  sessionShortId: string;
  sessionName: string | null;
  command: string; // argv joined by space, presentation only
  integrityChanged: boolean; // true のとき対象ファイルが起動時 baseline から変化
  createdAtMs: number | null;
};

export function normalizeNetworkPending(
  items: NetworkPendingItemLike[],
): NetworkPendingRow[] {
  return items.map((it) => ({
    key: pendingRequestKey("network", it.sessionId, it.requestId),
    id: it.requestId,
    sessionId: it.sessionId,
    sessionShortId: shortenSessionId(it.sessionId),
    sessionName: null,
    verb: (it.method ?? "GET").toUpperCase(),
    summary: `${it.target.host}:${it.target.port}`,
    createdAtMs: parseIsoToMs(it.createdAt),
    reviewContext: it.reviewContext ?? null,
    ruleId: it.ruleId ?? null,
    askReason: it.askReason ?? null,
    approvalScopes: approvalScopesOf(it.approvalScopes),
    injectHeaders: injectHeadersOf(it.injectHeaders),
    violations: violationsOf(it.violations),
  }));
}

/**
 * Normalize the violations a row may carry.
 *
 * Every field is optional on the wire, and a violation with nothing in it
 * still says "one node broke this condition" — the count alone is
 * meaningful — so nothing here drops a record for being sparse.
 */
function violationsOf(
  violations: ViolationFindingLike[] | null | undefined,
): NetworkViolationRow[] {
  return (violations ?? []).map((violation) => ({
    at: violation.at ?? "",
    kind: violation.kind ?? "",
    pointer: violation.pointer ?? "",
    value: violation.value ?? null,
    excerpt: violation.excerpt ?? null,
    count: violation.count ?? 1,
  }));
}

function injectHeadersOf(
  headers: InjectHeaderPreviewLike[] | null | undefined,
): { name: string; secrets: string[] }[] {
  return (headers ?? []).map((header) => ({
    name: header.name,
    secrets: header.secrets ?? [],
  }));
}

/**
 * Keep only grains the backend would accept, and never end up with none.
 *
 * A payload that says nothing about grains is not an invitation to guess a
 * wide one: `once` applies to the request on screen and to nothing else.
 */
function approvalScopesOf(scopes: string[] | null | undefined): string[] {
  const known = (scopes ?? []).filter((scope) =>
    KNOWN_APPROVAL_SCOPES.includes(scope),
  );
  return known.length > 0 ? known : [NARROWEST_APPROVAL_SCOPE];
}

export function normalizeHostExecPending(
  items: HostExecPendingItemLike[],
): HostExecPendingRow[] {
  return items.map((it) => ({
    key: pendingRequestKey("hostexec", it.sessionId, it.requestId),
    id: it.requestId,
    sessionId: it.sessionId,
    sessionShortId: shortenSessionId(it.sessionId),
    sessionName: null,
    command: [it.argv0, ...it.args].join(" "),
    integrityChanged: it.integrityChanged === true,
    createdAtMs: parseIsoToMs(it.createdAt),
  }));
}

function parseIsoToMs(iso: string): number | null {
  const t = Date.parse(iso);
  // Date.parse returns NaN for unparseable input; surface that explicitly
  // as null so the view layer can render a placeholder instead of NaN.
  return Number.isFinite(t) ? t : null;
}

export type PendingStore = {
  network: () => NetworkPendingRow[];
  hostexec: () => HostExecPendingRow[];
  setNetwork: (items: NetworkPendingItemLike[]) => void;
  setHostExec: (items: HostExecPendingItemLike[]) => void;
  // Drop a row by `requestId` after the server has confirmed an
  // approve/deny, so the UI does not have to wait for the next ~2s SSE
  // poll. The next snapshot overwrites the whole array anyway, so any
  // drift here is self-correcting.
  removeNetwork: (requestId: string) => void;
  removeHostExec: (requestId: string) => void;
};

export function createPendingStore(): PendingStore {
  const [state, setState] = createStore<{
    network: NetworkPendingRow[];
    hostexec: HostExecPendingRow[];
  }>({ network: [], hostexec: [] });
  return {
    network: () => state.network,
    hostexec: () => state.hostexec,
    setNetwork: (items) => setState("network", normalizeNetworkPending(items)),
    setHostExec: (items) =>
      setState("hostexec", normalizeHostExecPending(items)),
    removeNetwork: (requestId) =>
      setState("network", (rows) => rows.filter((r) => r.id !== requestId)),
    removeHostExec: (requestId) =>
      setState("hostexec", (rows) => rows.filter((r) => r.id !== requestId)),
  };
}
