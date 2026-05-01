import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";

/**
 * ObservabilityStage unit tests.
 *
 * Two branches:
 *   - Disabled (config.observability.enable = false, or agent = codex):
 *     materializes `{ enabled: false }` and emits no container patch. The
 *     receiver service is never invoked.
 *   - Enabled: acquires the receiver via OtlpReceiverService, exposes the
 *     port via the slice, and merges the OTLP envs into the container slice.
 *     The receiver is closed when the stage's scope closes.
 */

import type { AgentType, Config, Profile } from "../../config/types.ts";
import type { StartOtlpReceiverOptions } from "../../history/receiver.ts";
import { _closeHistoryDb } from "../../history/store.ts";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import { makeOtlpReceiverServiceFake } from "../observability.ts";
import {
  createObservabilityStage,
  shouldEnableObservability,
} from "./stage.ts";

let tmpRoot = "";

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "nas-obs-stage-"));
  // The stage opens history.db under XDG_DATA_HOME/nas/history.db. Pin
  // XDG_DATA_HOME to a temp dir so each test gets a fresh store.
  process.env.XDG_DATA_HOME = tmpRoot;
});

afterEach(async () => {
  // Drop any cached writer handle so the next test reopens against its
  // own tmp dir; otherwise the cache returns a handle pointing at the
  // previous test's (already-removed) directory.
  _closeHistoryDb();
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  delete process.env.XDG_DATA_HOME;
});

function makeContainer(): ContainerPlan {
  return {
    ...emptyContainerPlan("test-image", "/work"),
    command: { agentCommand: ["claude"], extraArgs: [] },
  };
}

function makeDeps(args: {
  enable: boolean;
  agent: AgentType;
  profileName?: string;
  sessionId?: string;
}) {
  const config = { observability: { enable: args.enable } } as Pick<
    Config,
    "observability"
  >;
  const profile = { agent: args.agent } as Pick<Profile, "agent">;
  return {
    config,
    profile,
    profileName: args.profileName ?? "dev",
    sessionId: args.sessionId ?? "sess_abc123",
  };
}

// ---------------------------------------------------------------------------
// shouldEnableObservability — pure decision
// ---------------------------------------------------------------------------

test("shouldEnableObservability: disabled config => false for every agent", () => {
  for (const agent of ["claude", "copilot", "codex"] as const) {
    expect(
      shouldEnableObservability({
        config: { observability: { enable: false } },
        profile: { agent },
      }),
    ).toEqual(false);
  }
});

test("shouldEnableObservability: enabled config => true for claude/copilot, false for codex", () => {
  expect(
    shouldEnableObservability({
      config: { observability: { enable: true } },
      profile: { agent: "claude" },
    }),
  ).toEqual(true);
  expect(
    shouldEnableObservability({
      config: { observability: { enable: true } },
      profile: { agent: "copilot" },
    }),
  ).toEqual(true);
  expect(
    shouldEnableObservability({
      config: { observability: { enable: true } },
      profile: { agent: "codex" },
    }),
  ).toEqual(false);
});

// ---------------------------------------------------------------------------
// Stage metadata
// ---------------------------------------------------------------------------

test("ObservabilityStage: declares container as a slice dependency", () => {
  const stage = createObservabilityStage(
    makeDeps({ enable: false, agent: "claude" }),
  );
  expect(stage.name).toEqual("ObservabilityStage");
  expect(stage.needs).toEqual(["container"]);
});

// ---------------------------------------------------------------------------
// Disabled fast-path
// ---------------------------------------------------------------------------

test("ObservabilityStage: disabled config => slice { enabled: false }, no receiver acquired, no container patch", async () => {
  let startCount = 0;
  const fake = makeOtlpReceiverServiceFake({
    onStart: () => {
      startCount += 1;
    },
  });

  const stage = createObservabilityStage(
    makeDeps({ enable: false, agent: "claude" }),
  );
  const result = await Effect.runPromise(
    stage
      .run({ container: makeContainer() })
      .pipe(Effect.scoped, Effect.provide(fake)),
  );

  expect(result).toEqual({ observability: { enabled: false } });
  expect(startCount).toEqual(0);
});

test("ObservabilityStage: enabled config + codex => slice { enabled: false }, no receiver acquired", async () => {
  // Codex is intentionally skipped: it does not emit OTLP, so we don't burn
  // a listener and we don't inject envs that would mislead operators into
  // thinking codex is being observed.
  let startCount = 0;
  const fake = makeOtlpReceiverServiceFake({
    onStart: () => {
      startCount += 1;
    },
  });

  const stage = createObservabilityStage(
    makeDeps({ enable: true, agent: "codex" }),
  );
  const result = await Effect.runPromise(
    stage
      .run({ container: makeContainer() })
      .pipe(Effect.scoped, Effect.provide(fake)),
  );

  expect(result).toEqual({ observability: { enabled: false } });
  expect(startCount).toEqual(0);
});

// ---------------------------------------------------------------------------
// Enabled path
// ---------------------------------------------------------------------------

