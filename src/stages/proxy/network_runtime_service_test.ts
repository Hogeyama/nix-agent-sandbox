/**
 * NetworkRuntimeService unit tests (no real fs).
 *
 * Drives the Live service with a fake FsService layer so we
 * exercise the real ensureRuntimeDirs and copyAddonScript branching logic
 * without touching disk.
 */

import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { makeFsServiceFake } from "../../services/fs.ts";
import { makeProcessServiceFake } from "../../services/process.ts";
import {
  NetworkRuntimeService,
  NetworkRuntimeServiceLive,
} from "./network_runtime_service.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function paths(): NetworkRuntimePaths {
  const root = "/run/user/1000/nas/xyz/network";
  return {
    runtimeDir: root,
    sessionsDir: `${root}/sessions`,
    pendingDir: `${root}/pending`,
    brokersDir: `${root}/brokers`,
    caCertDir: `${root}/mitmproxy-ca`,
    addonScriptPath: `${root}/nas_addon.py`,
    reviewRulesDir: `${root}/review-rules`,
  };
}

function makeLiveLayer(
  fsFake: ReturnType<typeof makeFsServiceFake>,
): Layer.Layer<NetworkRuntimeService> {
  return NetworkRuntimeServiceLive.pipe(
    Layer.provide(Layer.mergeAll(fsFake.layer, makeProcessServiceFake())),
  );
}

async function runGc(
  fsFake: ReturnType<typeof makeFsServiceFake>,
): Promise<void> {
  const live = makeLiveLayer(fsFake);
  await Effect.runPromise(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      svc.gcStaleRuntime(paths()),
    ).pipe(Effect.provide(live)),
  );
}

// ---------------------------------------------------------------------------
// gcStaleRuntime
// ---------------------------------------------------------------------------

test("gcStaleRuntime: is a no-op", async () => {
  const fsFake = makeFsServiceFake();
  // gcStaleRuntime is now a no-op (Effect.void); just assert it completes.
  await runGc(fsFake);
  // No files should have been touched.
  expect(fsFake.store.size).toEqual(0);
});

// ---------------------------------------------------------------------------
// writeReviewRules
// ---------------------------------------------------------------------------

test("writeReviewRules: writes JSON file to reviewRulesDir", async () => {
  const fsFake = makeFsServiceFake();
  const p = paths();
  const live = makeLiveLayer(fsFake);

  const rules = [{ pattern: "*.example.com", action: "allow" as const }];
  await Effect.runPromise(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      svc.writeReviewRules(p, "sess-123", rules as never),
    ).pipe(Effect.provide(live)),
  );

  const rulesPath = `${p.reviewRulesDir}/sess-123.json`;
  expect(fsFake.store.has(rulesPath)).toEqual(true);
  const stored = fsFake.store.get(rulesPath);
  expect(JSON.parse(stored!.content)).toEqual(rules);
});
