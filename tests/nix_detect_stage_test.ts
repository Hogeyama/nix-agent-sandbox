import { assertEquals } from "@std/assert";
import { NixDetectStage } from "../src/stages/nix_detect.ts";
import { createContext } from "../src/pipeline/context.ts";
import type { Config, Profile } from "../src/config/types.ts";

function makeProfile(nixEnable: boolean | "auto"): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: nixEnable, mountSocket: true, extraPackages: [] },
    docker: { mountSocket: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    extraMounts: [],
    env: [],
  };
}

function makeCtx(nixEnable: boolean | "auto") {
  const profile = makeProfile(nixEnable);
  const config: Config = { default: "test", profiles: { test: profile } };
  return createContext(config, profile, "test", "/tmp/work");
}

Deno.test("NixDetectStage: enable=true sets nixEnabled to true", async () => {
  const stage = new NixDetectStage();
  const result = await stage.execute(makeCtx(true));
  assertEquals(result.nixEnabled, true);
});

Deno.test("NixDetectStage: enable=false sets nixEnabled to false", async () => {
  const stage = new NixDetectStage();
  const result = await stage.execute(makeCtx(false));
  assertEquals(result.nixEnabled, false);
});

Deno.test("NixDetectStage: enable=auto detects based on /nix existence", async () => {
  const stage = new NixDetectStage();
  const result = await stage.execute(makeCtx("auto"));

  // /nix の有無でホスト依存の結果になる
  let hostHasNix: boolean;
  try {
    await Deno.stat("/nix");
    hostHasNix = true;
  } catch {
    hostHasNix = false;
  }
  assertEquals(result.nixEnabled, hostHasNix);
});

Deno.test("NixDetectStage: does not modify other context fields", async () => {
  const stage = new NixDetectStage();
  const ctx = makeCtx(true);
  const result = await stage.execute(ctx);
  assertEquals(result.workDir, ctx.workDir);
  assertEquals(result.imageName, ctx.imageName);
  assertEquals(result.dockerArgs, ctx.dockerArgs);
  assertEquals(result.envVars, ctx.envVars);
  assertEquals(result.profileName, ctx.profileName);
});
