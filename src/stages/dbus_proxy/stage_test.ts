import { expect, test } from "bun:test";

/**
 * DbusProxyStage unit テスト（Docker 不要）
 *
 * Fake DbusProxyService を使った stage orchestration テスト。
 * pure planner テストと integration テストは dbus_proxy_integration_test.ts を参照。
 */

import { Effect, Exit, Scope } from "effect";
import type { Config, Profile } from "../../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../../config/types.ts";
import type {
  HostEnv,
  ProbeResults,
  StageInput,
} from "../../pipeline/types.ts";
import {
  type DbusProxyHandle,
  type DbusProxyStartPlan,
  makeDbusProxyServiceFake,
} from "./dbus_proxy_service.ts";
import { createDbusProxyStage } from "./stage.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
    ...overrides,
  };
}

function makeStageInput(
  profile: Profile,
  sessionId = "test-session-1234",
): StageInput {
  const config: Config = {
    profiles: { default: profile },
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
  };
  const hostEnv: HostEnv = {
    home: "/home/test",
    user: "test",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([["XDG_RUNTIME_DIR", "/run/user/1000"]]),
  };
  const probes: ProbeResults = {
    hasHostNix: false,
    xdgDbusProxyPath: "/usr/bin/xdg-dbus-proxy",
    dbusSessionAddress: "unix:path=/run/user/1000/bus",
    gpgAgentSocket: null,
    auditDir: "/tmp/nas-test-audit",
  };
  return {
    config,
    profile,
    profileName: "default",
    sessionId,
    host: hostEnv,
    probes,
  };
}

// ============================================================
// EffectStage orchestration tests with Fake
// ============================================================

test("DbusProxyStage: run calls startProxy with correct plan when enabled", async () => {
  const startCalls: DbusProxyStartPlan[] = [];

  const fakeLayer = makeDbusProxyServiceFake({
    startProxy: (plan) => {
      startCalls.push(plan);
      return Effect.succeed({ kill: () => {} });
    },
  });

  const profile = makeProfile({
    dbus: {
      session: {
        ...structuredClone(DEFAULT_DBUS_CONFIG.session),
        enable: true,
        sourceAddress: "unix:path=/run/user/1000/bus",
        talk: ["org.freedesktop.secrets"],
      },
    },
  });
  const input = makeStageInput(profile);
  const stage = createDbusProxyStage(input);

  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run({})
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(fakeLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(startCalls.length).toEqual(1);
  expect(startCalls[0].proxyBinaryPath).toEqual("/usr/bin/xdg-dbus-proxy");
  expect(startCalls[0].socketPath).toContain("test-session-1234");
  expect(startCalls[0].socketPath).toEndWith("/bus");
  expect(startCalls[0].args).toContain("--filter");
  expect(startCalls[0].args).toContain("--talk=org.freedesktop.secrets");

  expect(result.dbus).toEqual({
    enabled: true,
    runtimeDir: "/run/user/1000/nas/dbus/sessions/test-session-1234",
    socket: "/run/user/1000/nas/dbus/sessions/test-session-1234/bus",
    sourceAddress: "unix:path=/run/user/1000/bus",
  });
});

test("DbusProxyStage: service-owned cleanup runs on scope close (no double kill)", async () => {
  let killCount = 0;

  const fakeLayer = makeDbusProxyServiceFake({
    startProxy: (_plan) =>
      Effect.acquireRelease(
        Effect.succeed<DbusProxyHandle>({
          kill: () => {
            killCount++;
          },
        }),
        (handle) => Effect.sync(() => handle.kill()),
      ),
  });

  const profile = makeProfile({
    dbus: {
      session: {
        ...structuredClone(DEFAULT_DBUS_CONFIG.session),
        enable: true,
        sourceAddress: "unix:path=/run/user/1000/bus",
      },
    },
  });
  const input = makeStageInput(profile);
  const stage = createDbusProxyStage(input);

  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(
    stage
      .run({})
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(fakeLayer),
      ),
  );

  // kill should not have been called yet (only on scope close)
  expect(killCount).toEqual(0);

  await Effect.runPromise(Scope.close(scope, Exit.void));

  // Service-owned cleanup: kill should be called exactly once
  expect(killCount).toEqual(1);
});

test("DbusProxyStage: run returns disabled dbus slice when disabled", async () => {
  const startCalls: DbusProxyStartPlan[] = [];

  const fakeLayer = makeDbusProxyServiceFake({
    startProxy: (plan) => {
      startCalls.push(plan);
      return Effect.succeed({ kill: () => {} });
    },
  });

  const profile = makeProfile();
  const input = makeStageInput(profile);
  const stage = createDbusProxyStage(input);

  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run({})
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(fakeLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(startCalls.length).toEqual(0);
  expect(result).toEqual({
    dbus: { enabled: false },
  });
});

test("DbusProxyStage: disabled run overwrites stale dbus slice", async () => {
  const fakeLayer = makeDbusProxyServiceFake({
    startProxy: (_plan) => Effect.succeed({ kill: () => {} }),
  });

  const profile = makeProfile();
  const input = makeStageInput(profile);
  const stage = createDbusProxyStage(input);
  const staleState = {
    dbus: {
      enabled: true,
      runtimeDir: "/stale/runtime",
      socket: "/stale/socket",
      sourceAddress: "unix:path=/stale/bus",
    },
  } as const;

  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run({})
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(fakeLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  const merged = { ...staleState, ...result };
  expect(merged.dbus).toEqual({ enabled: false });
});
