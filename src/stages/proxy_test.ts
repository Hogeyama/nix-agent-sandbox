/**
 * ProxyStage unit テスト（Docker 不要）
 *
 * skip 判定, replaceNetwork, parseDindContainerName を検証する。
 * Envoy コンテナ起動の integration テストは proxy_stage_integration_test.ts を参照。
 */

import { assertEquals } from "@std/assert";
import {
  buildNetworkRuntimePaths,
  createProxyStage,
  LOCAL_PROXY_PORT,
  parseDindContainerName,
  replaceNetwork,
} from "./proxy.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import type { Config, Profile } from "../config/types.ts";
import type {
  HostEnv,
  PriorStageOutputs,
  ProbeResults,
  StageInput,
} from "../pipeline/types.ts";

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

Deno.test("ProxyStage: skip when allowlist and prompt are disabled", () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const stage = createProxyStage();
  const result = stage.plan(input);
  assertEquals(result, null);
});

Deno.test("ProxyStage: returns plan when allowlist is non-empty", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const input = makeInput(profile);
  const stage = createProxyStage();
  const result = stage.plan(input);
  assertEquals(result !== null, true);
  assertEquals(result!.effects.length, 1);
  assertEquals(result!.effects[0].kind, "proxy-session");
});

Deno.test("ProxyStage: returns plan when prompt is enabled", () => {
  const profile = makeProfile({
    network: { prompt: { enable: true } },
  });
  const input = makeInput(profile);
  const stage = createProxyStage();
  const result = stage.plan(input);
  assertEquals(result !== null, true);
  assertEquals(result!.effects.length, 1);
  assertEquals(result!.effects[0].kind, "proxy-session");
});

Deno.test("ProxyStage: sets proxy env vars", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const input = makeInput(profile);
  const stage = createProxyStage();
  const result = stage.plan(input)!;
  assertEquals(
    result.envVars["http_proxy"],
    `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
  );
  assertEquals(
    result.envVars["https_proxy"],
    `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
  );
  assertEquals(
    result.envVars["HTTP_PROXY"],
    `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
  );
  assertEquals(
    result.envVars["HTTPS_PROXY"],
    `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
  );
  assertEquals(result.envVars["no_proxy"], "localhost,127.0.0.1");
  assertEquals(result.envVars["NO_PROXY"], "localhost,127.0.0.1");
  assertEquals(typeof result.envVars["NAS_UPSTREAM_PROXY"], "string");
});

Deno.test("ProxyStage: includes dind container in no_proxy", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const input = makeInput(profile, {
    prior: {
      envVars: { NAS_DIND_CONTAINER_NAME: "nas-dind-abc12345" },
    },
  });
  const stage = createProxyStage();
  const result = stage.plan(input)!;
  assertEquals(
    result.envVars["no_proxy"],
    "localhost,127.0.0.1,nas-dind-abc12345",
  );
});

Deno.test("ProxyStage: sets outputOverrides", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const input = makeInput(profile);
  const stage = createProxyStage();
  const result = stage.plan(input)!;
  assertEquals(typeof result.outputOverrides.networkRuntimeDir, "string");
  assertEquals(typeof result.outputOverrides.networkPromptToken, "string");
  assertEquals(result.outputOverrides.networkPromptEnabled, false);
  assertEquals(typeof result.outputOverrides.networkBrokerSocket, "string");
  assertEquals(typeof result.outputOverrides.networkProxyEndpoint, "string");
});

Deno.test("ProxyStage: replaces existing --network in dockerArgs", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const input = makeInput(profile, {
    prior: { dockerArgs: ["--rm", "--network", "old-net", "-v", "/tmp:/tmp"] },
  });
  const stage = createProxyStage();
  const result = stage.plan(input)!;
  const networkIdx = result.dockerArgs.indexOf("--network");
  assertEquals(networkIdx !== -1, true);
  assertEquals(
    result.dockerArgs[networkIdx + 1].startsWith("nas-session-net-"),
    true,
  );
  // old-net should be replaced
  assertEquals(result.dockerArgs.includes("old-net"), false);
});

Deno.test("ProxyStage: reuses existing networkPromptToken", () => {
  const profile = makeProfile({
    network: { allowlist: ["example.com"] },
  });
  const existingToken = "existing-token-12345";
  const input = makeInput(profile, {
    prior: { networkPromptToken: existingToken },
  });
  const stage = createProxyStage();
  const result = stage.plan(input)!;
  assertEquals(result.outputOverrides.networkPromptToken, existingToken);
  // The proxy URL should contain the existing token
  assertEquals(
    result.envVars["NAS_UPSTREAM_PROXY"].includes(existingToken),
    true,
  );
});

Deno.test("replaceNetwork: replaces existing --network", () => {
  const args = ["--rm", "--network", "old-net", "-v", "/tmp:/tmp"];
  const result = replaceNetwork(args, "new-net");
  assertEquals(result, ["--rm", "--network", "new-net", "-v", "/tmp:/tmp"]);
});

Deno.test("replaceNetwork: appends when no --network", () => {
  const args = ["--rm", "-v", "/tmp:/tmp"];
  const result = replaceNetwork(args, "new-net");
  assertEquals(result, ["--rm", "-v", "/tmp:/tmp", "--network", "new-net"]);
});

Deno.test("parseDindContainerName: extracts from DOCKER_HOST", () => {
  const name = parseDindContainerName({
    DOCKER_HOST: "tcp://nas-dind-abc12345:2375",
  });
  assertEquals(name, "nas-dind-abc12345");
});

Deno.test("parseDindContainerName: prefers explicit env var", () => {
  const name = parseDindContainerName({
    NAS_DIND_CONTAINER_NAME: "nas-dind-explicit",
    DOCKER_HOST: "tcp://nas-dind-abc12345:2375",
  });
  assertEquals(name, "nas-dind-explicit");
});

Deno.test("parseDindContainerName: returns null for invalid format", () => {
  const name = parseDindContainerName({
    DOCKER_HOST: "unix:///var/run/docker.sock",
  });
  assertEquals(name, null);
});

Deno.test("LOCAL_PROXY_PORT: is 18080", () => {
  assertEquals(LOCAL_PROXY_PORT, 18080);
});

Deno.test("buildNetworkRuntimePaths: uses XDG_RUNTIME_DIR", () => {
  const host: HostEnv = {
    home: "/home/test",
    user: "test",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([["XDG_RUNTIME_DIR", "/run/user/1000"]]),
  };
  const paths = buildNetworkRuntimePaths(host);
  assertEquals(paths.runtimeDir, "/run/user/1000/nas/network");
  assertEquals(paths.sessionsDir, "/run/user/1000/nas/network/sessions");
  assertEquals(paths.brokersDir, "/run/user/1000/nas/network/brokers");
  assertEquals(
    paths.authRouterSocket,
    "/run/user/1000/nas/network/auth-router.sock",
  );
  assertEquals(paths.envoyConfigFile, "/run/user/1000/nas/network/envoy.yaml");
});

Deno.test("buildNetworkRuntimePaths: falls back to /tmp when no XDG", () => {
  const host: HostEnv = {
    home: "/home/test",
    user: "test",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map(),
  };
  const paths = buildNetworkRuntimePaths(host);
  assertEquals(paths.runtimeDir, "/tmp/nas-1000/network");
});
