import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

/**
 * ProxyStage unit テスト（Docker 不要）
 *
 * skip 判定, replaceNetwork, parseDindContainerName を検証する。
 * Envoy コンテナ起動の integration テストは proxy_stage_integration_test.ts を参照。
 */

import type { Config, Profile } from "../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import { emptyContainerPlan } from "../pipeline/container_plan.ts";
import type {
  HostEnv,
  ProbeResults,
  StageInput,
} from "../pipeline/types.ts";
import { makeAuthRouterServiceFake } from "../services/auth_router.ts";
import { makeEnvoyServiceFake } from "../services/envoy.ts";
import { makeNetworkRuntimeServiceFake } from "../services/network_runtime.ts";
import { makeSessionBrokerServiceFake } from "../services/session_broker.ts";
import {
  buildNetworkRuntimePaths,
  createProxyStage,
  LOCAL_PROXY_PORT,
  parseDindContainerName,
  planProxy,
  replaceNetwork,
} from "./proxy.ts";

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
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network,
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
    ...rest,
  };
}

function makeConfig(profile: Profile): Config {
  return { profiles: { default: profile }, ui: DEFAULT_UI_CONFIG };
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

function makePrior(
  overrides: Partial<StageInput["prior"]> = {},
): StageInput["prior"] {
  return {
    dockerArgs: [],
    envVars: {},
    workDir: "/tmp",
    nixEnabled: false,
    imageName: "test-image",
    agentCommand: ["claude"],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
    ...overrides,
  };
}

function makeInput(
  profile: Profile,
  overrides: { prior?: Partial<StageInput["prior"]> } = {},
): StageInput {
  const config = makeConfig(profile);
  return {
    config,
    profile,
    profileName: "default",
    sessionId: "test-session-123",
    host: makeHostEnv(),
    probes: makeProbes(),
    prior: makePrior(overrides.prior),
  };
}

test("ProxyStage: skip when allowlist and prompt are disabled", () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const result = planProxy(input);
  expect(result).toEqual(null);
});

test("ProxyStage: returns plan when allowlist is non-empty", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const input = makeInput(profile);
  const result = planProxy(input);
  expect(result !== null).toEqual(true);
  expect(result!.sessionNetworkName).toEqual(
    "nas-session-net-test-session-123",
  );
});

test("ProxyStage: returns plan when prompt is enabled", () => {
  const profile = makeProfile({
    network: { prompt: { enable: true } },
  });
  const input = makeInput(profile);
  const result = planProxy(input);
  expect(result !== null).toEqual(true);
  expect(result!.promptEnabled).toEqual(true);
});

test("ProxyStage: sets proxy env vars", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const input = makeInput(profile);
  const result = planProxy(input)!;
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
  const input = makeInput(profile, {
    prior: {
      envVars: { NAS_DIND_CONTAINER_NAME: "nas-dind-abc12345" },
    },
  });
  const result = planProxy(input)!;
  expect(result.envVars.no_proxy).toEqual(
    "localhost,127.0.0.1,nas-dind-abc12345",
  );
});

test("ProxyStage: sets outputOverrides", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const input = makeInput(profile);
  const result = planProxy(input)!;
  expect(typeof result.outputOverrides.networkRuntimeDir).toEqual("string");
  expect(typeof result.outputOverrides.networkPromptToken).toEqual("string");
  expect(result.outputOverrides.networkPromptEnabled).toEqual(false);
  expect(typeof result.outputOverrides.networkBrokerSocket).toEqual("string");
  expect(typeof result.outputOverrides.networkProxyEndpoint).toEqual("string");
  const promptToken = result.outputOverrides.networkPromptToken!;
  const proxyEndpoint = result.outputOverrides.networkProxyEndpoint!;
  expect(result.outputOverrides.network).toEqual({
    networkName: "nas-session-net-test-session-123",
    runtimeDir: "/run/user/1000/nas/network",
  });
  expect(result.outputOverrides.prompt).toEqual({
    promptToken,
    promptEnabled: false,
  });
  expect(result.outputOverrides.proxy).toEqual({
    brokerSocket: "/run/user/1000/nas/network/brokers/test-session-123.sock",
    proxyEndpoint,
  });
});

