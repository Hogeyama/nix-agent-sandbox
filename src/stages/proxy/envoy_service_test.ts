/**
 * EnvoyService unit tests (no Docker required).
 *
 * Exercises EnvoyServiceLive against a fake DockerService to pin down:
 *   - ensureSharedEnvoy's idempotency + stale cleanup + readiness loop
 *   - createSessionNetwork's connect order, optional dind wiring, and
 *     the teardown finalizer shape.
 */

import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  NAS_KIND_ENVOY,
  NAS_KIND_LABEL,
  NAS_KIND_SESSION_NETWORK,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "../../docker/nas_resources.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import {
  type DockerRunDetachedOpts,
  type DockerService,
  makeDockerServiceFake,
} from "../../services/docker.ts";
import {
  type EnsureEnvoyPlan,
  EnvoyService,
  EnvoyServiceLive,
  type SessionNetworkPlan,
} from "./envoy_service.ts";

// ---------------------------------------------------------------------------
// Docker fake with call recording
// ---------------------------------------------------------------------------

interface DockerCalls {
  isRunning: string[];
  containerExists: string[];
  rm: string[];
  runDetached: DockerRunDetachedOpts[];
  logs: string[];
  networkCreate: Array<{
    name: string;
    opts: { internal?: boolean; labels?: Record<string, string> };
  }>;
  networkConnect: Array<{
    network: string;
    container: string;
    opts?: { aliases?: string[] };
  }>;
  networkDisconnect: Array<{ network: string; container: string }>;
  networkRemove: string[];
}

function freshCalls(): DockerCalls {
  return {
    isRunning: [],
    containerExists: [],
    rm: [],
    runDetached: [],
    logs: [],
    networkCreate: [],
    networkConnect: [],
    networkDisconnect: [],
    networkRemove: [],
  };
}

function makeDockerFake(
  calls: DockerCalls,
  overrides: {
    isRunning?: (name: string) => boolean;
    containerExists?: (name: string) => boolean;
    logs?: (name: string) => string;
    rm?: (name: string) => Effect.Effect<void>;
    networkCreate?: (
      name: string,
      opts: { internal?: boolean; labels?: Record<string, string> },
    ) => Effect.Effect<void>;
    networkConnect?: (
      network: string,
      container: string,
      opts?: { aliases?: string[] },
    ) => Effect.Effect<void>;
    networkDisconnect?: (
      network: string,
      container: string,
    ) => Effect.Effect<void>;
    networkRemove?: (network: string) => Effect.Effect<void>;
  } = {},
): Layer.Layer<DockerService> {
  return makeDockerServiceFake({
    isRunning: (name) => {
      calls.isRunning.push(name);
      return Effect.succeed(overrides.isRunning?.(name) ?? false);
    },
    containerExists: (name) => {
      calls.containerExists.push(name);
      return Effect.succeed(overrides.containerExists?.(name) ?? false);
    },
    rm: (name) => {
      calls.rm.push(name);
      return overrides.rm?.(name) ?? Effect.void;
    },
    runDetached: (opts) => {
      calls.runDetached.push(opts);
      return Effect.succeed(opts.name);
    },
    logs: (name) => {
      calls.logs.push(name);
      return Effect.succeed(overrides.logs?.(name) ?? "");
    },
    networkCreate: (name, opts) => {
      calls.networkCreate.push({ name, opts });
      return overrides.networkCreate?.(name, opts) ?? Effect.void;
    },
    networkConnect: (network, container, opts) => {
      calls.networkConnect.push({ network, container, opts });
      return (
        overrides.networkConnect?.(network, container, opts) ?? Effect.void
      );
    },
    networkDisconnect: (network, container) => {
      calls.networkDisconnect.push({ network, container });
      return overrides.networkDisconnect?.(network, container) ?? Effect.void;
    },
    networkRemove: (network) => {
      calls.networkRemove.push(network);
      return overrides.networkRemove?.(network) ?? Effect.void;
    },
  });
}