test("ObservabilityStage: enabled + claude => slice carries port, container env carries OTLP + CLAUDE_CODE envs", async () => {
  const fake = makeOtlpReceiverServiceFake({ port: 41234 });

  const stage = createObservabilityStage(
    makeDeps({
      enable: true,
      agent: "claude",
      profileName: "dev",
      sessionId: "sess_abc123",
    }),
  );

  const baseContainer: ContainerPlan = {
    ...emptyContainerPlan("base-image", "/work"),
    env: { static: { EXISTING: "x" }, dynamicOps: [] },
    command: { agentCommand: ["claude"], extraArgs: [] },
  };

  const result = await Effect.runPromise(
    stage
      .run({ container: baseContainer })
      .pipe(Effect.scoped, Effect.provide(fake)),
  );

  expect(result.observability).toEqual({
    enabled: true,
    receiverPort: 41234,
  });

  const env = result.container?.env.static ?? {};
  expect(env.EXISTING).toEqual("x");
  expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toEqual("http://127.0.0.1:41234");
  expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toEqual("http/json");
  expect(env.OTEL_RESOURCE_ATTRIBUTES).toEqual(
    "nas.session.id=sess_abc123,nas.profile=dev,nas.agent=claude",
  );
  expect(env.OTEL_METRIC_EXPORT_INTERVAL).toEqual("5000");
  expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toEqual("1");
  expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toEqual("1");
  expect(env.COPILOT_OTEL_ENABLED).toBeUndefined();
});

test("ObservabilityStage: enabled + copilot => COPILOT_OTEL_ENABLED + common envs, no CLAUDE_CODE", async () => {
  const fake = makeOtlpReceiverServiceFake({ port: 53000 });

  const stage = createObservabilityStage(
    makeDeps({
      enable: true,
      agent: "copilot",
      profileName: "p",
      sessionId: "s",
    }),
  );

  const result = await Effect.runPromise(
    stage
      .run({ container: makeContainer() })
      .pipe(Effect.scoped, Effect.provide(fake)),
  );

  const env = result.container?.env.static ?? {};
  expect(env.COPILOT_OTEL_ENABLED).toEqual("true");
  expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
  expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBeUndefined();
  expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toEqual("http://127.0.0.1:53000");
});

test("ObservabilityStage: enabled path overrides any pre-existing OTEL_* keys in the container slice (last-wins)", async () => {
  // Profile-level env may collide with our OTLP keys (e.g. an operator that
  // pinned OTEL_EXPORTER_OTLP_ENDPOINT to an external collector). The
  // observability stage runs after MountStage, and mergeContainerPlan is
  // patch-wins on env.static, so the stage's values take precedence.
  const fake = makeOtlpReceiverServiceFake({ port: 41234 });

  const baseContainer: ContainerPlan = {
    ...emptyContainerPlan("base-image", "/work"),
    env: {
      static: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://external:4318",
        OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      },
      dynamicOps: [],
    },
    command: { agentCommand: ["claude"], extraArgs: [] },
  };

  const stage = createObservabilityStage(
    makeDeps({ enable: true, agent: "claude" }),
  );
  const result = await Effect.runPromise(
    stage
      .run({ container: baseContainer })
      .pipe(Effect.scoped, Effect.provide(fake)),
  );

  const env = result.container?.env.static ?? {};
  expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toEqual("http://127.0.0.1:41234");
  expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toEqual("http/json");
});

test("ObservabilityStage: receiver close runs when stage scope closes", async () => {
  // Counts release callbacks via a custom Layer whose handle.close
  // increments a counter; asserts the counter == 1 after Effect.scoped
  // completes the happy path.
  let closeCalls = 0;
  const seen: StartOtlpReceiverOptions[] = [];
  const { Layer } = await import("effect");
  const { OtlpReceiverService } = await import("./receiver_service.ts");
  const fake = Layer.succeed(
    OtlpReceiverService,
    OtlpReceiverService.of({
      start: (options) =>
        Effect.sync(() => {
          seen.push(options);
          return {
            port: 9999,
            close: async () => {
              closeCalls += 1;
            },
          };
        }),
    }),
  );

  const stage = createObservabilityStage(
    makeDeps({ enable: true, agent: "claude" }),
  );
  await Effect.runPromise(
    stage
      .run({ container: makeContainer() })
      .pipe(Effect.scoped, Effect.provide(fake)),
  );

  expect(seen.length).toEqual(1);
  expect(closeCalls).toEqual(1);
});

test("ObservabilityStage: receiver close runs even when the stage scope fails after acquire", async () => {
  // Pins the acquireRelease guarantee: if any Effect downstream of the
  // receiver acquire fails, the release callback still fires exactly once
  // when Effect.scoped tears down the scope. Without this the stage could
  // leak a bound listener on partial-failure paths.
  let closeCalls = 0;
  const { Layer } = await import("effect");
  const { OtlpReceiverService } = await import("./receiver_service.ts");
  const fake = Layer.succeed(
    OtlpReceiverService,
    OtlpReceiverService.of({
      start: () =>
        Effect.sync(() => ({
          port: 9999,
          close: async () => {
            closeCalls += 1;
          },
        })),
    }),
  );

  const stage = createObservabilityStage(
    makeDeps({ enable: true, agent: "claude" }),
  );

  // Chain a failing Effect after the stage's run so the scope unwinds with
  // a failure. Effect.scoped must still drain the release queue.
  const program = stage.run({ container: makeContainer() }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("post-acquire failure"))),
    Effect.scoped,
    Effect.provide(fake),
  );

  const exit = await Effect.runPromiseExit(program);
  expect(exit._tag).toEqual("Failure");
  expect(closeCalls).toEqual(1);
});