test("ProxyStage: planner sets networkName in outputOverrides", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const input = makeInput(profile);
  const result = planProxy(input)!;
  expect(result.outputOverrides.networkName).toBeDefined();
  expect(
    (result.outputOverrides.networkName as string).startsWith(
      "nas-session-net-",
    ),
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

test("ProxyStage: reuses existing networkPromptToken", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const existingToken = "existing-token-12345";
  const input = makeInput(profile, {
    prior: { networkPromptToken: existingToken },
  });
  const result = planProxy(input)!;
  expect(result.outputOverrides.networkPromptToken).toEqual(existingToken);
  expect(result.envVars.NAS_UPSTREAM_PROXY.includes(existingToken)).toEqual(
    true,
  );
});

test("ProxyStage: prefers prompt and dind slices when building plan", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"], prompt: { enable: true } },
  });
  const input = makeInput(profile, {
    prior: {
      networkPromptToken: "legacy-token",
      prompt: { promptToken: "slice-token", promptEnabled: false },
      dind: { containerName: "nas-dind-from-slice" },
    },
  });

  const result = planProxy(input)!;

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
  const input = makeInput(profile, {
    prior: {
      workspace: {
        workDir: "/slice-workdir",
        imageName: "slice-image",
      },
      container: {
        ...emptyContainerPlan("slice-image", "/slice-workdir"),
        mounts: [{ source: "/existing-src", target: "/existing-target" }],
        env: { static: { EXISTING_ENV: "1" }, dynamicOps: [] },
        extraRunArgs: ["--shm-size", "2g"],
        command: { agentCommand: ["copilot"], extraArgs: ["--safe"] },
        labels: { "nas.managed": "true" },
      },
    },
  });

  const result = planProxy(input)!;
  const proxyEndpoint = result.outputOverrides.networkProxyEndpoint!;

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

test("ProxyStage: EffectStage kind is effect", () => {
  const stage = createProxyStage();
  expect(stage.kind).toEqual("effect");
  expect(stage.name).toEqual("ProxyStage");
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

test("parseDindContainerName: extracts from DOCKER_HOST", () => {
  const name = parseDindContainerName({
    DOCKER_HOST: "tcp://nas-dind-abc12345:2375",
  });
  expect(name).toEqual("nas-dind-abc12345");
});

test("parseDindContainerName: prefers explicit env var", () => {
  const name = parseDindContainerName({
    NAS_DIND_CONTAINER_NAME: "nas-dind-explicit",
    DOCKER_HOST: "tcp://nas-dind-abc12345:2375",
  });
  expect(name).toEqual("nas-dind-explicit");
});

test("parseDindContainerName: returns null for invalid format", () => {
  const name = parseDindContainerName({
    DOCKER_HOST: "unix:///var/run/docker.sock",
  });
  expect(name).toEqual(null);
});

test("LOCAL_PROXY_PORT: is 18080", () => {
  expect(LOCAL_PROXY_PORT).toEqual(18080);
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

test("createProxyStage().run(): skips when proxy is disabled", async () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const stage = createProxyStage();

  const layer = Layer.mergeAll(
    makeNetworkRuntimeServiceFake(),
    makeEnvoyServiceFake(),
    makeSessionBrokerServiceFake(),
    makeAuthRouterServiceFake(),
  );

  const result = await Effect.runPromise(
    stage.run(input).pipe(Effect.scoped, Effect.provide(layer)),
  );

  expect(result).toEqual({});
});

test("createProxyStage().run(): calls services and returns merged output", async () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const input = makeInput(profile, {
    prior: { dockerArgs: ["--rm", "--network", "bridge"] },
  });

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
  );

  const stage = createProxyStage({
    generateSessionToken: () => "test-token-fixed",
  });

  const result = await Effect.runPromise(
    stage.run(input).pipe(Effect.scoped, Effect.provide(layer)),
  );

  // All services were called in the expected order
  expect(calls).toEqual([
    "gcStaleRuntime",
    "renderEnvoyConfig",
    "sessionBrokerStart",
    "authRouterEnsureDaemon",
    "ensureSharedEnvoy",
    "createSessionNetwork",
  ]);

  // Output includes proxy env vars
  expect(result.envVars).toBeDefined();
  expect((result.envVars as Record<string, string>).http_proxy).toEqual(
    `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
  );

  // Output includes network override
  expect(result.networkName).toBeDefined();
  expect((result.networkName as string).startsWith("nas-session-net-")).toEqual(
    true,
  );
  expect(result.network).toEqual({
    networkName: "nas-session-net-test-session-123",
    runtimeDir: "/run/user/1000/nas/network",
  });
  const proxyEndpoint = result.networkProxyEndpoint!;
  expect(result.prompt).toEqual({
    promptToken: "test-token-fixed",
    promptEnabled: false,
  });
  expect(result.proxy).toEqual({
    brokerSocket: "/run/user/1000/nas/network/brokers/test-session-123.sock",
    proxyEndpoint,
  });

  // dockerArgs has the session network replacing original
  expect(result.dockerArgs).toBeDefined();
  const dockerArgs = result.dockerArgs as string[];
  const netIdx = dockerArgs.indexOf("--network");
  expect(netIdx).not.toEqual(-1);
  expect(dockerArgs[netIdx + 1]).toMatch(/^nas-session-net-/);
  expect(result.container?.network).toEqual({
    name: "nas-session-net-test-session-123",
  });
  expect(result.container?.env.static.http_proxy).toEqual(
    `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
  );
  expect(result.envVars).toEqual(result.container?.env.static);
});
