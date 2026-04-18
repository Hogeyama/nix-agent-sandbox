import { expect, test } from "bun:test";

/**
 * DisplayStage unit テスト
 *
 * Fake DisplayService を使った stage orchestration + planner の純粋テスト。
 * 実際の xpra 起動は行わない。
 */

import { Cause, Effect, Exit, Scope } from "effect";
import type { Config, Profile } from "../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import type { HostEnv, ProbeResults, StageInput } from "../pipeline/types.ts";
import {
  type DisplayHandle,
  type DisplayStartPlan,
  makeDisplayServiceFake,
} from "../services/display.ts";
import {
  createDisplayStage,
  pickFreeDisplayNumber,
  planDisplay,
} from "./display.ts";
import type { MountProbes } from "./mount_probes.ts";

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
    xdgDbusProxyPath: null,
    dbusSessionAddress: null,
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

function makeMountProbes(overrides: Partial<MountProbes> = {}): MountProbes {
  return {
    agentProbes: {} as MountProbes["agentProbes"],
    nixConfRealPath: null,
    nixBinPath: null,
    gitConfigExists: false,
    gcloudConfigExists: false,
    gpgSocketExists: false,
    gpgConfExists: false,
    gpgAgentConfExists: false,
    gpgPubringExists: false,
    gpgTrustdbExists: false,
    awsConfigExists: false,
    resolvedExtraMounts: [],
    resolvedEnvEntries: [],
    gitWorktreeMainRoot: null,
    xpraBinPath: "/usr/bin/xpra",
    takenX11Displays: new Set<number>(),
    ...overrides,
  };
}

// ===========================================================================
// pickFreeDisplayNumber
// ===========================================================================

test("pickFreeDisplayNumber: returns 100 when nothing is taken", () => {
  expect(pickFreeDisplayNumber(new Set())).toEqual(100);
});

test("pickFreeDisplayNumber: skips taken numbers", () => {
  expect(pickFreeDisplayNumber(new Set([100, 101, 102]))).toEqual(103);
});

test("pickFreeDisplayNumber: ignores numbers outside the search range", () => {
  // :0–:99 are caller's problem; the picker starts at 100 regardless.
  expect(pickFreeDisplayNumber(new Set([0, 1, 99]))).toEqual(100);
});

// ===========================================================================
// planDisplay (pure)
// ===========================================================================

test("planDisplay: errors when xpra is not on PATH", () => {
  const input = makeStageInput(
    makeProfile({ display: { sandbox: "xpra", size: "1920x1080" } }),
  );
  const probes = makeMountProbes({ xpraBinPath: null });
  const result = planDisplay(input, probes);
  expect(result.kind).toEqual("error");
  if (result.kind === "error") {
    expect(result.message).toContain("xpra not found");
  }
});

test("planDisplay: produces a startPlan with a free display number", () => {
  const input = makeStageInput(
    makeProfile({ display: { sandbox: "xpra", size: "1366x768" } }),
  );
  const probes = makeMountProbes({ takenX11Displays: new Set([100, 101]) });
  const result = planDisplay(input, probes);
  expect(result.kind).toEqual("ok");
  if (result.kind === "ok") {
    const plan = result.plan.startPlan;
    expect(plan.displayNumber).toEqual(102);
    expect(plan.size).toEqual("1366x768");
    expect(plan.socketPath).toEqual("/tmp/.X11-unix/X102");
    expect(plan.xpraBinaryPath).toEqual("/usr/bin/xpra");
    expect(plan.sessionDir).toEqual(
      "/run/user/1000/nas/display/test-session-1234",
    );
    expect(plan.xauthorityPath).toEqual(
      "/run/user/1000/nas/display/test-session-1234/Xauthority",
    );
    expect(plan.xpraInternalXauthPath).toEqual("/home/test/.Xauthority");
    expect(plan.sessionId).toEqual("test-session-1234");
  }
});

