import { assertEquals, assertMatch } from "@std/assert";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_NETWORK_CONFIG,
} from "../src/config/types.ts";
import { createContext } from "../src/pipeline/context.ts";
import { runPipeline } from "../src/pipeline/pipeline.ts";
import type { Stage } from "../src/pipeline/pipeline.ts";
import type { Config, Profile } from "../src/config/types.ts";
import { setLogLevel } from "../src/log.ts";

const testProfile: Profile = {
  agent: "claude",
  agentArgs: [],
  nix: { enable: "auto", mountSocket: true, extraPackages: [] },
  docker: { enable: false, shared: false },
  gcloud: { mountConfig: false },
  aws: { mountConfig: false },
  gpg: { forwardAgent: false },
  network: structuredClone(DEFAULT_NETWORK_CONFIG),
  dbus: structuredClone(DEFAULT_DBUS_CONFIG),
  extraMounts: [],
  env: [],
};

const testConfig: Config = {
  default: "test",
  profiles: { test: testProfile },
};

Deno.test("createContext: returns correct initial values", () => {
  const ctx = createContext(testConfig, testProfile, "test", "/tmp/work");
  assertEquals(ctx.profileName, "test");
  assertMatch(ctx.sessionId, /^sess_[0-9a-f]{12}$/);
  assertEquals(ctx.workDir, "/tmp/work");
  assertEquals(ctx.imageName, "nas-sandbox");
  assertEquals(ctx.dockerArgs, []);
  assertEquals(ctx.networkPromptEnabled, false);
  assertEquals(ctx.networkPromptToken, undefined);
  assertEquals(ctx.nixEnabled, false);
});

Deno.test("createContext: generates prompt token when proxy path is enabled", () => {
  const profile: Profile = {
    ...testProfile,
    network: {
      ...structuredClone(DEFAULT_NETWORK_CONFIG),
      allowlist: ["github.com"],
    },
  };
  const ctx = createContext(testConfig, profile, "test", "/tmp/work");
  assertMatch(ctx.networkPromptToken ?? "", /^[0-9a-f]{64}$/);
});

Deno.test("runPipeline: executes stages in order", async () => {
  const order: string[] = [];

  const stage1: Stage = {
    name: "s1",
    execute: (ctx) => {
      order.push("s1");
      return Promise.resolve({ ...ctx, workDir: "/modified" });
    },
  };
  const stage2: Stage = {
    name: "s2",
    execute: (ctx) => {
      order.push("s2");
      return Promise.resolve(ctx);
    },
  };

  const ctx = createContext(testConfig, testProfile, "test", "/tmp/work");
  const result = await runPipeline([stage1, stage2], ctx);

  assertEquals(order, ["s1", "s2"]);
  assertEquals(result.workDir, "/modified");
});

Deno.test("runPipeline: calls teardown in reverse order", async () => {
  const order: string[] = [];

  const stage1: Stage = {
    name: "s1",
    execute: (ctx) => {
      order.push("exec-s1");
      return Promise.resolve(ctx);
    },
    teardown: () => {
      order.push("teardown-s1");
      return Promise.resolve();
    },
  };
  const stage2: Stage = {
    name: "s2",
    execute: (ctx) => {
      order.push("exec-s2");
      return Promise.resolve(ctx);
    },
    teardown: () => {
      order.push("teardown-s2");
      return Promise.resolve();
    },
  };

  const ctx = createContext(testConfig, testProfile, "test", "/tmp/work");
  await runPipeline([stage1, stage2], ctx);

  assertEquals(order, ["exec-s1", "exec-s2", "teardown-s2", "teardown-s1"]);
});

Deno.test("runPipeline: teardown runs even on execute failure", async () => {
  const order: string[] = [];

  const stage1: Stage = {
    name: "s1",
    execute: (ctx) => {
      order.push("exec-s1");
      return Promise.resolve(ctx);
    },
    teardown: () => {
      order.push("teardown-s1");
      return Promise.resolve();
    },
  };
  const stage2: Stage = {
    name: "s2",
    execute: () => {
      order.push("exec-s2");
      return Promise.reject(new Error("boom"));
    },
    teardown: () => {
      order.push("teardown-s2");
      return Promise.resolve();
    },
  };

  const ctx = createContext(testConfig, testProfile, "test", "/tmp/work");
  try {
    await runPipeline([stage1, stage2], ctx);
  } catch {
    // expected
  }

  // s2 failed during execute, so only s1's teardown is called (s2 not in completed)
  assertEquals(order, ["exec-s1", "exec-s2", "teardown-s1"]);
});

Deno.test("runPipeline: skips stages without teardown", async () => {
  const order: string[] = [];

  const stage1: Stage = {
    name: "s1",
    execute: (ctx) => {
      order.push("exec-s1");
      return Promise.resolve(ctx);
    },
  };
  const stage2: Stage = {
    name: "s2",
    execute: (ctx) => {
      order.push("exec-s2");
      return Promise.resolve(ctx);
    },
    teardown: () => {
      order.push("teardown-s2");
      return Promise.resolve();
    },
  };

  const ctx = createContext(testConfig, testProfile, "test", "/tmp/work");
  await runPipeline([stage1, stage2], ctx);

  assertEquals(order, ["exec-s1", "exec-s2", "teardown-s2"]);
});

Deno.test("runPipeline: quiet suppresses stage info logs", async () => {
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.join(" "));
  };

  try {
    setLogLevel("warn");
    const stage: Stage = {
      name: "quiet-stage",
      execute: (ctx) => Promise.resolve(ctx),
      teardown: () => Promise.resolve(),
    };
    const ctx = createContext(
      testConfig,
      testProfile,
      "test",
      "/tmp/work",
      "warn",
    );
    await runPipeline([stage], ctx);
    assertEquals(logged, []);
  } finally {
    console.log = originalLog;
    setLogLevel("info");
  }
});
