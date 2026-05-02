/**
 * LiteLLM pricing snapshot fetcher and cache for the UI daemon.
 *
 * Provides `getPricingSnapshot()`, the single entry point used by the
 * history cost panel to obtain per-model token prices. The function
 * combines two layers in priority order:
 *
 *   1. On-disk cache at `pricingCachePath()`. Fresh (within 24h of its
 *      embedded `fetched_at`) caches return immediately. Stale caches
 *      return their value but kick a background refresh.
 *   2. Direct LiteLLM fetch on cache miss. The first call awaits the
 *      network (with a 10s timeout) and persists the result; concurrent
 *      callers share that promise via `inFlightFetch`. If the fetch
 *      fails the daemon returns an "unavailable" sentinel snapshot and
 *      the frontend renders prices as "—".
 *
 * The daemon never redistributes a snapshot: pricing data is fetched
 * live from upstream and cached per-user under `$XDG_CACHE_HOME/`.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { ensureDir } from "../lib/fs_utils.ts";
import { pricingCachePath } from "./paths.ts";

/** The four token-cost fields we extract from each LiteLLM model entry. */
export type FourCosts = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
};

/** Provenance of a `PricingSnapshot`. */
export type PricingSource = "litellm" | "unavailable";

export type PricingSnapshot = {
  /** ISO-8601 timestamp; mirrors the cache file's own `fetched_at`. */
  fetched_at: string;
  source: PricingSource;
  /** True when the snapshot is older than the 24h freshness window. */
  stale: boolean;
  models: Record<string, FourCosts>;
};

/**
 * Public LiteLLM price catalogue. Exported as a `const` so tests can
 * assert against it; the production fetcher always uses this exact
 * URL — there is no per-call override.
 */
export const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Module-level memoisation of an in-flight LiteLLM fetch. Concurrent
 * `getPricingSnapshot()` callers that all see a stale or missing cache
 * share this single Promise; whichever promise wins clears the slot.
 *
 * Marked `null` when no fetch is running. Never awaited by the caller
 * path — the snapshot is returned immediately from cache or bundled,
 * and the refresh is fire-and-forget.
 */
let inFlightFetch: Promise<PricingSnapshot | null> | null = null;

/**
 * Reduce a raw LiteLLM JSON object to the `models` map of our snapshot.
 *
 * Behaviour:
 *   - Drops the `sample_spec` meta-sentinel (and any non-object entry).
 *   - Keeps each entry only when at least one of the four token-cost
 *     fields is a finite number; entries with all four absent are
 *     dropped so the consumer can rely on `Object.keys(models)` for the
 *     "models we know about" set.
 *   - Preserves `undefined` for individual fields so the frontend can
 *     render them as "—" without ambiguity.
 *
 * Exported for unit tests; not part of the daemon's public surface.
 */
