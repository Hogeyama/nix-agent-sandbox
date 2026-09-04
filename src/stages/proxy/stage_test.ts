import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

/**
 * ProxyStage unit テスト（Docker 不要）
 *
 * planner, replaceNetwork, parseDindContainerName を検証する。
 * Proxy コンテナ起動の integration テストは proxy_stage_integration_test.ts を参照。
 */

import type { Config, NetworkConfig, Profile } from "../../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
  DEFAULT_REQUEST_BODY_AUDIT_CONFIG,
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
  StageResult,
} from "../../pipeline/types.ts";
import { type CaService, makeCaServiceFake } from "./ca_service.ts";
import {
  type EnsureForwardPortRelaysOptions,
  type ForwardPortRelayHandle,
  type ForwardPortRelayService,
  makeForwardPortRelayServiceFake,
} from "./forward_port_relay_service.ts";
import {
  makeNetworkRuntimeServiceFake,
  type NetworkRuntimeService,
} from "./network_runtime_service.ts";
import { makeProxyServiceFake, type ProxyService } from "./proxy_service.ts";
import {
  makeSessionBrokerServiceFake,
  type SessionBrokerConfig,
  type SessionBrokerService,
} from "./session_broker_service.ts";
import {
  buildNetworkRuntimePaths,
  createProxyStage,
  createProxyStageWithOptions,
  LOCAL_PROXY_PORT,
  planProxy,
  replaceNetwork,
} from "./stage.ts";

function makeProfile(
  overrides: Partial<Omit<Profile, "network">> & {
    network?: Partial<Profile["network"]>;
  } = {},
): Profile {
  const networkOverrides = overrides.network ?? {};
  const { network: _ignored, ...rest } = overrides;
  const network: Profile["network"] = {
    scopes: networkOverrides.scopes ?? {},
    fallback: networkOverrides.fallback ?? "deny",
    defaults: networkOverrides.defaults ?? {},
    proxy: networkOverrides.proxy
      ? { forwardPorts: [...networkOverrides.proxy.forwardPorts] }
      : { forwardPorts: [] },
    requestBodyAudit:
      networkOverrides.requestBodyAudit ??
      structuredClone(DEFAULT_REQUEST_BODY_AUDIT_CONFIG),
    pendingTimeoutSeconds: networkOverrides.pendingTimeoutSeconds ?? 300,
    pendingNotify: networkOverrides.pendingNotify ?? "auto",
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
    secrets: {},
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
    hostexecInterceptLibPath: null,
    hostexecClientPath: null,
    hostexecGatewayPath: null,
  };
}

const DISABLED_OBSERVABILITY: ObservabilityState = { enabled: false };

const REQUEST_BODY_AUDIT_CONFIG = {
  enable: true,
  retentionSeconds: 86_400,
  maxBodyBytes: 4_194_304,
  maxTotalBytes: 67_108_864,
};

const ALLOW_EXAMPLE: NetworkConfig["scopes"] = {
  example: { targets: ["example.com"], fallback: "allow" },
};

/** 受理条件を持つスコープ。Schema.pkl の anthropic preset と同じ形。 */
const POLICY_SCOPES: NetworkConfig["scopes"] = {
  anthropic: {
    targets: ["api.anthropic.com"],
    fallback: "deny",
    rules: {
      settings: {
        match: { methods: ["GET"], paths: ["/api/claude_code/settings"] },
        onMatch: "allow",
        expect: [{ kind: "emptyBody" }],
      },
    },
  },
};

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

/**
 * Runs `createProxyStage(...).run()` against a full fake-service layer stack
 * (Effect.scoped), letting callers override only the fakes they care about.
 * Extracted from the orchestration test bodies below so mask-value tests
 * don't have to repeat the boilerplate.
 */
function runStageWithFakes(
  profile: Profile,
  fakes: {
    caService?: Layer.Layer<CaService>;
    networkRuntime?: Layer.Layer<NetworkRuntimeService>;
    proxyService?: Layer.Layer<ProxyService>;
    sessionBroker?: Layer.Layer<SessionBrokerService>;
    forwardPortRelay?: Layer.Layer<ForwardPortRelayService>;
  } = {},
): Promise<
  Partial<Pick<StageResult, "network" | "prompt" | "proxy" | "container">>
