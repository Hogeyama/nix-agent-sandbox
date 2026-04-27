/**
 * Solid store for per-card pending-action UI state.
 *
 * Holds the user's selected scope, in-flight busy flag, and last error
 * message for each pending row, keyed by the composite `key` produced
 * by `pendingRequestKey`. The state itself and the reduction rules
 * (drop / preserve / cross-domain) live in
 * `reconcilePendingActionState.ts`; this file is the Solid surface that
 * delegates every state transition to that reducer.
 *
 * The store does not import any normalization or domain branching: it
 * is intentionally a thin reactive wrapper. Tests that pin the
 * reduction semantics live alongside the reducer, not here.
 */

import { createStore } from "solid-js/store";
import type { PendingDomain } from "./pendingRequestKey";
import {
  beginAction as beginActionPure,
  emptyPendingActionState,
  endAction as endActionPure,
  type PendingActionState,
  reconcilePendingActionState,
  setScope as setScopePure,
} from "./reconcilePendingActionState";

export type PendingActionStore = {
  scopeFor: (key: string) => string | undefined;
  busyFor: (key: string) => boolean;
  errorFor: (key: string) => string | null;
  setScope: (key: string, scope: string) => void;
  beginAction: (key: string) => void;
  endAction: (key: string, errorMessage?: string) => void;
  reconcile: (domain: PendingDomain, snapshotKeys: Iterable<string>) => void;
};

export function createPendingActionStore(): PendingActionStore {
  const [state, setState] = createStore<PendingActionState>(
    emptyPendingActionState(),
  );
  return {
    scopeFor: (key) => state.scopeByKey[key],
    busyFor: (key) => state.busyByKey[key] === true,
    errorFor: (key) => state.errorByKey[key] ?? null,
    setScope: (key, scope) => {
      setState((s) => setScopePure(s, key, scope));
    },
    beginAction: (key) => {
      setState((s) => beginActionPure(s, key));
    },
    endAction: (key, errorMessage) => {
      setState((s) => endActionPure(s, key, errorMessage));
    },
    reconcile: (domain, snapshotKeys) => {
      setState((s) => reconcilePendingActionState(s, domain, snapshotKeys));
    },
  };
}
