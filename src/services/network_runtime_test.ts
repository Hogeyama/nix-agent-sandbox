/**
 * NetworkRuntimeService unit tests (no real fs / no real process).
 *
 * Drives the Live service with fake FsService + ProcessService layers so we
 * exercise the real gcStaleRuntime branching logic without touching disk.
 */

import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type { NetworkRuntimePaths } from "../network/registry.ts";
import { makeFsServiceFake } from "./fs.ts";
import {
  NetworkRuntimeService,
  NetworkRuntimeServiceLive,
} from "./network_runtime.ts";
import { makeProcessServiceFake, type ProcessService } from "./process.ts";

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
    authRouterPidFile: `${root}/auth-router.pid`,
    authRouterSocket: `${root}/auth-router.sock`,
    envoyConfigFile: `${root}/envoy.yaml`,
  };
}

interface ExecCall {
  cmd: string[];
}

function fakeProc(
  execImpl: (cmd: string[]) => Effect.Effect<string, unknown>,
  calls: ExecCall[],
): Layer.Layer<ProcessService> {
  return makeProcessServiceFake({
    // The service tag types exec as Effect<string> (no error channel) because
    // the live impl uses Effect.orDie. Tests need to simulate command failure,
    // so we allow a typed error here and cast back to the tag shape. At
    // runtime Effect routes the failure through catchAll in gcStaleRuntime.
    exec: (cmd) => {
      calls.push({ cmd });
      return execImpl(cmd) as Effect.Effect<string>;
    },
  });
}

async function runGc(
  fsFake: ReturnType<typeof makeFsServiceFake>,
  procLayer: Layer.Layer<ProcessService>,
): Promise<void> {
  const live = NetworkRuntimeServiceLive.pipe(
    Layer.provide(Layer.mergeAll(fsFake.layer, procLayer)),
  );
  await Effect.runPromise(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      svc.gcStaleRuntime(paths()),
    ).pipe(Effect.provide(live)),
  );
}

// ---------------------------------------------------------------------------
// gcStaleRuntime
// ---------------------------------------------------------------------------

test("gcStaleRuntime: no-op when pid file does not exist", async () => {
  const fsFake = makeFsServiceFake();
  const calls: ExecCall[] = [];
  await runGc(
    fsFake,
    fakeProc(() => Effect.succeed(""), calls),
  );
  // No kill -0 call was needed.
  expect(calls.length).toEqual(0);
});

test("gcStaleRuntime: removes pid file + socket when pid is not a number", async () => {
  const fsFake = makeFsServiceFake();
  const p = paths();
  fsFake.store.set(p.authRouterPidFile, { content: "not-a-pid", mode: 0o644 });
  fsFake.store.set(p.authRouterSocket, { content: "", mode: 0o600 });

  const calls: ExecCall[] = [];
  await runGc(
    fsFake,
    fakeProc(() => Effect.succeed(""), calls),
  );

  expect(calls.length).toEqual(0);
  expect(fsFake.store.has(p.authRouterPidFile)).toEqual(false);
  expect(fsFake.store.has(p.authRouterSocket)).toEqual(false);
});

test("gcStaleRuntime: keeps pid file + socket when the process is alive", async () => {
  const fsFake = makeFsServiceFake();
  const p = paths();
  fsFake.store.set(p.authRouterPidFile, { content: "12345\n", mode: 0o644 });
  fsFake.store.set(p.authRouterSocket, { content: "", mode: 0o600 });

  const calls: ExecCall[] = [];
  await runGc(
    fsFake,
    fakeProc(() => Effect.succeed(""), calls),
  );

  expect(calls).toEqual([{ cmd: ["kill", "-0", "12345"] }]);
  // The "alive" case leaves everything in place.
  expect(fsFake.store.has(p.authRouterPidFile)).toEqual(true);
  expect(fsFake.store.has(p.authRouterSocket)).toEqual(true);
});

test("gcStaleRuntime: cleans up when the process is dead", async () => {
  const fsFake = makeFsServiceFake();
  const p = paths();
  fsFake.store.set(p.authRouterPidFile, { content: "99999", mode: 0o644 });
  fsFake.store.set(p.authRouterSocket, { content: "", mode: 0o600 });

  const calls: ExecCall[] = [];
  await runGc(
    fsFake,
    fakeProc(() => Effect.fail(new Error("no such process")), calls),
  );

  expect(calls.length).toEqual(1);
  expect(fsFake.store.has(p.authRouterPidFile)).toEqual(false);
  expect(fsFake.store.has(p.authRouterSocket)).toEqual(false);
});

test("gcStaleRuntime: dead process cleanup survives missing socket", async () => {
  // Only the pid file exists; the socket rm should be swallowed.
  const fsFake = makeFsServiceFake();
  const p = paths();
  fsFake.store.set(p.authRouterPidFile, { content: "99999", mode: 0o644 });
  // Note: authRouterSocket NOT in store.

  const calls: ExecCall[] = [];
  await runGc(
    fsFake,
    fakeProc(() => Effect.fail(new Error("no such process")), calls),
  );

  expect(fsFake.store.has(p.authRouterPidFile)).toEqual(false);
});

// ---------------------------------------------------------------------------
// renderEnvoyConfig
// ---------------------------------------------------------------------------

test("renderEnvoyConfig: reads template and writes it to paths.envoyConfigFile", async () => {
  // Use Live FsService so resolveAsset can locate the real template file.
  // Only the destination write is verified (into a tmp dir via the fake).
  const { FsServiceLive } = await import("./fs.ts");
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");

  const tmp = await mkdtemp(pathMod.join(tmpdir(), "nas-nrs-"));
  try {
    const p: NetworkRuntimePaths = {
      ...paths(),
      envoyConfigFile: pathMod.join(tmp, "envoy.yaml"),
    };

    const live = NetworkRuntimeServiceLive.pipe(
      Layer.provide(Layer.mergeAll(FsServiceLive, makeProcessServiceFake())),
    );
    await Effect.runPromise(
      Effect.flatMap(NetworkRuntimeService, (svc) =>
        svc.renderEnvoyConfig(p),
      ).pipe(Effect.provide(live)),
    );

    const written = await readFile(p.envoyConfigFile, "utf8");
    // The envoy template must be non-empty YAML.
    expect(written.length).toBeGreaterThan(0);
    expect(written).toContain("static_resources");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
