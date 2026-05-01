import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

/**
 * ProxyStage unit テスト（Docker 不要）
 *
 * planner, replaceNetwork, parseDindContainerName を検証する。
 * Envoy コンテナ起動の integration テストは proxy_stage_integration_test.ts を参照。
 */

import type { Config, Profile } from "../../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../../config/types.ts";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type {
  ContainerPlan,
  ObservabilityState,
} from "../../pipeline/state.ts";
import type {
  HostEnv,
  ProbeResults,
  StageInput,
} from "../../pipeline/types.ts";
import { makeAuthRouterServiceFake } from "./auth_router_service.ts";
import { makeEnvoyServiceFake } from "./envoy_service.ts";
import {
  type EnsureForwardPortRelaysOptions,
  type ForwardPortRelayHandle,
  makeForwardPortRelayServiceFake,
} from "./forward_port_relay_service.ts";
import { makeNetworkRuntimeServiceFake } from "./network_runtime_service.ts";
import { makeSessionBrokerServiceFake } from "./session_broker_service.ts";
import {
  buildNetworkRuntimePaths,
  createProxyStage,
  createProxyStageWithOptions,
  LOCAL_PROXY_PORT,
  planProxy,
  replaceNetwork,
} from "./stage.ts";

const DEFAULT_PROMPT = {
  enable: false,
  denylist: [] as string[],
  timeoutSeconds: 300,
  defaultScope: "host-port" as const,
  notify: "auto" as const,
};

function makeProfile(
  overrides: Partial<Omit<Profile, "network">> & {
    network?: Partial<Omit<Profile["network"], "prompt">> & {
      prompt?: Partial<Profile["network"]["prompt"]>;
    };
  } = {},
): Profile {
  const networkOverrides = overrides.network ?? {};
  const { network: _ignored, ...rest } = overrides;
  const network: Profile["network"] = {
    allowlist: networkOverrides.allowlist
      ? [...networkOverrides.allowlist]
      : [],
    proxy: networkOverrides.proxy
      ? { forwardPorts: [...networkOverrides.proxy.forwardPorts] }
      : { forwardPorts: [] },
    prompt: {
      ...DEFAULT_PROMPT,
      ...(networkOverrides.prompt ?? {}),
    },
  };
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    network,
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
    ...rest,
  };
}

function makeConfig(profile: Profile): Config {
  return {
    profiles: { default: profile },
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
  };
}

function makeHostEnv(): HostEnv {
  return {
    home: "/home/test",
    user: "test",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([["XDG_RUNTIME_DIR", "/run/user/1000"]]),
  };
}

function makeProbes(): ProbeResults {
  return {
    hasHostNix: false,
    xdgDbusProxyPath: null,
    dbusSessionAddress: null,
    gpgAgentSocket: null,
    auditDir: "/tmp/nas-audit",
  };
}

const DISABLED_OBSERVABILITY: ObservabilityState = { enabled: false };

function makeInput(
  profile: Profile,
  overrides: {
    container?: ContainerPlan;
    observability?: ObservabilityState;
  } = {},
): {
  shared: StageInput;
  container: ContainerPlan;
  observability: ObservabilityState;
} {
  const config = makeConfig(profile);
  const container = overrides.container ?? {
    ...emptyContainerPlan("test-image", "/tmp"),
    command: { agentCommand: ["claude"], extraArgs: [] },
  };
  return {
    shared: {
      config,
      profile,
      profileName: "default",
      sessionId: "test-session-123",
      host: makeHostEnv(),
      probes: makeProbes(),
    },
    container,
    observability: overrides.observability ?? DISABLED_OBSERVABILITY,
  };
}

test("ProxyStage: always returns plan even when allowlist and prompt are disabled", () => {
  const profile = makeProfile();
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability });
  expect(result.sessionNetworkName).toEqual("nas-session-net-test-session-123");
  expect(result.allowlist).toEqual([]);
  expect(result.promptEnabled).toEqual(false);
  expect(result.forwardPorts).toEqual([]);
});

test("ProxyStage: returns plan when allowlist is non-empty", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability });
  expect(result !== null).toEqual(true);
  expect(result!.sessionNetworkName).toEqual(
    "nas-session-net-test-session-123",
  );
});

