import { assertEquals, assertRejects } from "@std/assert";
import { adaptLegacyStage } from "../src/pipeline/adapt.ts";
import type { ExecutionContext } from "../src/pipeline/context.ts";
import type { Stage } from "../src/pipeline/pipeline.ts";
import type { StageInput } from "../src/pipeline/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    config: { profiles: {} } as ExecutionContext["config"],
    profile: { agent: "claude" } as ExecutionContext["profile"],
    profileName: "test",
    sessionId: "sess_000000000000",
    workDir: "/workspace",
    imageName: "nas-sandbox",
    dockerArgs: [],
    envVars: {},
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
    nixEnabled: false,
    agentCommand: ["claude"],
    logLevel: "info",
    ...overrides,
  };
}

const dummyInput: StageInput = {
  config: { profiles: {} } as StageInput["config"],
  profile: { agent: "claude" } as StageInput["profile"],
  profileName: "test",
  sessionId: "sess_000000000000",
  host: {
    home: "/home/user",
    user: "user",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map(),
  },
  probes: {
    hasHostNix: false,
    xdgDbusProxyPath: null,
    dbusSessionAddress: null,
    gpgAgentSocket: null,
    auditDir: "/tmp/nas-audit",
  },
  prior: {
    dockerArgs: [],
    envVars: {},
    workDir: "/workspace",
    nixEnabled: false,
    imageName: "nas-sandbox",
    agentCommand: ["claude"],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("adaptLegacyStage: returns ProceduralStage with correct kind and name", () => {
  const legacy: Stage = {
    name: "my-stage",
    execute: (ctx) => Promise.resolve(ctx),
  };
  const adapted = adaptLegacyStage(legacy, makeCtx());

  assertEquals(adapted.kind, "procedural");
  assertEquals(adapted.name, "my-stage");
});

Deno.test("adaptLegacyStage: execute() delegates to legacy stage", async () => {
  let executeCalled = false;
  const legacy: Stage = {
    name: "delegate-test",
    execute: (ctx) => {
      executeCalled = true;
      return Promise.resolve({ ...ctx, workDir: "/new-dir" });
    },
  };

  const adapted = adaptLegacyStage(legacy, makeCtx());
  const result = await adapted.execute(dummyInput);

  assertEquals(executeCalled, true);
  assertEquals(result.outputOverrides.workDir, "/new-dir");
});

Deno.test("adaptLegacyStage: extracts changed scalar fields as overrides", async () => {
  const legacy: Stage = {
    name: "scalar-changes",
    execute: (ctx) =>
      Promise.resolve({
        ...ctx,
        nixEnabled: true,
        imageName: "custom-image",
        networkRuntimeDir: "/run/net",
      }),
  };

  const adapted = adaptLegacyStage(legacy, makeCtx());
  const result = await adapted.execute(dummyInput);

  assertEquals(result.outputOverrides.nixEnabled, true);
  assertEquals(result.outputOverrides.imageName, "custom-image");
  assertEquals(result.outputOverrides.networkRuntimeDir, "/run/net");
  // Unchanged fields should not appear
  assertEquals(result.outputOverrides.workDir, undefined);
});

Deno.test("adaptLegacyStage: extracts changed dockerArgs and envVars as diff", async () => {
  const legacy: Stage = {
    name: "args-env-changes",
    execute: (ctx) =>
      Promise.resolve({
        ...ctx,
        dockerArgs: [...ctx.dockerArgs, "--rm", "--network=host"],
        envVars: { ...ctx.envVars, FOO: "bar" },
      }),
  };

  const adapted = adaptLegacyStage(
    legacy,
    makeCtx({ dockerArgs: ["--existing"], envVars: { KEEP: "yes" } }),
  );
  const result = await adapted.execute(dummyInput);

  // Only the newly added args are returned (diff from old)
  assertEquals(result.outputOverrides.dockerArgs, [
    "--rm",
    "--network=host",
  ]);
  // Only the new/changed env keys are returned
  assertEquals(result.outputOverrides.envVars, { FOO: "bar" });
});

Deno.test("adaptLegacyStage: no changes yields empty overrides", async () => {
  const ctx = makeCtx();
  const legacy: Stage = {
    name: "no-change",
    execute: (c) => Promise.resolve(c),
  };

  const adapted = adaptLegacyStage(legacy, ctx);
  const result = await adapted.execute(dummyInput);

  assertEquals(result.outputOverrides, {});
});

Deno.test("adaptLegacyStage: teardown is undefined when legacy has no teardown", () => {
  const legacy: Stage = {
    name: "no-teardown",
    execute: (ctx) => Promise.resolve(ctx),
  };
  const adapted = adaptLegacyStage(legacy, makeCtx());

  assertEquals(adapted.teardown, undefined);
});

Deno.test("adaptLegacyStage: teardown delegates to legacy stage", async () => {
  let teardownCalled = false;
  let teardownReceivedCtx: ExecutionContext | null = null;

  const legacy: Stage = {
    name: "with-teardown",
    execute: (ctx) => Promise.resolve({ ...ctx, workDir: "/changed" }),
    teardown: async (ctx) => {
      teardownCalled = true;
      teardownReceivedCtx = ctx;
    },
  };

  const ctx = makeCtx();
  const adapted = adaptLegacyStage(legacy, ctx);

  // Execute first to update internal ctx
  await adapted.execute(dummyInput);

  // Now teardown
  await adapted.teardown!(dummyInput);

  assertEquals(teardownCalled, true);
  // teardown should receive the updated ctx (after execute)
  assertEquals(teardownReceivedCtx!.workDir, "/changed");
});

Deno.test("adaptLegacyStage: execute() propagates error and does not update internal ctx", async () => {
  let teardownCtx: ExecutionContext | null = null;
  const legacy: Stage = {
    name: "throwing-stage",
    execute: (_ctx) => {
      throw new Error("stage exploded");
    },
    teardown: async (ctx) => {
      teardownCtx = ctx;
    },
  };

  const originalCtx = makeCtx({ workDir: "/original" });
  const adapted = adaptLegacyStage(legacy, originalCtx);

  await assertRejects(
    () => adapted.execute(dummyInput),
    Error,
    "stage exploded",
  );

  // After a failed execute, teardown should still see the original ctx
  await adapted.teardown!(dummyInput);
  assertEquals(teardownCtx!.workDir, "/original");
});

Deno.test("adaptLegacyStage: multiple executes update internal ctx", async () => {
  let callCount = 0;
  const legacy: Stage = {
    name: "multi-exec",
    execute: (ctx) => {
      callCount++;
      return Promise.resolve({
        ...ctx,
        workDir: `/step-${callCount}`,
      });
    },
  };

  const adapted = adaptLegacyStage(legacy, makeCtx());

  const result1 = await adapted.execute(dummyInput);
  assertEquals(result1.outputOverrides.workDir, "/step-1");

  const result2 = await adapted.execute(dummyInput);
  assertEquals(result2.outputOverrides.workDir, "/step-2");
});