function runtimePaths(): NetworkRuntimePaths {
  const root = "/run/user/1000/nas/abc/network";
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

function envoyPlan(overrides: Partial<EnsureEnvoyPlan> = {}): EnsureEnvoyPlan {
  return {
    envoyContainerName: "nas-envoy-shared",
    envoyImage: "nas-envoy:latest",
    runtimePaths: runtimePaths(),
    envoyReadyTimeoutMs: 1000,
    ...overrides,
  };
}

function runWithEnvoy<A, E>(
  effect: (
    svc: Effect.Effect.Success<typeof EnvoyService>,
  ) => Effect.Effect<A, E>,
  dockerLayer: Layer.Layer<DockerService>,
): Promise<A> {
  const layer = Layer.provide(EnvoyServiceLive, dockerLayer);
  return Effect.runPromise(
    Effect.flatMap(EnvoyService, effect).pipe(Effect.provide(layer)),
  ) as Promise<A>;
}

// ---------------------------------------------------------------------------
// ensureSharedEnvoy
// ---------------------------------------------------------------------------

test("ensureSharedEnvoy: skips when envoy is already running", async () => {
  const calls = freshCalls();
  const layer = makeDockerFake(calls, { isRunning: () => true });

  await runWithEnvoy((svc) => svc.ensureSharedEnvoy(envoyPlan()), layer);

  expect(calls.isRunning).toEqual(["nas-envoy-shared"]);
  expect(calls.containerExists.length).toEqual(0);
  expect(calls.runDetached.length).toEqual(0);
  expect(calls.rm.length).toEqual(0);
});

test("ensureSharedEnvoy: removes stale container before launching", async () => {
  const calls = freshCalls();
  let launched = false;
  const layer = makeDockerServiceFake({
    isRunning: (name) => {
      calls.isRunning.push(name);
      return Effect.succeed(launched);
    },
    containerExists: (name) => {
      calls.containerExists.push(name);
      return Effect.succeed(true);
    },
    rm: (name) => {
      calls.rm.push(name);
      return Effect.void;
    },
    runDetached: (opts) => {
      calls.runDetached.push(opts);
      launched = true;
      return Effect.succeed(opts.name);
    },
  });

  await runWithEnvoy((svc) => svc.ensureSharedEnvoy(envoyPlan()), layer);

  expect(calls.rm).toEqual(["nas-envoy-shared"]);
  expect(calls.runDetached.length).toEqual(1);
  // First isRunning check happens before containerExists/rm
  expect(calls.isRunning.length).toBeGreaterThanOrEqual(2);
});

test("ensureSharedEnvoy: tolerates rm failure and still launches", async () => {
  const calls = freshCalls();
  let launched = false;
  const wrappedLayer: Layer.Layer<DockerService> = makeDockerServiceFake({
    isRunning: (name) => {
      calls.isRunning.push(name);
      return Effect.succeed(launched);
    },
    containerExists: (name) => {
      calls.containerExists.push(name);
      return Effect.succeed(true);
    },
    rm: (name) => {
      calls.rm.push(name);
      return Effect.fail(new Error("boom")) as unknown as Effect.Effect<void>;
    },
    runDetached: (opts) => {
      calls.runDetached.push(opts);
      launched = true;
      return Effect.succeed(opts.name);
    },
    logs: (name) => {
      calls.logs.push(name);
      return Effect.succeed("");
    },
  });

  await runWithEnvoy((svc) => svc.ensureSharedEnvoy(envoyPlan()), wrappedLayer);

  expect(calls.rm).toEqual(["nas-envoy-shared"]);
  expect(calls.runDetached.length).toEqual(1);
});

test("ensureSharedEnvoy: launches with correct labels, mounts, and command", async () => {
  const calls = freshCalls();
  let launched = false;
  const layer = makeDockerServiceFake({
    isRunning: (name) => {
      calls.isRunning.push(name);
      return Effect.succeed(launched);
    },
    containerExists: (name) => {
      calls.containerExists.push(name);
      return Effect.succeed(false);
    },
    runDetached: (opts) => {
      calls.runDetached.push(opts);
      launched = true;
      return Effect.succeed(opts.name);
    },
  });

  const plan = envoyPlan({
    envoyContainerName: "nas-envoy-shared",
    envoyImage: "my-envoy:1.2",
  });
  await runWithEnvoy((svc) => svc.ensureSharedEnvoy(plan), layer);

  expect(calls.runDetached.length).toEqual(1);
  const run = calls.runDetached[0];
  expect(run.name).toEqual("nas-envoy-shared");
  expect(run.image).toEqual("my-envoy:1.2");
  expect(run.args).toEqual(["--add-host=host.docker.internal:host-gateway"]);
  expect(run.mounts).toEqual([
    {
      source: plan.runtimePaths.runtimeDir,
      target: "/nas-network",
      mode: "rw",
    },
  ]);
  expect(run.labels).toEqual({
    [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
    [NAS_KIND_LABEL]: NAS_KIND_ENVOY,
  });
  expect(run.command).toEqual([
    "-c",
    "/nas-network/envoy.yaml",
    "--log-level",
    "info",
  ]);
});

test("ensureSharedEnvoy: fails with logs when readiness times out", async () => {
  const calls = freshCalls();
  // runDetached succeeds but isRunning stays false so readiness times out.
  const layer = makeDockerServiceFake({
    isRunning: (name) => {
      calls.isRunning.push(name);
      return Effect.succeed(false);
    },
    containerExists: (name) => {
      calls.containerExists.push(name);
      return Effect.succeed(false);
    },
    runDetached: (opts) => {
      calls.runDetached.push(opts);
      return Effect.succeed(opts.name);
    },
    logs: (name) => {
      calls.logs.push(name);
      return Effect.succeed("envoy: fatal config error");
    },
  });

  const plan = envoyPlan({ envoyReadyTimeoutMs: 100 });
  const layerWithEnvoy = Layer.provide(EnvoyServiceLive, layer);

  const exit = await Effect.runPromiseExit(
    Effect.flatMap(EnvoyService, (svc) => svc.ensureSharedEnvoy(plan)).pipe(
      Effect.provide(layerWithEnvoy),
    ),
  );

  expect(Exit.isFailure(exit)).toEqual(true);
  if (Exit.isFailure(exit)) {
    const failureOption = Cause.failureOption(exit.cause);
    expect(failureOption._tag).toEqual("Some");
    if (failureOption._tag === "Some") {
      const err = failureOption.value as Error;
      expect(err.message).toContain("Envoy sidecar failed to start");
      expect(err.message).toContain("envoy: fatal config error");
    }
  }
  expect(calls.logs).toEqual(["nas-envoy-shared"]);
});

// ---------------------------------------------------------------------------
// createSessionNetwork
// ---------------------------------------------------------------------------

function sessionPlan(
  overrides: Partial<SessionNetworkPlan> = {},
): SessionNetworkPlan {
  return {
    sessionNetworkName: "nas-session-abc",
    envoyContainerName: "nas-envoy-shared",
    envoyAlias: "envoy.nas",
    dindContainerName: null,
    ...overrides,
  };
}

test("createSessionNetwork: creates internal network with correct labels", async () => {
  const calls = freshCalls();
  const layer = makeDockerFake(calls);

  await runWithEnvoy((svc) => svc.createSessionNetwork(sessionPlan()), layer);

  expect(calls.networkCreate.length).toEqual(1);
  expect(calls.networkCreate[0].name).toEqual("nas-session-abc");
  expect(calls.networkCreate[0].opts).toEqual({
    internal: true,
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_SESSION_NETWORK,
    },
  });
});

test("createSessionNetwork: connects envoy with alias, skips dind when null", async () => {
  const calls = freshCalls();
  const layer = makeDockerFake(calls);

  await runWithEnvoy(
    (svc) => svc.createSessionNetwork(sessionPlan({ dindContainerName: null })),
    layer,
  );

  expect(calls.networkConnect).toEqual([
    {
      network: "nas-session-abc",
      container: "nas-envoy-shared",
      opts: { aliases: ["envoy.nas"] },
    },
  ]);
});

test("createSessionNetwork: connects dind when dindContainerName is set", async () => {
  const calls = freshCalls();
  const layer = makeDockerFake(calls);

  await runWithEnvoy(
    (svc) =>
      svc.createSessionNetwork(
        sessionPlan({ dindContainerName: "nas-dind-abc" }),
      ),
    layer,
  );

  expect(calls.networkConnect.length).toEqual(2);
  expect(calls.networkConnect[0].container).toEqual("nas-envoy-shared");
  expect(calls.networkConnect[1]).toEqual({
    network: "nas-session-abc",
    container: "nas-dind-abc",
    opts: undefined,
  });
});

test("createSessionNetwork: teardown disconnects both then removes network", async () => {
  const calls = freshCalls();
  const layer = makeDockerFake(calls);

  const teardown = await runWithEnvoy(
    (svc) =>
      svc.createSessionNetwork(
        sessionPlan({ dindContainerName: "nas-dind-abc" }),
      ),
    layer,
  );

  await Effect.runPromise(teardown());

  // disconnect dind first (it was connected last), then envoy, then remove network.
  expect(calls.networkDisconnect).toEqual([
    { network: "nas-session-abc", container: "nas-dind-abc" },
    { network: "nas-session-abc", container: "nas-envoy-shared" },
  ]);
  expect(calls.networkRemove).toEqual(["nas-session-abc"]);
});

test("createSessionNetwork: teardown skips dind disconnect when dind wasn't connected", async () => {
  const calls = freshCalls();
  const layer = makeDockerFake(calls);

  const teardown = await runWithEnvoy(
    (svc) => svc.createSessionNetwork(sessionPlan({ dindContainerName: null })),
    layer,
  );

  await Effect.runPromise(teardown());

  expect(calls.networkDisconnect).toEqual([
    { network: "nas-session-abc", container: "nas-envoy-shared" },
  ]);
  expect(calls.networkRemove).toEqual(["nas-session-abc"]);
});

test("createSessionNetwork: teardown tolerates partial failure and still removes network", async () => {
  const calls = freshCalls();
  const layer = makeDockerFake(calls, {
    networkDisconnect: () =>
      Effect.fail(
        new Error("already disconnected"),
      ) as unknown as Effect.Effect<void>,
    networkRemove: () =>
      Effect.fail(new Error("still in use")) as unknown as Effect.Effect<void>,
  });

  const teardown = await runWithEnvoy(
    (svc) =>
      svc.createSessionNetwork(
        sessionPlan({ dindContainerName: "nas-dind-abc" }),
      ),
    layer,
  );

  // Must not throw even though every call fails internally.
  await Effect.runPromise(teardown());

  // Both disconnects were attempted despite failures.
  expect(calls.networkDisconnect.length).toEqual(2);
  expect(calls.networkRemove).toEqual(["nas-session-abc"]);
});

test("createSessionNetwork: teardown when envoy connect failed only removes network", async () => {
  // If createSessionNetwork fails at the envoy connect step, no resources
  // were successfully wired up; the Effect fails and no teardown runs.
  const calls = freshCalls();
  const layer = makeDockerFake(calls, {
    networkConnect: () =>
      Effect.fail(
        new Error("connect failed"),
      ) as unknown as Effect.Effect<void>,
  });

  const exit = await Effect.runPromiseExit(
    Effect.flatMap(EnvoyService, (svc) =>
      svc.createSessionNetwork(sessionPlan({ dindContainerName: "nas-dind" })),
    ).pipe(Effect.provide(Layer.provide(EnvoyServiceLive, layer))),
  );

  expect(exit._tag).toEqual("Failure");
  // Only the network was created + one connect attempted.
  expect(calls.networkCreate.length).toEqual(1);
  expect(calls.networkConnect.length).toEqual(1);
  expect(calls.networkDisconnect.length).toEqual(0);
  expect(calls.networkRemove.length).toEqual(0);
});
