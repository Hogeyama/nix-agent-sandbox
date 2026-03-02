import { assertEquals } from "@std/assert";
import { createContext } from "../src/pipeline/context.ts";
import { runPipeline } from "../src/pipeline/pipeline.ts";
import type { Stage } from "../src/pipeline/pipeline.ts";
import type { Config, Profile } from "../src/config/types.ts";

const testProfile: Profile = {
  agent: "claude",
  agentArgs: [],
  nix: { enable: "auto", mountSocket: true, extraPackages: [] },
  docker: { mountSocket: false },
  env: {},
};

const testConfig: Config = {
  default: "test",
  profiles: { test: testProfile },
};

Deno.test("createContext: returns correct initial values", () => {
  const ctx = createContext(testConfig, testProfile, "test", "/tmp/work");
  assertEquals(ctx.profileName, "test");
  assertEquals(ctx.workDir, "/tmp/work");
  assertEquals(ctx.imageName, "nas-sandbox");
  assertEquals(ctx.dockerArgs, []);
  assertEquals(ctx.nixEnabled, false);
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
