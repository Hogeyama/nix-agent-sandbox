/**
 * Solid store for the Sidecars settings page.
 *
 * The store accepts the same `ContainerInfoLike[]` snapshot that the
 * sessions store consumes; each store filters by `nas.kind` so the SSE
 * dispatcher can fan a single `containers` event out to both stores
 * without coordination. Field-level normalization (kind validation,
 * deterministic sort, nullable `startedAt`) lives in `sidecarRowView`
 * so the store is a thin reactive wrapper around it.
 */

import { createStore } from "solid-js/store";
import {
  normalizeSidecars,
  type SidecarRow,
} from "../components/settings/sidecarRowView";
import type { ContainerInfoLike } from "./types";

export type SidecarsStore = {
  rows: () => SidecarRow[];
  setSidecars: (items: ContainerInfoLike[]) => void;
};

/**
 * Build a fresh sidecars store. The initial state is an empty rows
 * array; an empty SSE snapshot therefore correctly leaves the rendered
 * table empty until the daemon reports at least one sidecar.
 */
export function createSidecarsStore(): SidecarsStore {
  const [state, setState] = createStore<{ rows: SidecarRow[] }>({ rows: [] });
  return {
    rows: () => state.rows,
    setSidecars: (items) => setState("rows", normalizeSidecars(items)),
  };
}