export function reduceLitellmJson(raw: unknown): Record<string, FourCosts> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, FourCosts> = {};
  for (const [key, rawEntry] of Object.entries(raw)) {
    if (key === "sample_spec") continue;
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Record<string, unknown>;
    const four: FourCosts = {};
    let any = false;
    const fields: (keyof FourCosts)[] = [
      "input_cost_per_token",
      "output_cost_per_token",
      "cache_creation_input_token_cost",
      "cache_read_input_token_cost",
    ];
    for (const f of fields) {
      const v = entry[f];
      if (typeof v === "number" && Number.isFinite(v)) {
        four[f] = v;
        any = true;
      }
    }
    if (any) out[key] = four;
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Fetch the LiteLLM JSON with a 10s timeout. Throws on network error,
 * timeout, non-2xx HTTP status, or malformed JSON. The caller (cache
 * layer) is responsible for falling back to bundled / unavailable.
 *
 * No retries: a single failed attempt is recorded once via the warn
 * log inside the cache layer, and the next call retries naturally on
 * the next 24h boundary or cache-miss.
 */
async function fetchLitellmModels(): Promise<Record<string, FourCosts>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LITELLM_PRICING_URL, { signal: ac.signal });
    if (!res.ok) {
      throw new Error(
        `LiteLLM pricing fetch failed: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const raw = (await res.json()) as unknown;
    return reduceLitellmJson(raw);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Atomically write `snapshot` to `pricingCachePath()`. Uses the
 * `<path>.<random>.tmp` + `rename` pattern from
 * `src/lib/fs_utils.ts:atomicWriteJson` — open here only because we
 * want a domain-specific log message and `mode: 0o644` (the cache is
 * not secret).
 */
async function writeCacheAtomic(snapshot: PricingSnapshot): Promise<void> {
  const target = pricingCachePath();
  const dir = path.dirname(target);
  await ensureDir(dir, 0o755);
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  );
  await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o644,
  });
  await rename(tmp, target);
}

async function readCache(): Promise<PricingSnapshot | null> {
  try {
    const text = await readFile(pricingCachePath(), "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const fetchedAt = obj.fetched_at;
    const models = obj.models;
    if (typeof fetchedAt !== "string") return null;
    if (!models || typeof models !== "object") return null;
    return {
      fetched_at: fetchedAt,
      source: "litellm",
      stale: Boolean(obj.stale),
      models: models as Record<string, FourCosts>,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // ENOENT is the common case (first run); other errors are real
    // problems but still treated as a cache miss so a fresh fetch can
    // take over. We log so the failure is not silent.
    if (code !== "ENOENT") {
      console.warn(
        `[pricing] cache read failed (${code ?? "unknown"}): ${
          (err as Error).message
        }`,
      );
    }
    return null;
  }
}

function isFresh(snapshot: PricingSnapshot): boolean {
  const ts = Date.parse(snapshot.fetched_at);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < FRESHNESS_WINDOW_MS;
}

/**
 * Trigger (or join) a fetch + cache write and return its eventual
 * snapshot. Memoised via `inFlightFetch` so concurrent callers share
 * the same network request. Returns `null` on fetch / write failure;
 * the caller decides whether to surface that as `unavailable`.
 *
 * Errors are logged via `console.warn` so a transient outage is not
 * silently absorbed.
 */
function fetchAndCache(): Promise<PricingSnapshot | null> {
  if (inFlightFetch) return inFlightFetch;
  inFlightFetch = (async () => {
    try {
      const models = await fetchLitellmModels();
      const snapshot: PricingSnapshot = {
        fetched_at: nowIso(),
        source: "litellm",
        stale: false,
        models,
      };
      await writeCacheAtomic(snapshot);
      return snapshot;
    } catch (err) {
      console.warn(`[pricing] live fetch failed: ${(err as Error).message}`);
      return null;
    } finally {
      inFlightFetch = null;
    }
  })();
  return inFlightFetch;
}

/**
 * Public entrypoint. Always resolves with a `PricingSnapshot` — never
 * throws — so callers can render unconditionally and let the `source`
 * / `stale` fields drive the UX.
 *
 * Cold start blocks on a single live fetch (10s timeout); subsequent
 * calls within the freshness window hit the on-disk cache. Stale
 * caches are returned immediately while a background refresh runs.
 */
export async function getPricingSnapshot(): Promise<PricingSnapshot> {
  const cached = await readCache();
  if (cached) {
    if (isFresh(cached)) {
      return { ...cached, stale: false };
    }
    // Stale: return immediately, refresh in background (fire-and-forget).
    fetchAndCache().catch(() => {});
    return { ...cached, stale: true };
  }

  // Cache miss: await a live fetch so the first opening of the panel
  // has real prices to render rather than a transient "unavailable".
  const fresh = await fetchAndCache();
  if (fresh) return fresh;

  // Fetch failed and no cache exists — surface an explicit sentinel so
  // the frontend can degrade gracefully ("—" everywhere).
  return {
    fetched_at: nowIso(),
    source: "unavailable",
    stale: true,
    models: {},
  };
}

/**
 * Test-only escape hatch. Resets the in-flight memo so each test
 * starts with a clean slate. Not exported via the package's public
 * surface (no barrel file); intended for `pricing_test.ts` only.
 */
export function __resetPricingForTests(): void {
  inFlightFetch = null;
}

/** Test-only: surface the current in-flight fetch promise (or `null`). */
export function __inFlightFetchForTests(): Promise<unknown> | null {
  return inFlightFetch;
}
