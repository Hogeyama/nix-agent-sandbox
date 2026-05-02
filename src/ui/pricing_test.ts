/**
 * Tests for the LiteLLM pricing snapshot fetcher and cache layer.
 *
 * The cache has three branches we care about:
 *   - fresh cache (within 24h) -> return cache, no network
 *   - stale cache (>24h)       -> return cache + kick refresh
 *   - cache miss               -> bundled fallback + kick refresh
 *                                 (bundled missing -> "unavailable")
 *
 * The reducer is also tested in isolation since it implements the
 * sample_spec / all-undefined drop rules that callers depend on.
 *
 * `globalThis.fetch` is swapped per test (mirroring the pattern in
 * `src/ui/frontend/src/api/client_test.ts`) and a per-test temp
 * directory is wired into `XDG_CACHE_HOME` so the on-disk cache is
 * isolated from the host's real `~/.cache/nas`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pricingCacheDir, pricingCachePath } from "./paths.ts";
import {
  __inFlightFetchForTests,
  __resetPricingForTests,
  getPricingSnapshot,
  LITELLM_PRICING_URL,
  reduceLitellmJson,
} from "./pricing.ts";

type FetchFn = typeof globalThis.fetch;
type FetchImpl = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

let originalFetch: FetchFn;
let originalXdgCache: string | undefined;
let originalHome: string | undefined;
let tmpRoot: string;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  originalXdgCache = process.env.XDG_CACHE_HOME;
  originalHome = process.env.HOME;
  tmpRoot = await mkdtemp(path.join(tmpdir(), "nas-pricing-"));
  process.env.XDG_CACHE_HOME = tmpRoot;
  __resetPricingForTests();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCache;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  __resetPricingForTests();
  await rm(tmpRoot, { recursive: true, force: true });
});

function installFetch(impl: FetchImpl): ReturnType<typeof mock<FetchImpl>> {
  const fn = mock(impl);
  globalThis.fetch = fn as unknown as FetchFn;
  return fn;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

/**
 * Wait until `__inFlightFetchForTests()` either becomes null or its
 * promise resolves. The fetcher is fire-and-forget, so tests that
 * assert on its side effects (cache writes) need a deterministic
 * wait that doesn't depend on `setTimeout(0)` quirks.
 */
async function awaitInFlight(): Promise<void> {
  const p = __inFlightFetchForTests();
  if (p) {
    try {
      await p;
    } catch {
      // background errors are intentionally swallowed by the module
    }
  }
}

describe("reduceLitellmJson", () => {
  test("skips the sample_spec meta sentinel", () => {
    const out = reduceLitellmJson({
      sample_spec: { input_cost_per_token: 1 },
      "real-model": { input_cost_per_token: 0.000003 },
    });
    expect(out).not.toHaveProperty("sample_spec");
    expect(out["real-model"]?.input_cost_per_token).toBe(0.000003);
  });

  test("drops entries with all four cost fields absent", () => {
    const out = reduceLitellmJson({
      "model-a": { max_tokens: 1000 }, // no cost fields
      "model-b": { input_cost_per_token: 0.0001 },
    });
    expect(out).not.toHaveProperty("model-a");
    expect(out).toHaveProperty("model-b");
  });

  test("preserves only finite numeric cost fields", () => {
    const out = reduceLitellmJson({
      "model-a": {
        input_cost_per_token: 0.00001,
        output_cost_per_token: "not-a-number",
        cache_creation_input_token_cost: Number.NaN,
        cache_read_input_token_cost: 0.000005,
      },
    });
    expect(out["model-a"]).toEqual({
      input_cost_per_token: 0.00001,
      cache_read_input_token_cost: 0.000005,
    });
  });

  test("returns empty for non-object input", () => {
    expect(reduceLitellmJson(null)).toEqual({});
    expect(reduceLitellmJson("string")).toEqual({});
    expect(reduceLitellmJson(42)).toEqual({});
  });

  test("preserves above-200k upper-tier rates alongside base rates", () => {
    const out = reduceLitellmJson({
      "claude-opus-4-7": {
        input_cost_per_token: 0.000015,
        output_cost_per_token: 0.000075,
        cache_creation_input_token_cost: 0.00001875,
        cache_read_input_token_cost: 0.0000015,
        input_cost_per_token_above_200k_tokens: 0.00003,
        output_cost_per_token_above_200k_tokens: 0.0001125,
        cache_creation_input_token_cost_above_200k_tokens: 0.0000375,
        cache_read_input_token_cost_above_200k_tokens: 0.000003,
      },
    });
    expect(out["claude-opus-4-7"]).toEqual({
      input_cost_per_token: 0.000015,
      output_cost_per_token: 0.000075,
      cache_creation_input_token_cost: 0.00001875,
      cache_read_input_token_cost: 0.0000015,
      input_cost_per_token_above_200k_tokens: 0.00003,
      output_cost_per_token_above_200k_tokens: 0.0001125,
      cache_creation_input_token_cost_above_200k_tokens: 0.0000375,
      cache_read_input_token_cost_above_200k_tokens: 0.000003,
    });
  });

  test("drops entries that have only above-200k rates without a base rate", () => {
    // A key with no base rates is unusable: the consumer cannot price
    // the below-threshold bucket. The reducer admits a key only when at
    // least one base rate is present.
    const out = reduceLitellmJson({
      "above-only": {
        input_cost_per_token_above_200k_tokens: 0.00003,
      },
    });
    expect(out).not.toHaveProperty("above-only");
  });
});