test("ProxyStage: returns plan when prompt is enabled", () => {
  const profile = makeProfile({
    network: { prompt: { enable: true } },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability });
  expect(result !== null).toEqual(true);
  expect(result!.promptEnabled).toEqual(true);
});

test("ProxyStage: sets proxy env vars", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect(result.envVars.http_proxy).toEqual(
    `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
  );
  expect(result.envVars.https_proxy).toEqual(
    `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
  );
  expect(result.envVars.HTTP_PROXY).toEqual(
    `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
  );
  expect(result.envVars.HTTPS_PROXY).toEqual(
    `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
  );
  expect(result.envVars.no_proxy).toEqual("localhost,127.0.0.1");
  expect(result.envVars.NO_PROXY).toEqual("localhost,127.0.0.1");
  expect(typeof result.envVars.NAS_UPSTREAM_PROXY).toEqual("string");
});

test("ProxyStage: includes dind container in no_proxy", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const { shared, container, observability } = makeInput(profile, {
    container: {
      ...emptyContainerPlan("test-image", "/tmp"),
      command: { agentCommand: ["claude"], extraArgs: [] },
      env: {
        static: { NAS_DIND_CONTAINER_NAME: "nas-dind-abc12345" },
        dynamicOps: [],
      },
    },
  });
  const result = planProxy({ ...shared, container, observability })!;
  expect(result.envVars.no_proxy).toEqual(
    "localhost,127.0.0.1,nas-dind-abc12345",
  );
});

test("ProxyStage: sets outputOverrides", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  const promptToken = result.outputOverrides.prompt!.promptToken;
  const proxyEndpoint = result.outputOverrides.proxy!.proxyEndpoint;
  expect(result.outputOverrides.network).toEqual({
    networkName: "nas-session-net-test-session-123",
    runtimeDir: "/run/user/1000/nas/network",
  });
  expect(result.outputOverrides.prompt).toEqual({
    promptToken,
    promptEnabled: false,
  });
  expect(result.outputOverrides.proxy).toEqual({
    brokerSocket: "/run/user/1000/nas/network/brokers/test-session-123/sock",
    proxyEndpoint,
  });
});

test("ProxyStage: planner sets networkName in outputOverrides", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect(
    result.outputOverrides.network?.networkName.startsWith("nas-session-net-"),
  ).toEqual(true);
});

test("replaceNetwork: replaces existing --network flag", () => {
  const args = ["--rm", "--network", "old-net", "-v", "/tmp:/tmp"];
  const replaced = replaceNetwork(args, "new-net");
  expect(replaced).toEqual(["--rm", "--network", "new-net", "-v", "/tmp:/tmp"]);
});

test("replaceNetwork: adds --network when not present", () => {
  const args = ["--rm", "-v", "/tmp:/tmp"];
  const replaced = replaceNetwork(args, "new-net");
  expect(replaced).toEqual(["--rm", "-v", "/tmp:/tmp", "--network", "new-net"]);
});

test("ProxyStage: uses provided session token generator", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const { shared, container, observability } = makeInput(profile);
  const generatedToken = "fixed-token-12345";
  const result = planProxy(
    { ...shared, container, observability },
    { generateSessionToken: () => generatedToken },
  )!;
  expect(result.outputOverrides.prompt?.promptToken).toEqual(generatedToken);
  expect(result.envVars.NAS_UPSTREAM_PROXY.includes(generatedToken)).toEqual(
    true,
  );
});

test("ProxyStage: uses profile prompt settings and dind env from container slice", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"], prompt: { enable: true } },
  });
  const { shared, container, observability } = makeInput(profile, {
    container: {
      ...emptyContainerPlan("test-image", "/tmp"),
      command: { agentCommand: ["claude"], extraArgs: [] },
      env: {
        static: { NAS_DIND_CONTAINER_NAME: "nas-dind-from-slice" },
        dynamicOps: [],
      },
    },
  });

  const result = planProxy(
    { ...shared, container, observability },
    {
      generateSessionToken: () => "slice-token",
    },
  )!;

  expect(result.token).toEqual("slice-token");
  expect(result.outputOverrides.prompt).toEqual({
    promptToken: "slice-token",
    promptEnabled: true,
  });
  expect(result.envVars.no_proxy).toEqual(
    "localhost,127.0.0.1,nas-dind-from-slice",
  );
});

