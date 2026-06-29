/**
 * ProxyService unit tests (no Docker required).
 *
 * Exercises ProxyServiceLive against a fake DockerService to pin down:
 *   - ensureSharedProxy's idempotency + stale cleanup + readiness loop
 *   - createSessionNetwork's connect order, optional dind wiring, and
 *     the teardown finalizer shape.
 */

import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  NAS_KIND_LABEL,
  NAS_KIND_PROXY,
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
  type EnsureProxyPlan,
  ProxyService,
  ProxyServiceLive,
  type SessionNetworkPlan,
} from "./proxy_service.ts";

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
    caCertDir: `${root}/mitmproxy-ca`,
    addonScriptPath: `${root}/nas_addon.py`,
    reviewRulesDir: `${root}/review-rules`,
  };
}

function proxyPlan(overrides: Partial<EnsureProxyPlan> = {}): EnsureProxyPlan {
  return {
    proxyContainerName: "nas-proxy-shared",
    proxyImage: "nas-proxy:latest",
    runtimePaths: runtimePaths(),
    proxyReadyTimeoutMs: 1000,
    ...overrides,
  };
}

function runWithProxy<A, E>(
  effect: (
    svc: Effect.Effect.Success<typeof ProxyService>,
  ) => Effect.Effect<A, E>,
  dockerLayer: Layer.Layer<DockerService>,
): Promise<A> {
  const layer = Layer.provide(ProxyServiceLive, dockerLayer);
  return Effect.runPromise(
    Effect.flatMap(ProxyService, effect).pipe(Effect.provide(layer)),
  ) as Promise<A>;
}

// ---------------------------------------------------------------------------
// ensureSharedProxy
// ---------------------------------------------------------------------------

test("ensureSharedProxy: skips when proxy is already running", async () => {
  const calls = freshCalls();
  const layer = makeDockerFake(calls, { isRunning: () => true });

  await runWithProxy((svc) => svc.ensureSharedProxy(proxyPlan()), layer);

  expect(calls.isRunning).toEqual(["nas-proxy-shared"]);
  expect(calls.containerExists.length).toEqual(0);
  expect(calls.runDetached.length).toEqual(0);
  expect(calls.rm.length).toEqual(0);
});

test("ensureSharedProxy: removes stale container before launching", async () => {
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

  await runWithProxy((svc) => svc.ensureSharedProxy(proxyPlan()), layer);

  expect(calls.rm).toEqual(["nas-proxy-shared"]);
  expect(calls.runDetached.length).toEqual(1);
  // First isRunning check happens before containerExists/rm
  expect(calls.isRunning.length).toBeGreaterThanOrEqual(2);
});

test("ensureSharedProxy: tolerates rm failure and still launches", async () => {
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

  await runWithProxy((svc) => svc.ensureSharedProxy(proxyPlan()), wrappedLayer);

  expect(calls.rm).toEqual(["nas-proxy-shared"]);
  expect(calls.runDetached.length).toEqual(1);
});

test("ensureSharedProxy: launches with correct labels, mounts, and command", async () => {
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

  const plan = proxyPlan({
    proxyContainerName: "nas-proxy-shared",
    proxyImage: "my-proxy:1.2",
  });
  await runWithProxy((svc) => svc.ensureSharedProxy(plan), layer);

  expect(calls.runDetached.length).toEqual(1);
  const run = calls.runDetached[0];
  expect(run.name).toEqual("nas-proxy-shared");
  expect(run.image).toEqual("my-proxy:1.2");
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
    [NAS_KIND_LABEL]: NAS_KIND_PROXY,
  });
  expect(run.command).toEqual([
    "mitmdump",
    "--mode",
    "regular@8080",
    "--set",
    "connection_strategy=lazy",
    "--set",
    "confdir=/nas-network/mitmproxy-ca",
    "--ssl-insecure",
    "-s",
    "/nas-network/nas_addon.py",
  ]);
});

