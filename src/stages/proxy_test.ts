import { expect, test } from "bun:test";

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
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import type {
  HostEnv,
  PriorStageOutputs,
  ProbeResults,
  StageInput,
} from "../pipeline/types.ts";
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
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network,
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
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
  overrides: Partial<PriorStageOutputs> = {},
): PriorStageOutputs {
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
  overrides: { prior?: Partial<PriorStageOutputs> } = {},
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