test("ProxyStage: planner merges proxy settings into existing container slice", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const { shared, container, observability } = makeInput(profile, {
    container: {
      ...emptyContainerPlan("slice-image", "/slice-workdir"),
      mounts: [{ source: "/existing-src", target: "/existing-target" }],
      env: { static: { EXISTING_ENV: "1" }, dynamicOps: [] },
      extraRunArgs: ["--shm-size", "2g"],
      command: { agentCommand: ["copilot"], extraArgs: ["--safe"] },
      labels: { "nas.managed": "true" },
    },
  });

  const result = planProxy({ ...shared, container, observability })!;
  const proxyEndpoint = result.outputOverrides.proxy!.proxyEndpoint;

  expect(result.outputOverrides.container).toEqual({
    image: "slice-image",
    workDir: "/slice-workdir",
    mounts: [{ source: "/existing-src", target: "/existing-target" }],
    env: {
      static: {
        EXISTING_ENV: "1",
        NAS_UPSTREAM_PROXY: proxyEndpoint,
        http_proxy: `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
        https_proxy: `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
        HTTP_PROXY: `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
        HTTPS_PROXY: `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
        no_proxy: "localhost,127.0.0.1",
        NO_PROXY: "localhost,127.0.0.1",
      },
      dynamicOps: [],
    },
    extraRunArgs: ["--shm-size", "2g"],
    network: { name: "nas-session-net-test-session-123" },
    command: { agentCommand: ["copilot"], extraArgs: ["--safe"] },
    labels: { "nas.managed": "true" },
  });
});

test("ProxyStage: stage metadata is stable", () => {
  const { shared } = makeInput(makeProfile());
  const stage = createProxyStage(shared);
  expect(stage.name).toEqual("ProxyStage");
  expect(stage.needs).toEqual(["container", "observability"]);
});

test("replaceNetwork: replaces existing --network", () => {
  const args = ["--rm", "--network", "old-net", "-v", "/tmp:/tmp"];
  const result = replaceNetwork(args, "new-net");
  expect(result).toEqual(["--rm", "--network", "new-net", "-v", "/tmp:/tmp"]);
});

test("replaceNetwork: appends when no --network", () => {
  const args = ["--rm", "-v", "/tmp:/tmp"];
  const result = replaceNetwork(args, "new-net");
  expect(result).toEqual(["--rm", "-v", "/tmp:/tmp", "--network", "new-net"]);
});

test("LOCAL_PROXY_PORT: is 18080", () => {
  expect(LOCAL_PROXY_PORT).toEqual(18080);
});

// ---------------------------------------------------------------------------
// forward-ports
// ---------------------------------------------------------------------------

test("ProxyStage: forwardPorts-only enables proxy", () => {
  const profile = makeProfile({
    network: { proxy: { forwardPorts: [8080] } },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability });
  expect(result !== null).toEqual(true);
});