test("planDisplay: falls back to /tmp/nas-<uid>/display when XDG_RUNTIME_DIR is unset", () => {
  const profile = makeProfile({
    display: { sandbox: "xpra", size: "1920x1080" },
  });
  const input: StageInput = {
    ...makeStageInput(profile),
    host: {
      home: "/home/test",
      user: "test",
      uid: 1000,
      gid: 1000,
      isWSL: false,
      env: new Map(),
    },
  };
  const probes = makeMountProbes();
  const result = planDisplay(input, probes);
  expect(result.kind).toEqual("ok");
  if (result.kind === "ok") {
    expect(result.plan.startPlan.sessionDir).toEqual(
      "/tmp/nas-1000/display/test-session-1234",
    );
  }
});

// ===========================================================================
// EffectStage orchestration
// ===========================================================================

test("DisplayStage: returns enabled=false without calling service when sandbox=none", async () => {
  let called = false;
  const fakeLayer = makeDisplayServiceFake({
    startXpra: (plan) => {
      called = true;
      return Effect.succeed({
        kill: () => {},
        displayNumber: plan.displayNumber,
        socketPath: plan.socketPath,
        xauthorityPath: plan.xauthorityPath,
        logPath: `${plan.sessionDir}/xpra.log`,
      } satisfies DisplayHandle);
    },
  });

  const input = makeStageInput(makeProfile()); // default = sandbox: none
  const stage = createDisplayStage(input, makeMountProbes());

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

  expect(called).toEqual(false);
  expect(result.display).toEqual({ enabled: false });
});

test("DisplayStage: calls startXpra and returns enabled=true when sandbox=xpra", async () => {
  const startCalls: DisplayStartPlan[] = [];
  const fakeLayer = makeDisplayServiceFake({
    startXpra: (plan) => {
      startCalls.push(plan);
      return Effect.succeed({
        kill: () => {},
        displayNumber: plan.displayNumber,
        socketPath: plan.socketPath,
        xauthorityPath: plan.xauthorityPath,
        logPath: `${plan.sessionDir}/xpra.log`,
      } satisfies DisplayHandle);
    },
  });

  const input = makeStageInput(
    makeProfile({ display: { sandbox: "xpra", size: "1280x720" } }),
  );
  const stage = createDisplayStage(input, makeMountProbes());

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
  expect(startCalls[0].size).toEqual("1280x720");
  expect(startCalls[0].displayNumber).toEqual(100);
  expect(startCalls[0].socketPath).toEqual("/tmp/.X11-unix/X100");
  expect(result.display).toEqual({
    enabled: true,
    displayNumber: 100,
    socketPath: "/tmp/.X11-unix/X100",
    xauthorityPath: "/run/user/1000/nas/display/test-session-1234/Xauthority",
  });
});

test("DisplayStage: surfaces 'xpra not found' error when binary missing", async () => {
  const fakeLayer = makeDisplayServiceFake();
  const input = makeStageInput(
    makeProfile({ display: { sandbox: "xpra", size: "1920x1080" } }),
  );
  const stage = createDisplayStage(
    input,
    makeMountProbes({ xpraBinPath: null }),
  );

  const scope = Effect.runSync(Scope.make());
  const exit = await Effect.runPromiseExit(
    stage
      .run({})
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(fakeLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(Exit.isFailure(exit)).toEqual(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toEqual("Some");
    if (failure._tag === "Some") {
      const err = failure.value as Error;
      expect(err.message).toContain("xpra not found");
    }
  }
});

test("DisplayStage: kill handler runs on scope close", async () => {
  let killCalls = 0;
  const fakeLayer = makeDisplayServiceFake({
    startXpra: (plan) =>
      Effect.acquireRelease(
        Effect.succeed({
          kill: () => {
            killCalls += 1;
          },
          displayNumber: plan.displayNumber,
          socketPath: plan.socketPath,
          xauthorityPath: plan.xauthorityPath,
          logPath: `${plan.sessionDir}/xpra.log`,
        } satisfies DisplayHandle),
        (handle) => Effect.sync(() => handle.kill()),
      ),
  });

  const input = makeStageInput(
    makeProfile({ display: { sandbox: "xpra", size: "1920x1080" } }),
  );
  const stage = createDisplayStage(input, makeMountProbes());

  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(
    stage
      .run({})
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(fakeLayer),
      ),
  );
  expect(killCalls).toEqual(0);
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(killCalls).toEqual(1);
});