test("ensureSharedProxy: fails with logs when readiness times out", async () => {
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
      return Effect.succeed("proxy: fatal config error");
    },
  });

  const plan = proxyPlan({ proxyReadyTimeoutMs: 100 });
  const layerWithProxy = Layer.provide(ProxyServiceLive, layer);

  const exit = await Effect.runPromiseExit(
    Effect.flatMap(ProxyService, (svc) => svc.ensureSharedProxy(plan)).pipe(
      Effect.provide(layerWithProxy),
    ),
  );

  expect(Exit.isFailure(exit)).toEqual(true);
  if (Exit.isFailure(exit)) {
    const failureOption = Cause.failureOption(exit.cause);
    expect(failureOption._tag).toEqual("Some");
    if (failureOption._tag === "Some") {
      const err = failureOption.value as Error;
      expect(err.message).toContain("Proxy container failed to start");
      expect(err.message).toContain("proxy: fatal config error");
    }
  }
  expect(calls.logs).toEqual(["nas-proxy-shared"]);
});

// ---------------------------------------------------------------------------
// createSessionNetwork
// ---------------------------------------------------------------------------

function sessionPlan(
  overrides: Partial<SessionNetworkPlan> = {},
): SessionNetworkPlan {
  return {
    sessionNetworkName: "nas-session-abc",
    proxyContainerName: "nas-proxy-shared",
    proxyAlias: "nas-proxy",
    ...overrides,
  };
}

test("createSessionNetwork: creates internal network with correct labels", async () => {
  const calls = freshCalls();
  const layer = makeDockerFake(calls);

  await runWithProxy((svc) => svc.createSessionNetwork(sessionPlan()), layer);

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

test("createSessionNetwork: connects only proxy with alias", async () => {
  const calls = freshCalls();
  const layer = makeDockerFake(calls);

  await runWithProxy((svc) => svc.createSessionNetwork(sessionPlan()), layer);

  // DinD is wired up by DindStage, not ProxyStage — only proxy is connected.
  expect(calls.networkConnect).toEqual([
    {
      network: "nas-session-abc",
      container: "nas-proxy-shared",
      opts: { aliases: ["nas-proxy"] },
    },
  ]);
});

test("createSessionNetwork: teardown disconnects proxy then removes network", async () => {
  const calls = freshCalls();
  const layer = makeDockerFake(calls);

  const { teardown } = await runWithProxy(
    (svc) => svc.createSessionNetwork(sessionPlan()),
    layer,
  );

  await Effect.runPromise(teardown());

  expect(calls.networkDisconnect).toEqual([
    { network: "nas-session-abc", container: "nas-proxy-shared" },
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

  const { teardown } = await runWithProxy(
    (svc) => svc.createSessionNetwork(sessionPlan()),
    layer,
  );

  // Must not throw even though every call fails internally.
  await Effect.runPromise(teardown());

  // The proxy disconnect was attempted despite failures.
  expect(calls.networkDisconnect.length).toEqual(1);
  expect(calls.networkRemove).toEqual(["nas-session-abc"]);
});

test("createSessionNetwork: teardown when proxy connect failed only removes network", async () => {
  // If createSessionNetwork fails at the proxy connect step, no resources
  // were successfully wired up; the Effect fails and no teardown runs.
  const calls = freshCalls();
  const layer = makeDockerFake(calls, {
    networkConnect: () =>
      Effect.fail(
        new Error("connect failed"),
      ) as unknown as Effect.Effect<void>,
  });

  const exit = await Effect.runPromiseExit(
    Effect.flatMap(ProxyService, (svc) =>
      svc.createSessionNetwork(sessionPlan()),
    ).pipe(Effect.provide(Layer.provide(ProxyServiceLive, layer))),
  );

  expect(exit._tag).toEqual("Failure");
  // Only the network was created + one connect attempted.
  expect(calls.networkCreate.length).toEqual(1);
  expect(calls.networkConnect.length).toEqual(1);
  expect(calls.networkDisconnect.length).toEqual(0);
  expect(calls.networkRemove.length).toEqual(0);
});