test("ProxyStage: forwardPorts does NOT inject host.docker.internal entries into allowlist", () => {
  // Forward-ports flow through per-port UDS bind-mounts, so the local-proxy
  // does not dial host.docker.internal:<port> via CONNECT. The allowlist
  // must therefore stay free of synthetic host.docker.internal entries —
  // a stale allowlist injection would silently re-grant the host TCP
  // escape route.
  const profile = makeProfile({
    network: { proxy: { forwardPorts: [8080, 5432] } },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect(result.allowlist).not.toContain("host.docker.internal:8080");
  expect(result.allowlist).not.toContain("host.docker.internal:5432");
});

test("ProxyStage: forwardPorts preserves user-declared host.docker.internal allowlist entries", () => {
  // If a profile explicitly puts host.docker.internal:* in its allowlist,
  // it must not be stripped — that is user intent, distinct from the
  // implicit injection driven by forwardPorts.
  const profile = makeProfile({
    network: {
      allowlist: ["host.docker.internal:9999"],
      proxy: { forwardPorts: [8080] },
    },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect(result.allowlist).toContain("host.docker.internal:9999");
  expect(result.allowlist).not.toContain("host.docker.internal:8080");
});

test("ProxyStage: forwardPorts sets NAS_FORWARD_PORTS env var", () => {
  const profile = makeProfile({
    network: { proxy: { forwardPorts: [8080, 5432] } },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect(result.envVars.NAS_FORWARD_PORTS).toEqual("8080,5432");
});

test("ProxyStage: forwardPorts leaves existing allowlist untouched", () => {
  // Profile-declared allowlist entries pass through verbatim; forwardPorts
  // no longer contributes synthetic host.docker.internal entries.
  const profile = makeProfile({
    network: { allowlist: ["example.com"], proxy: { forwardPorts: [3000] } },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect(result.allowlist).toContain("example.com");
  expect(result.allowlist).not.toContain("host.docker.internal:3000");
});

test("ProxyStage: no NAS_FORWARD_PORTS when forwardPorts is empty", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect(result.envVars.NAS_FORWARD_PORTS).toBeUndefined();
});

test("ProxyStage: forwardPorts adds per-port UDS bind-mounts to container", () => {
  const profile = makeProfile({
    network: { proxy: { forwardPorts: [8080, 5432] } },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;

  // Both ports get their own bind-mount targeting /run/nas-fp/<port>.sock with
  // the source matching forward_port_relay's canonical helper. Drift between
  // these and the relay's actual listener path would make local-proxy fail
  // socket lookup, so we pin both halves explicitly.
  const expectedRuntimeDir = "/run/user/1000/nas/network";
  const sessionId = "test-session-123";
  const mounts = result.outputOverrides.container!.mounts;

  const m8080 = mounts.find((m) => m.target === "/run/nas-fp/8080.sock");
  const m5432 = mounts.find((m) => m.target === "/run/nas-fp/5432.sock");
  expect(m8080).toBeDefined();
  expect(m5432).toBeDefined();
  expect(m8080!.source).toEqual(
    `${expectedRuntimeDir}/forward-ports/${sessionId}/8080.sock`,
  );
  expect(m5432!.source).toEqual(
    `${expectedRuntimeDir}/forward-ports/${sessionId}/5432.sock`,
  );
  expect(m8080!.readOnly).toEqual(false);
  expect(m5432!.readOnly).toEqual(false);
});

test("ProxyStage: forwardPorts sets NAS_FORWARD_PORT_SOCKET_DIR env", () => {
  const profile = makeProfile({
    network: { proxy: { forwardPorts: [8080, 5432] } },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect(
    result.outputOverrides.container!.env.static.NAS_FORWARD_PORT_SOCKET_DIR,
  ).toEqual("/run/nas-fp");
});

test("ProxyStage: no forward-port mounts or socket-dir env when forwardPorts is empty", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;

  const mounts = result.outputOverrides.container!.mounts;
  const fpMounts = mounts.filter((m) => m.target.startsWith("/run/nas-fp/"));
  expect(fpMounts.length).toEqual(0);

  expect(
    result.outputOverrides.container!.env.static.NAS_FORWARD_PORT_SOCKET_DIR,
  ).toBeUndefined();
});

test("createProxyStage().run(): invokes forwardPortRelay.ensureRelays and close on release", async () => {
  const profile = makeProfile({
    network: { proxy: { forwardPorts: [8080] } },
  });
  const { shared, container, observability } = makeInput(profile);

  const ensureCalls: EnsureForwardPortRelaysOptions[] = [];
  let closeCount = 0;

  const layer = Layer.mergeAll(
    makeNetworkRuntimeServiceFake(),
    makeEnvoyServiceFake(),
    makeSessionBrokerServiceFake(),
    makeAuthRouterServiceFake(),
    makeForwardPortRelayServiceFake({
      ensureRelays: (opts) => {
        ensureCalls.push(opts);
        const handle: ForwardPortRelayHandle = {
          socketPaths: new Map<number, string>([
            [8080, "/run/user/1000/nas/network/forward-ports/sess/8080.sock"],
          ]),
          close: () =>
            Effect.sync(() => {
              closeCount += 1;
            }),
        };
        return Effect.succeed(handle);
      },
    }),
  );

  const stage = createProxyStage(shared);
  await Effect.runPromise(
    stage
      .run({ container, observability })
      .pipe(Effect.scoped, Effect.provide(layer)),
  );

  expect(ensureCalls.length).toEqual(1);
  expect(ensureCalls[0]!.ports).toEqual([8080]);
  expect(ensureCalls[0]!.sessionId).toEqual("test-session-123");
  expect(ensureCalls[0]!.runtimeDir).toEqual("/run/user/1000/nas/network");
  // Scope finalization must run close() on the handle.
  expect(closeCount).toEqual(1);
});

test("buildNetworkRuntimePaths: uses XDG_RUNTIME_DIR", () => {
  const host: HostEnv = {
    home: "/home/test",
    user: "test",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([["XDG_RUNTIME_DIR", "/run/user/1000"]]),
  };
  const paths = buildNetworkRuntimePaths(host);
  expect(paths.runtimeDir).toEqual("/run/user/1000/nas/network");
  expect(paths.sessionsDir).toEqual("/run/user/1000/nas/network/sessions");
  expect(paths.brokersDir).toEqual("/run/user/1000/nas/network/brokers");
  expect(paths.authRouterSocket).toEqual(
    "/run/user/1000/nas/network/auth-router.sock",
  );
  expect(paths.envoyConfigFile).toEqual(
    "/run/user/1000/nas/network/envoy.yaml",
  );
});

test("buildNetworkRuntimePaths: falls back to /tmp when no XDG", () => {
  const host: HostEnv = {
    home: "/home/test",
    user: "test",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map(),
  };
  const paths = buildNetworkRuntimePaths(host);
  expect(paths.runtimeDir).toEqual("/tmp/nas-1000/network");
});

// ---------------------------------------------------------------------------
// Orchestration tests — createProxyStage().run() with Fake services
// ---------------------------------------------------------------------------

test("createProxyStage().run(): starts deny-by-default proxy when network controls are empty", async () => {
  const profile = makeProfile();
  const { shared, container, observability } = makeInput(profile);
  const stage = createProxyStage(shared);

  const calls: string[] = [];

  const layer = Layer.mergeAll(
    makeNetworkRuntimeServiceFake({
      gcStaleRuntime: () => {
        calls.push("gcStaleRuntime");
        return Effect.void;
      },
      renderEnvoyConfig: () => {
        calls.push("renderEnvoyConfig");
        return Effect.void;
      },
    }),
    makeEnvoyServiceFake({
      ensureSharedEnvoy: () => {
        calls.push("ensureSharedEnvoy");
        return Effect.void;
      },
      createSessionNetwork: () => {
        calls.push("createSessionNetwork");
        return Effect.succeed(() => Effect.void);
      },
    }),
    makeSessionBrokerServiceFake({
      start: () => {
        calls.push("sessionBrokerStart");
        return Effect.succeed({ close: () => Effect.void });
      },
    }),
    makeAuthRouterServiceFake({
      ensureDaemon: () => {
        calls.push("authRouterEnsureDaemon");
        return Effect.succeed({ abort: () => Effect.void });
      },
    }),
    makeForwardPortRelayServiceFake({
      ensureRelays: () => {
        calls.push("forwardPortEnsureRelays");
        return Effect.succeed({
          socketPaths: new Map<number, string>(),
          close: () => Effect.void,
        });
      },
    }),
  );

  const result = await Effect.runPromise(
    stage
      .run({ container, observability })
      .pipe(Effect.scoped, Effect.provide(layer)),
  );

  expect(calls).toEqual([
    "gcStaleRuntime",
    "renderEnvoyConfig",
    "sessionBrokerStart",
    "authRouterEnsureDaemon",
    "forwardPortEnsureRelays",
    "ensureSharedEnvoy",
    "createSessionNetwork",
  ]);
  expect(result.network).toEqual({
    networkName: "nas-session-net-test-session-123",
    runtimeDir: "/run/user/1000/nas/network",
  });
  expect(result.prompt?.promptEnabled).toEqual(false);
  expect(result.container?.network).toEqual({
    name: "nas-session-net-test-session-123",
  });
});

test("createProxyStage().run(): calls services and returns merged output", async () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const { shared, container, observability } = makeInput(profile);

  const calls: string[] = [];

  const layer = Layer.mergeAll(
    makeNetworkRuntimeServiceFake({
      gcStaleRuntime: () => {
        calls.push("gcStaleRuntime");
        return Effect.void;
      },
      renderEnvoyConfig: () => {
        calls.push("renderEnvoyConfig");
        return Effect.void;
      },
    }),
    makeEnvoyServiceFake({
      ensureSharedEnvoy: () => {
        calls.push("ensureSharedEnvoy");
        return Effect.void;
      },
      createSessionNetwork: () => {
        calls.push("createSessionNetwork");
        return Effect.succeed(() => Effect.void);
      },
    }),
    makeSessionBrokerServiceFake({
      start: () => {
        calls.push("sessionBrokerStart");
        return Effect.succeed({ close: () => Effect.void });
      },
    }),
    makeAuthRouterServiceFake({
      ensureDaemon: () => {
        calls.push("authRouterEnsureDaemon");
        return Effect.succeed({ abort: () => Effect.void });
      },
    }),
    makeForwardPortRelayServiceFake({
      ensureRelays: () => {
        calls.push("forwardPortEnsureRelays");
        return Effect.succeed({
          socketPaths: new Map<number, string>(),
          close: () => Effect.void,
        });
      },
    }),
  );

  const stage = createProxyStageWithOptions(shared, {
    generateSessionToken: () => "test-token-fixed",
  });

  const result = await Effect.runPromise(
    stage
      .run({ container, observability })
      .pipe(Effect.scoped, Effect.provide(layer)),
  );

  // All services were called in the expected order. Relay ensure sits between
  // auth-router daemon ensure and envoy ensure so LIFO release tears the
  // relays down before envoy / session-network resources go away.
  expect(calls).toEqual([
    "gcStaleRuntime",
    "renderEnvoyConfig",
    "sessionBrokerStart",
    "authRouterEnsureDaemon",
    "forwardPortEnsureRelays",
    "ensureSharedEnvoy",
    "createSessionNetwork",
  ]);

  expect(result.network).toEqual({
    networkName: "nas-session-net-test-session-123",
    runtimeDir: "/run/user/1000/nas/network",
  });
  const proxyEndpoint = result.proxy!.proxyEndpoint;
  expect(result.prompt).toEqual({
    promptToken: "test-token-fixed",
    promptEnabled: false,
  });
  expect(result.proxy).toEqual({
    brokerSocket: "/run/user/1000/nas/network/brokers/test-session-123/sock",
    proxyEndpoint,
  });

  expect(result.container?.network).toEqual({
    name: "nas-session-net-test-session-123",
  });
  expect(result.container?.env.static.http_proxy).toEqual(
    `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
  );
});

// ---------------------------------------------------------------------------
// observability slice → forwardPorts merge
// ---------------------------------------------------------------------------

test("ProxyStage: observability disabled => forwardPorts unchanged from profile", () => {
  const profile = makeProfile({
    network: { proxy: { forwardPorts: [8080, 5432] } },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect([...result.forwardPorts]).toEqual([8080, 5432]);
});

test("ProxyStage: observability enabled => receiverPort appended to forwardPorts", () => {
  const profile = makeProfile({
    network: { proxy: { forwardPorts: [8080] } },
  });
  const { shared, container } = makeInput(profile, {
    observability: { enabled: true, receiverPort: 41234 },
  });
  const result = planProxy({
    ...shared,
    container,
    observability: { enabled: true, receiverPort: 41234 },
  })!;
  expect([...result.forwardPorts]).toEqual([8080, 41234]);
});

test("ProxyStage: receiverPort already in profile.forwardPorts is deduped", () => {
  // The forward-port relay throws on duplicate ports. If a profile already
  // declares the same port the observability stage chose (e.g. the
  // operator hard-coded forward-ports against an external collector and
  // then turned on observability), we MUST dedup before the relay sees it.
  const profile = makeProfile({
    network: { proxy: { forwardPorts: [41234, 8080] } },
  });
  const { shared, container } = makeInput(profile, {
    observability: { enabled: true, receiverPort: 41234 },
  });
  const result = planProxy({
    ...shared,
    container,
    observability: { enabled: true, receiverPort: 41234 },
  })!;
  expect([...result.forwardPorts]).toEqual([41234, 8080]);
});

test("ProxyStage: empty profile.forwardPorts + observability enabled => only receiverPort", () => {
  const profile = makeProfile();
  const { shared, container } = makeInput(profile, {
    observability: { enabled: true, receiverPort: 41234 },
  });
  const result = planProxy({
    ...shared,
    container,
    observability: { enabled: true, receiverPort: 41234 },
  })!;
  expect([...result.forwardPorts]).toEqual([41234]);
});
