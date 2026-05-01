/**
 * End-to-end wiring test for the observability slice.
 *
 * Boots the Live OTLP receiver service (real Bun.serve listener), runs
 * ObservabilityStage to acquire it, and then planProxy to confirm:
 *   - the receiverPort recorded in the slice is the same port that
 *     OTEL_EXPORTER_OTLP_ENDPOINT advertises to the agent;
 *   - the same port flows into the proxy plan's forwardPorts list
 *     (so the per-port UDS relay in the agent container will route to it).
 *
 * No agents, no Docker, no Envoy — only ObservabilityStage + planProxy on
 * top of the live receiver. This is the smallest harness that catches
 * drift between env / forwardPorts / listener.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import type { Config, Profile } from "../../config/types.ts";
import {
  type AgentType,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../../config/types.ts";
import { _closeHistoryDb } from "../../history/store.ts";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import type {
  HostEnv,
  ProbeResults,
  StageInput,
} from "../../pipeline/types.ts";
import { planProxy } from "../proxy/stage.ts";
import {
  makeOtlpReceiverServiceFake,
  OtlpReceiverServiceLive,
} from "./receiver_service.ts";
import { createObservabilityStage } from "./stage.ts";

let tmpRoot = "";

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "nas-obs-int-"));
  process.env.XDG_DATA_HOME = tmpRoot;
});

afterEach(async () => {
  _closeHistoryDb();
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  delete process.env.XDG_DATA_HOME;
});

function makeProfile(agent: AgentType): Profile {
  return {
    agent,
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
  };
}

function makeConfig(profile: Profile, enable: boolean): Config {
  return {
    ui: DEFAULT_UI_CONFIG,
    observability: { ...DEFAULT_OBSERVABILITY_CONFIG, enable },
    profiles: { dev: profile },
  };
}

function makeHost(): HostEnv {
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
    auditDir: "/audit",
  };
}

function makeContainer(): ContainerPlan {
  return {
    ...emptyContainerPlan("test-image", "/work"),
    command: { agentCommand: ["claude"], extraArgs: [] },
  };
}

test("observability + proxy: claude => env endpoint port matches receiver port and is in forwardPorts", async () => {
  const profile = makeProfile("claude");
  const config = makeConfig(profile, true);
  const sessionId = "sess_int_claude";
  const profileName = "dev";

  const stageInput: StageInput = {
    config,
    profile,
    profileName,
    sessionId,
    host: makeHost(),
    probes: makeProbes(),
  };

  const stage = createObservabilityStage({
    config,
    profile,
    profileName,
    sessionId,
  });

  const program = Effect.gen(function* () {
    const obsResult = yield* stage.run({ container: makeContainer() });

    const observability = obsResult.observability;
    const containerOut = obsResult.container ?? makeContainer();

    expect(observability).toBeDefined();
    if (!observability?.enabled) {
      throw new Error("expected enabled observability slice");
    }
    const receiverPort = observability.receiverPort;
    expect(receiverPort).toBeGreaterThan(0);

    const env = containerOut.env.static;
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toEqual(
      `http://127.0.0.1:${receiverPort}`,
    );

    const proxyPlan = planProxy({
      ...stageInput,
      container: containerOut,
      observability,
    });
    expect([...proxyPlan.forwardPorts]).toContain(receiverPort);

    return receiverPort;
  });

  const port = await Effect.runPromise(
    program.pipe(Effect.scoped, Effect.provide(OtlpReceiverServiceLive)),
  );

  // Listener is closed by Effect.scoped — confirm the port is no longer
  // bound by trying to bind it ourselves. If the close were skipped this
  // would fail with EADDRINUSE.
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => new Response("ok"),
  });
  try {
    expect(probe.port).toEqual(port);
  } finally {
    await probe.stop(true);
  }
});

test("observability + proxy: codex => receiver never started, slice disabled, no OTLP env, no forwardPorts entry", async () => {
  // Provide the Fake (not Live) so we can assert the receiver service is
  // never invoked for codex sessions. A non-zero startCount would mean the
  // codex short-circuit in shouldEnableObservability has regressed and a
  // listener is being burned for an agent that emits no OTLP.
  const profile = makeProfile("codex");
  const config = makeConfig(profile, true);
  const sessionId = "sess_int_codex";

  let startCount = 0;
  const fake = makeOtlpReceiverServiceFake({
    onStart: () => {
      startCount += 1;
    },
  });

  const stageInput: StageInput = {
    config,
    profile,
    profileName: "dev",
    sessionId,
    host: makeHost(),
    probes: makeProbes(),
  };

  const stage = createObservabilityStage({
    config,
    profile,
    profileName: "dev",
    sessionId,
  });

  const program = Effect.gen(function* () {
    const obsResult = yield* stage.run({ container: makeContainer() });
    expect(obsResult.observability).toEqual({ enabled: false });
    expect(obsResult.container).toBeUndefined();

    const proxyPlan = planProxy({
      ...stageInput,
      container: makeContainer(),
      observability: { enabled: false },
    });
    expect([...proxyPlan.forwardPorts]).toEqual([]);
  });

  await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(fake)));

  expect(startCount).toEqual(0);
});