> {
  const { shared, container, observability } = makeInput(profile);
  const stage = createProxyStage(shared);
  const layer = Layer.mergeAll(
    fakes.caService ?? makeCaServiceFake(),
    fakes.networkRuntime ?? makeNetworkRuntimeServiceFake(),
    fakes.proxyService ?? makeProxyServiceFake(),
    fakes.sessionBroker ?? makeSessionBrokerServiceFake(),
    fakes.forwardPortRelay ?? makeForwardPortRelayServiceFake(),
  );
  return Effect.runPromise(
    stage
      .run({ container, observability })
      .pipe(Effect.scoped, Effect.provide(layer)),
  );
}

test("ProxyStage: always returns plan even when no scope and prompt are disabled", () => {
  const profile = makeProfile();
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability });
  expect(result.sessionNetworkName).toEqual("nas-session-net-test-session-123");
  expect(result.document.scopes).toEqual([]);
  expect(result.document.fallback).toEqual("deny");
  expect(result.forwardPorts).toEqual([]);
});

test("ProxyStage: returns plan when a scope is declared", () => {
  const profile = makeProfile({
    network: { scopes: ALLOW_EXAMPLE },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability });
  expect(result !== null).toEqual(true);
  expect(result!.sessionNetworkName).toEqual(
    "nas-session-net-test-session-123",
  );
});

test("ProxyStage: carries the network fallback into the plan document", () => {
  const profile = makeProfile({ network: { fallback: "review" } });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability });
  expect(result.document.fallback).toEqual("review");
  expect(result.document.scopes).toEqual([]);
});

test("ProxyStage: resolves a rule into the versioned plan document", () => {
  const profile = makeProfile({ network: { scopes: POLICY_SCOPES } });
  const { shared, container, observability } = makeInput(profile);

  const result = planProxy({ ...shared, container, observability });

  expect(result.document.contractVersion).toBe(1);
  const scope = result.document.scopes[0]!;
  expect(scope.name).toEqual("anthropic");
  expect(scope.fallback).toEqual("deny");
  expect(scope.rules[0]).toMatchObject({
    id: "anthropic.settings",
    onMatch: "allow",
    audit: "always",
    expect: [{ kind: "emptyBody", onViolation: "deny" }],
  });
});

test("ProxyStage: refuses to plan a config the resolver rejects", () => {
  const profile = makeProfile({
    network: {
      scopes: {
        first: { targets: ["api.example.com"], fallback: "allow" },
        second: { targets: ["api.example.com"], fallback: "deny" },
      },
    },
  });
  const { shared, container, observability } = makeInput(profile);
  expect(() => planProxy({ ...shared, container, observability })).toThrow(
    /ターゲット集合が一致します/,
  );
});
test("ProxyStage: resolves scopes in target-specificity order", () => {
  const profile = makeProfile({
    network: {
      fallback: "review",
      scopes: {
        wide: { targets: ["*.example.com"], fallback: "review" },
        exact: {
          targets: ["api.example.com"],
          fallback: "deny",
          rules: {
            v1: {
              match: { methods: ["POST"], paths: ["/v1/**"] },
              onMatch: "allow",
              audit: "off",
            },
          },
        },
      },
    },
  });
  const { shared, container, observability } = makeInput(profile);

  const result = planProxy({ ...shared, container, observability });

  // 宣言順は wide が先だが、ドキュメントは特異度の降順で並ぶ。addon は
  // 先頭から探して最初に一致したスコープを採るので、この順序が
  // 「api.example.com は exact に属する」を保証している。
  expect(result.document.scopes.map((scope) => scope.name)).toEqual([
    "exact",
    "wide",
  ]);
  expect(result.document.fallback).toEqual("review");
  expect(result.document.scopes[0]!.rules[0]).toMatchObject({
    id: "exact.v1",
    onMatch: "allow",
    audit: "off",
  });
});