describe("getPricingSnapshot", () => {
  test("cache hit within TTL: returns cache, no network call", async () => {
    const cachePath = pricingCachePath();
    await writeFile(
      cachePath,
      JSON.stringify({
        fetched_at: new Date().toISOString(),
        source: "litellm",
        stale: false,
        models: { "model-x": { input_cost_per_token: 0.000001 } },
      }),
      // ensureDir handles parent creation on the write path; here we
      // need the parent ourselves before writing.
    ).catch(async () => {
      await Bun.write(cachePath, ""); // ensure parent
      await writeFile(
        cachePath,
        JSON.stringify({
          fetched_at: new Date().toISOString(),
          source: "litellm",
          stale: false,
          models: { "model-x": { input_cost_per_token: 0.000001 } },
        }),
      );
    });

    const fetchMock = installFetch(async () => {
      throw new Error("fetch should not be called on fresh cache");
    });

    const snap = await getPricingSnapshot();
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(snap.source).toBe("litellm");
    expect(snap.stale).toBe(false);
    expect(snap.models["model-x"]?.input_cost_per_token).toBe(0.000001);
  });

  test("stale cache (>24h): returns cache marked stale and kicks background refresh", async () => {
    const cachePath = pricingCachePath();
    // Pre-create the cache directory by writing a stale file.
    const oldIso = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await Bun.write(
      cachePath,
      JSON.stringify({
        fetched_at: oldIso,
        source: "litellm",
        stale: false,
        models: { "old-model": { input_cost_per_token: 0.0000005 } },
      }),
    );

    const fetchMock = installFetch(async () =>
      jsonResponse({
        "fresh-model": { input_cost_per_token: 0.0000009 },
      }),
    );

    const snap = await getPricingSnapshot();
    expect(snap.stale).toBe(true);
    expect(snap.models["old-model"]).toBeDefined();
    // Background refresh should have been kicked but not awaited.
    await awaitInFlight();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cache should now contain the fresh entry.
    const written = JSON.parse(await readFile(cachePath, "utf8"));
    expect(written.source).toBe("litellm");
    expect(written.models["fresh-model"]).toBeDefined();
    expect(written.models["old-model"]).toBeUndefined();
  });

  test("cache miss + online OK: awaits the live fetch and returns the freshly-cached snapshot", async () => {
    const fetchMock = installFetch(async () =>
      jsonResponse({
        "online-model": { output_cost_per_token: 0.000008 },
      }),
    );

    const snap = await getPricingSnapshot();
    expect(snap.source).toBe("litellm");
    expect(snap.stale).toBe(false);
    expect(snap.models["online-model"]).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cache must reflect the fetched payload after the awaited write.
    const written = JSON.parse(await readFile(pricingCachePath(), "utf8"));
    expect(written.source).toBe("litellm");
    expect(written.models["online-model"]).toBeDefined();
  });

  test("cache miss + offline: surfaces the 'unavailable' sentinel without writing a cache", async () => {
    const fetchMock = installFetch(async () => {
      throw new Error("network down");
    });

    const snap = await getPricingSnapshot();
    expect(snap.source).toBe("unavailable");
    expect(snap.stale).toBe(true);
    expect(snap.models).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cache file must not exist after a failed fetch: partial /
    // corrupted cache writes are the precise failure mode the
    // atomic-write guard exists to prevent.
    let cacheStillMissing = false;
    try {
      await readFile(pricingCachePath(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        cacheStillMissing = true;
      }
    }
    expect(cacheStillMissing).toBe(true);
  });

  test("non-2xx response surfaces as 'unavailable' (no cache write)", async () => {
    installFetch(
      async () =>
        new Response("rate limited", {
          status: 429,
          statusText: "Too Many Requests",
        }),
    );
    const snap = await getPricingSnapshot();
    expect(snap.source).toBe("unavailable");
    let cacheMissing = false;
    try {
      await readFile(pricingCachePath(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        cacheMissing = true;
      }
    }
    expect(cacheMissing).toBe(true);
  });

  test("malformed JSON from upstream is treated as a fetch failure", async () => {
    installFetch(
      async () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const snap = await getPricingSnapshot();
    expect(snap.source).toBe("unavailable");
    let cacheMissing = false;
    try {
      await readFile(pricingCachePath(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        cacheMissing = true;
      }
    }
    expect(cacheMissing).toBe(true);
  });

  test("hits the canonical LITELLM_PRICING_URL on the live fetch", async () => {
    const fetchMock = installFetch(async () =>
      jsonResponse({ m: { input_cost_per_token: 0.001 } }),
    );
    await getPricingSnapshot();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(LITELLM_PRICING_URL);
  });

  test("concurrent callers share a single in-flight fetch (race / memoise)", async () => {
    let resolveFetch: ((res: Response) => void) | null = null;
    const fetchMock = installFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    // Two concurrent callers, both seeing cache miss.
    const pending = Promise.all([getPricingSnapshot(), getPricingSnapshot()]);

    // Wait until the cache-miss + fetcher pipeline has actually
    // reached `fetch()`. `readCache` performs a real `readFile`
    // syscall, so the gap between calling `getPricingSnapshot` and
    // hitting the network is measured in I/O ticks, not microtasks.
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && fetchMock.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Only one fetch should be in flight despite two callers.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Resolve and let both callers settle on the same response.
    if (resolveFetch) {
      (resolveFetch as (res: Response) => void)(
        jsonResponse({ m: { input_cost_per_token: 0.001 } }),
      );
    }
    const [snap1, snap2] = await pending;
    expect(snap1.source).toBe("litellm");
    expect(snap2.source).toBe("litellm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("atomic write: no partial JSON file exists in the cache directory after a successful fetch", async () => {
    installFetch(async () =>
      jsonResponse({ m: { input_cost_per_token: 0.001 } }),
    );
    await getPricingSnapshot();

    const dir = pricingCacheDir();
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    // Only the canonical file should remain; .tmp scratch files
    // must be renamed away (or, on failure, would be left behind).
    expect(entries).toContain("litellm.json");
    for (const e of entries) {
      expect(e.endsWith(".tmp")).toBe(false);
    }
  });

  test("corrupted cache JSON is treated as a miss and triggers a live fetch", async () => {
    await Bun.write(pricingCachePath(), "{not valid json");
    installFetch(async () =>
      jsonResponse({ "fresh-model": { input_cost_per_token: 0.000002 } }),
    );
    const snap = await getPricingSnapshot();
    expect(snap.source).toBe("litellm");
    expect(snap.models["fresh-model"]).toBeDefined();
  });
});
