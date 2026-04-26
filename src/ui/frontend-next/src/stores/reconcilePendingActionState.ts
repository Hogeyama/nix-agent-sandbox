/**
 * Pure reducer for the pending-action store.
 *
 * Per-card UI state (selected scope, in-flight busy flag, last error
 * message) is keyed by the composite `key` produced by
 * `pendingRequestKey(domain, sessionId, requestId)`. The state lives in
 * three flat maps so the same `key` indexes all three concerns; cross-
 * domain isolation is provided by the `domain` segment of the key, not
 * by nested maps.
 *
 * SSE reconciliation rule (per `domain`):
 *   - Drop: keys that belong to `domain` but are absent from
 *     `snapshotKeys` are removed from `scopeByKey`, `busyByKey`, and
 *     `errorByKey`. The drop is exhaustive across all three maps so a
 *     stale row cannot leave a dangling busy flag or error message.
 *   - Preserve: keys that are still present in `snapshotKeys` keep their
 *     existing entries untouched.
 *   - Cross-domain: entries whose key does not start with the `domain`
 *     prefix are passed through unchanged. A `network` reconcile cannot
 *     evict `hostexec` state and vice versa.
 *
 * The reducer does not import Solid: it is the canonical contract that
 * `pendingActionStore` delegates to, and the canonical home for the
 * tests that pin SSE drop / preserve / cross-domain behavior.
 */

import type { PendingDomain } from "./pendingRequestKey";

export type PendingActionState = {
  scopeByKey: Readonly<Record<string, string>>;
  busyByKey: Readonly<Record<string, boolean>>;
  errorByKey: Readonly<Record<string, string>>;
};

export function emptyPendingActionState(): PendingActionState {
  return { scopeByKey: {}, busyByKey: {}, errorByKey: {} };
}

/**
 * Apply an SSE snapshot for a single `domain`. Keys that belong to the
 * domain but are not in `snapshotKeys` drop their entries from all three
 * maps; keys still present are preserved; entries from other domains
 * pass through unchanged.
 *
 * `snapshotKeys` is treated as a set; the input may be any iterable so
 * the caller can pass an array of keys derived from the SSE items
 * without paying for a separate Set construction at the call site.
 */
export function reconcilePendingActionState(
  state: PendingActionState,
  domain: PendingDomain,
  snapshotKeys: Iterable<string>,
): PendingActionState {
  const keep = new Set(snapshotKeys);
  const prefix = `${domain}|`;
  return {
    scopeByKey: filterByDomain(state.scopeByKey, prefix, keep),
    busyByKey: filterByDomain(state.busyByKey, prefix, keep),
    errorByKey: filterByDomain(state.errorByKey, prefix, keep),
  };
}

function filterByDomain<V>(
  map: Readonly<Record<string, V>>,
  domainPrefix: string,
  keep: ReadonlySet<string>,
): Record<string, V> {
  const next: Record<string, V> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith(domainPrefix) && !keep.has(k)) continue;
    next[k] = v;
  }
  return next;
}

/**
 * Set the user-selected scope for a key. Returns a new state object;
 * the previous state is not mutated.
 */
export function setScope(
  state: PendingActionState,
  key: string,
  scope: string,
): PendingActionState {
  return {
    ...state,
    scopeByKey: { ...state.scopeByKey, [key]: scope },
  };
}

/**
 * Mark a key as busy and clear any prior error message.
 *
 * Clearing the error is intentional: `beginAction` runs at the start of
 * an Approve/Deny attempt, so the user has implicitly acknowledged the
 * previous failure by retrying.
 */
export function beginAction(
  state: PendingActionState,
  key: string,
): PendingActionState {
  const nextError = removeKey(state.errorByKey, key);
  return {
    ...state,
    busyByKey: { ...state.busyByKey, [key]: true },
    errorByKey: nextError,
  };
}

/**
 * Clear the busy flag for a key. When `errorMessage` is supplied, also
 * record it in `errorByKey`; otherwise clear the previous error so a
 * successful retry does not leave stale text in the UI.
 */
export function endAction(
  state: PendingActionState,
  key: string,
  errorMessage?: string,
): PendingActionState {
  const nextBusy = removeKey(state.busyByKey, key);
  if (errorMessage === undefined) {
    return {
      ...state,
      busyByKey: nextBusy,
      errorByKey: removeKey(state.errorByKey, key),
    };
  }
  return {
    ...state,
    busyByKey: nextBusy,
    errorByKey: { ...state.errorByKey, [key]: errorMessage },
  };
}

function removeKey<V>(
  map: Readonly<Record<string, V>>,
  key: string,
): Record<string, V> {
  if (!(key in map)) return { ...map };
  const next: Record<string, V> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k !== key) next[k] = v;
  }
  return next;
}