test("ProxyStage: sets proxy env vars", () => {
  const profile = makeProfile({
    network: { scopes: ALLOW_EXAMPLE },
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

test("ProxyStage: sets outputOverrides", () => {
  const profile = makeProfile({
    network: { scopes: ALLOW_EXAMPLE },
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
  });
  expect(result.outputOverrides.proxy).toEqual({
    brokerSocket: "/run/user/1000/nas/network/brokers/test-session-123/sock",
    proxyEndpoint,
  });
});

test("ProxyStage: planner sets networkName in outputOverrides", () => {
  const profile = makeProfile({
    network: { scopes: ALLOW_EXAMPLE },
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
    network: { scopes: ALLOW_EXAMPLE },
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

test("ProxyStage: uses profile network settings", () => {
  const profile = makeProfile({
    network: { scopes: ALLOW_EXAMPLE, fallback: "review" },
  });
  const { shared, container, observability } = makeInput(profile);

  const result = planProxy(
    { ...shared, container, observability },
    {
      generateSessionToken: () => "slice-token",
    },
  )!;

  expect(result.token).toEqual("slice-token");
  expect(result.outputOverrides.prompt).toEqual({
    promptToken: "slice-token",
  });
  expect(result.envVars.no_proxy).toEqual("localhost,127.0.0.1");
});

test("planProxy: carries requestBodyAudit without changing it", () => {
  const profile = makeProfile({
    network: { requestBodyAudit: REQUEST_BODY_AUDIT_CONFIG },
  });
  const { shared, container, observability } = makeInput(profile);

  const result = planProxy({ ...shared, container, observability });

  expect(result.requestBodyAudit).toEqual(REQUEST_BODY_AUDIT_CONFIG);
});

test("ProxyStage: planner merges proxy settings into existing container slice", () => {
  const profile = makeProfile({
    network: { scopes: ALLOW_EXAMPLE },
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
    mounts: [
      { source: "/existing-src", target: "/existing-target" },
      {
        source: "/run/user/1000/nas/network/mitmproxy-ca/mitmproxy-ca-cert.pem",
        target: "/usr/local/share/ca-certificates/nas-proxy.crt",
        readOnly: true,
      },
    ],
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
    extraHosts: [],
    extraRunArgs: ["--shm-size", "2g"],
    network: { mode: "network", name: "nas-session-net-test-session-123" },
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

function targetSources(plan: {
  document: { scopes: readonly { targets: readonly { source: string }[] }[] };
}): string[] {
  return plan.document.scopes.flatMap((scope) =>
    scope.targets.map((target) => target.source),
  );
}

test("ProxyStage: forwardPorts does NOT grant host.docker.internal a scope", () => {
  // Forward-ports flow through per-port UDS bind-mounts, so the local-proxy
  // does not dial host.docker.internal:<port> via CONNECT. The document
  // must therefore stay free of synthetic host.docker.internal targets —
  // a stale one would silently re-grant the host TCP escape route.
  const profile = makeProfile({
    network: { proxy: { forwardPorts: [8080, 5432] } },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect(targetSources(result)).toEqual([]);
});

test("ProxyStage: forwardPorts preserves a user-declared host.docker.internal target", () => {
  // If a profile explicitly puts host.docker.internal:* in a scope, it must
  // not be stripped — that is user intent, distinct from the implicit
  // injection driven by forwardPorts.
  const profile = makeProfile({
    network: {
      scopes: {
        forwarded: {
          targets: ["host.docker.internal:9999"],
          fallback: "allow",
        },
      },
      proxy: { forwardPorts: [8080] },
    },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect(targetSources(result)).toEqual(["host.docker.internal:9999"]);
});

test("ProxyStage: forwardPorts sets NAS_FORWARD_PORTS env var", () => {
  const profile = makeProfile({
    network: { proxy: { forwardPorts: [8080, 5432] } },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect(result.envVars.NAS_FORWARD_PORTS).toEqual("8080,5432");
});

test("ProxyStage: forwardPorts leaves the declared scopes untouched", () => {
  // Profile-declared targets pass through verbatim; forwardPorts no longer
  // contributes synthetic host.docker.internal entries.
  const profile = makeProfile({
    network: {
      scopes: ALLOW_EXAMPLE,
      proxy: { forwardPorts: [3000] },
    },
  });
  const { shared, container, observability } = makeInput(profile);
  const result = planProxy({ ...shared, container, observability })!;
  expect(targetSources(result)).toEqual(["example.com"]);
});

test("ProxyStage: no NAS_FORWARD_PORTS when forwardPorts is empty", () => {
  const profile = makeProfile({
    network: { scopes: ALLOW_EXAMPLE },
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
    network: { scopes: ALLOW_EXAMPLE },
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
    makeCaServiceFake(),
    makeNetworkRuntimeServiceFake(),
    makeProxyServiceFake(),
    makeSessionBrokerServiceFake(),
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
  expect(paths.caCertDir).toEqual("/run/user/1000/nas/network/mitmproxy-ca");
  expect(paths.addonScriptPath).toEqual(
    "/run/user/1000/nas/network/nas_addon.py",
  );
  expect(paths.authzDir).toEqual("/run/user/1000/nas/network/authz");
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
    makeCaServiceFake(),
    makeNetworkRuntimeServiceFake({
      gcStaleRuntime: () => {
        calls.push("gcStaleRuntime");
        return Effect.void;
      },
    }),
    makeProxyServiceFake({
      ensureSharedProxy: () => {
        calls.push("ensureSharedProxy");
        return Effect.void;
      },
      createSessionNetwork: () => {
        calls.push("createSessionNetwork");
        return Effect.succeed({
          teardown: () => Effect.void,
          proxyIp: "172.18.0.2",
        });
      },
    }),
    makeSessionBrokerServiceFake({
      start: () => {
        calls.push("sessionBrokerStart");
        return Effect.succeed({ close: () => Effect.void });
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
    "sessionBrokerStart",
    "forwardPortEnsureRelays",
    "ensureSharedProxy",
    "createSessionNetwork",
  ]);
  expect(result.network).toEqual({
    networkName: "nas-session-net-test-session-123",
    runtimeDir: "/run/user/1000/nas/network",
  });
  expect(result.prompt?.promptToken).toBeDefined();
  expect(result.container?.network).toEqual({
    mode: "network",
    name: "nas-session-net-test-session-123",
  });
  // Docker's embedded DNS SERVFAILs the proxy alias on some hosts, so the
  // resolved IP travels as a host mapping on the container plan rather than
  // as a --add-host flag baked in here (a container-network-mode agent
  // would reject the flag; whichever container owns the namespace expands
  // the mapping itself).
  expect(result.container?.extraHosts).toEqual([
    { host: "nas-proxy", ip: "172.18.0.2" },
  ]);
  expect(
    result.container?.extraRunArgs.some((arg) => arg.startsWith("--add-host=")),
  ).toBe(false);
});

test("createProxyStage().run(): calls services and returns merged output", async () => {
  const profile = makeProfile({
    network: { scopes: ALLOW_EXAMPLE },
  });
  const { shared, container, observability } = makeInput(profile);

  const calls: string[] = [];

  const layer = Layer.mergeAll(
    makeCaServiceFake(),
    makeNetworkRuntimeServiceFake({
      gcStaleRuntime: () => {
        calls.push("gcStaleRuntime");
        return Effect.void;
      },
    }),
    makeProxyServiceFake({
      ensureSharedProxy: () => {
        calls.push("ensureSharedProxy");
        return Effect.void;
      },
      createSessionNetwork: () => {
        calls.push("createSessionNetwork");
        return Effect.succeed({
          teardown: () => Effect.void,
          proxyIp: "172.18.0.2",
        });
      },
    }),
    makeSessionBrokerServiceFake({
      start: () => {
        calls.push("sessionBrokerStart");
        return Effect.succeed({ close: () => Effect.void });
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

  // All services were called in the expected order.
  expect(calls).toEqual([
    "gcStaleRuntime",
    "sessionBrokerStart",
    "forwardPortEnsureRelays",
    "ensureSharedProxy",
    "createSessionNetwork",
  ]);

  expect(result.network).toEqual({
    networkName: "nas-session-net-test-session-123",
    runtimeDir: "/run/user/1000/nas/network",
  });
  const proxyEndpoint = result.proxy!.proxyEndpoint;
  expect(result.prompt).toEqual({
    promptToken: "test-token-fixed",
  });
  expect(result.proxy).toEqual({
    brokerSocket: "/run/user/1000/nas/network/brokers/test-session-123/sock",
    proxyEndpoint,
  });

  expect(result.container?.network).toEqual({
    mode: "network",
    name: "nas-session-net-test-session-123",
  });
  expect(result.container?.env.static.http_proxy).toEqual(
    `http://127.0.0.1:${LOCAL_PROXY_PORT}`,
  );
  expect(result.container?.extraHosts).toEqual([
    { host: "nas-proxy", ip: "172.18.0.2" },
  ]);
  expect(
    result.container?.extraRunArgs.some((arg) => arg.startsWith("--add-host=")),
  ).toBe(false);
});

test("createProxyStage().run(): does not add an extraHosts entry when the proxy service reports no IP", async () => {
  const profile = makeProfile();

  const result = await runStageWithFakes(profile, {
    proxyService: makeProxyServiceFake({
      createSessionNetwork: () =>
        Effect.succeed({
          teardown: () => Effect.void,
          proxyIp: null,
        }),
    }),
  });

  expect(result.container?.extraHosts).toEqual([]);
});

test("createProxyStage().run(): gives both runtime consumers the same resolved document", async () => {
  const profile = makeProfile({ network: { scopes: POLICY_SCOPES } });
  const { shared, container, observability } = makeInput(profile);
  let writtenDocument: unknown;
  let brokerDocument: unknown;

  const layer = Layer.mergeAll(
    makeCaServiceFake(),
    makeNetworkRuntimeServiceFake({
      writeAuthzDocument: (_paths, _sessionId, document) =>
        Effect.sync(() => {
          writtenDocument = document;
        }),
    }),
    makeProxyServiceFake(),
    makeSessionBrokerServiceFake({
      start: (config) =>
        Effect.sync(() => {
          brokerDocument = config.document;
          return { close: () => Effect.void };
        }),
    }),
    makeForwardPortRelayServiceFake(),
  );

  await Effect.runPromise(
    createProxyStage(shared)
      .run({ container, observability })
      .pipe(Effect.scoped, Effect.provide(layer)),
  );

  expect(writtenDocument).toMatchObject({ contractVersion: 1 });
  expect(brokerDocument).toBe(writtenDocument);
});

test("createProxyStage().run(): takes the resolved document away when the session ends", async () => {
  const profile = makeProfile({ network: { scopes: POLICY_SCOPES } });
  const { shared, container, observability } = makeInput(profile);
  const calls: string[] = [];

  const layer = Layer.mergeAll(
    makeCaServiceFake(),
    makeNetworkRuntimeServiceFake({
      writeAuthzDocument: () => Effect.sync(() => void calls.push("write")),
      removeAuthzDocument: (_paths, sessionId) =>
        Effect.sync(() => void calls.push(`remove:${sessionId}`)),
    }),
    makeProxyServiceFake(),
    makeSessionBrokerServiceFake(),
    makeForwardPortRelayServiceFake(),
  );

  await Effect.runPromise(
    createProxyStage(shared)
      .run({ container, observability })
      .pipe(Effect.scoped, Effect.provide(layer)),
  );

  expect(calls).toEqual(["write", "remove:test-session-123"]);
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

// ---------------------------------------------------------------------------
// Secret registry wiring tests
// ---------------------------------------------------------------------------

test("planProxy: carries the whole secret registry, mask.proxy or not", () => {
  const secrets = { "gh-token": { from: "cmd:gh auth token" } };
  const withMasking = makeProfile({ secrets });
  const withoutMasking = makeProfile({
    secrets,
    network: { defaults: { secrets: { "*": "ignore" } } },
    mask: {
      writePolicy: "readonly",
      maskfs: false,
      proxy: false,
      filter: false,
    },
  });
  const { shared, container, observability } = makeInput(withMasking);

  const masking = planProxy({ ...shared, container, observability });
  const unmasked = planProxy({
    ...makeInput(withoutMasking).shared,
    container,
    observability,
  });

  // 注入はマスクを経由しないので、mask.proxy = false でもレジストリは要る。
  expect(masking.secretRegistry).toEqual(secrets);
  expect(unmasked.secretRegistry).toEqual(secrets);
  expect(masking.proxyMasking).toEqual(true);
  expect(unmasked.proxyMasking).toEqual(false);
});

test("runProxy: resolves the registry and hands the values to the broker", async () => {
  const capturedRegistries: unknown[] = [];
  const capturedBrokerConfigs: SessionBrokerConfig[] = [];

  const profile = makeProfile({
    secrets: { "gh-token": { from: "env:GH_TOKEN" } },
    network: {
      scopes: {
        github: {
          targets: ["api.github.com"],
          fallback: "allow",
          secrets: { "gh-token": "inject" },
          inject: [
            // biome-ignore lint/suspicious/noTemplateCurlyInString: `template:` の参照構文であってテンプレートリテラルではない
            { name: "Authorization", value: "template:Bearer ${gh-token}" },
          ],
        },
      },
    },
  });
  const { shared, container, observability } = makeInput(profile);

  const layer = Layer.mergeAll(
    makeCaServiceFake(),
    makeNetworkRuntimeServiceFake({
      resolveSecrets: (secrets) =>
        Effect.sync(() => {
          capturedRegistries.push(secrets);
          return { "gh-token": ["token abc"] };
        }),
    }),
    makeProxyServiceFake({
      createSessionNetwork: () =>
        Effect.succeed({ teardown: () => Effect.void, proxyIp: null }),
    }),
    makeSessionBrokerServiceFake({
      start: (config) =>
        Effect.sync(() => {
          capturedBrokerConfigs.push(config);
          return { close: () => Effect.void };
        }),
    }),
    makeForwardPortRelayServiceFake(),
  );

  const stage = createProxyStageWithOptions(shared, {
    generateSessionToken: () => "test-token-secrets",
  });

  await Effect.runPromise(
    stage
      .run({ container, observability })
      .pipe(Effect.scoped, Effect.provide(layer)),
  );

  expect(capturedRegistries).toEqual([
    { "gh-token": { from: "env:GH_TOKEN" } },
  ]);
  expect(capturedBrokerConfigs[0]!.secretValues).toEqual({
    "gh-token": ["token abc"],
  });
  expect(capturedBrokerConfigs[0]!.proxyMasking).toEqual(true);
});

test("runProxy: hands requestBodyAudit to SessionBrokerService", async () => {
  const profile = makeProfile({
    network: { requestBodyAudit: REQUEST_BODY_AUDIT_CONFIG },
  });
  const capturedBrokerConfigs: SessionBrokerConfig[] = [];

  await runStageWithFakes(profile, {
    sessionBroker: makeSessionBrokerServiceFake({
      start: (config) =>
        Effect.sync(() => {
          capturedBrokerConfigs.push(config);
          return { close: () => Effect.void };
        }),
    }),
  });

  expect(capturedBrokerConfigs[0]!.requestBodyAudit).toEqual(
    REQUEST_BODY_AUDIT_CONFIG,
  );
});

// ---------------------------------------------------------------------------
// Mask value wiring tests
// ---------------------------------------------------------------------------

test("ProxyStage: mask.proxy = false still resolves secrets but stops masking", async () => {
  const profile = makeProfile({
    secrets: { secret: { from: "env:SECRET" } },
    network: {
      fallback: "review" as const,
      defaults: { secrets: { "*": "ignore" } },
    },
    mask: {
      writePolicy: "readonly",
      maskfs: true,
      proxy: false,
      filter: true,
    },
  });
  const captured: SessionBrokerConfig[] = [];
  let resolveCalled = false;
  await runStageWithFakes(profile, {
    networkRuntime: makeNetworkRuntimeServiceFake({
      resolveSecrets: () =>
        Effect.sync(() => {
          resolveCalled = true;
          return { secret: ["resolved-secret"] };
        }),
    }),
    sessionBroker: makeSessionBrokerServiceFake({
      start: (config) =>
        Effect.sync(() => {
          captured.push(config);
          return { close: () => Effect.void };
        }),
    }),
  });
  // 注入のために値そのものは要る。止まるのは置換と拒否だけである。
  expect(resolveCalled).toEqual(true);
  expect(captured[0]!.secretValues).toEqual({ secret: ["resolved-secret"] });
  expect(captured[0]!.proxyMasking).toEqual(false);
});
