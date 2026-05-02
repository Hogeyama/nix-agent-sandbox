/**
 * Solid resource owner for the history pricing snapshot.
 *
 * The daemon may return a stale cache immediately while refreshing the
 * LiteLLM catalogue in the background. Polling from the mounted History
 * shell lets open history pages pick up that refreshed snapshot without
 * requiring a reload or route remount.
 */

import { createResource, onCleanup, type Resource } from "solid-js";
import { fetchPricingSnapshot, type PricingSnapshot } from "../../api/client";

export const PRICING_SNAPSHOT_REFRESH_MS = 60_000;

/**
 * Fallback snapshot used when the `/api/pricing/snapshot` resource
 * rejects (transport blip, daemon outage). Renders identically to the
 * daemon's own `unavailable` sentinel.
 */
const UNAVAILABLE_SNAPSHOT: PricingSnapshot = {
  fetched_at: new Date(0).toISOString(),
  source: "unavailable",
  stale: true,
  models: {},
};

type TimerHandle = unknown;

export interface PricingSnapshotResourceDeps {
  fetchSnapshot?: () => Promise<PricingSnapshot>;
  setInterval?: (cb: () => void, ms: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
  warn?: (...args: unknown[]) => void;
}

export async function fetchPricingSnapshotOrUnavailable(
  deps: Pick<PricingSnapshotResourceDeps, "fetchSnapshot" | "warn"> = {},
): Promise<PricingSnapshot> {
  const fetchSnapshot = deps.fetchSnapshot ?? fetchPricingSnapshot;
  const warn = deps.warn ?? console.warn;
  try {
    return await fetchSnapshot();
  } catch (err) {
    warn("[HistoryShell] pricing snapshot fetch failed:", err);
    return UNAVAILABLE_SNAPSHOT;
  }
}

export function startPricingSnapshotPolling(
  refetch: () => unknown,
  deps: Pick<PricingSnapshotResourceDeps, "setInterval" | "clearInterval"> = {},
): () => void {
  const setIntervalFn =
    deps.setInterval ??
    ((cb: () => void, ms: number): TimerHandle =>
      globalThis.setInterval(cb, ms));
  const clearIntervalFn =
    deps.clearInterval ??
    ((handle: TimerHandle): void => {
      globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
    });

  const interval = setIntervalFn(() => {
    void refetch();
  }, PRICING_SNAPSHOT_REFRESH_MS);
  return () => clearIntervalFn(interval);
}

export function createPricingSnapshotResource(
  deps: PricingSnapshotResourceDeps = {},
): Resource<PricingSnapshot> {
  const [pricingSnapshot, { refetch }] = createResource<PricingSnapshot>(
    async () => fetchPricingSnapshotOrUnavailable(deps),
  );

  const stopPolling = startPricingSnapshotPolling(refetch, deps);
  onCleanup(stopPolling);

  return pricingSnapshot;
}
