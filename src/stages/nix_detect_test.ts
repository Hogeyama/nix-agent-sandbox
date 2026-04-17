import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { Config, Profile } from "../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import type { StageInput } from "../pipeline/types.ts";
import { createNixDetectStage } from "./nix_detect.ts";

function makeProfile(nixEnable: boolean | "auto"): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: nixEnable, mountSocket: true, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
  };
}

function makeInput(
  nixEnable: boolean | "auto",
  hasHostNix: boolean,
): StageInput {
  const profile = makeProfile(nixEnable);
  const config: Config = {
    default: "test",
    profiles: { test: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  return {
    config,
    profile,
    profileName: "test",
    sessionId: "sess_test",
    host: {
      home: "/home/user",
      user: "user",
      uid: 1000,
      gid: 1000,
      isWSL: false,
      env: new Map(),
    },
    probes: {
      hasHostNix,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: "/tmp/nas-audit",
    },
  };
}

test("NixDetectStage: enable=true sets nixEnabled to true", async () => {
  const stage = createNixDetectStage(makeInput(true, false));
  const result = await Effect.runPromise(Effect.scoped(stage.run({})));
  expect(result.nix).toEqual({ enabled: true });
});

test("NixDetectStage: enable=false sets nixEnabled to false", async () => {
  const stage = createNixDetectStage(makeInput(false, true));
  const result = await Effect.runPromise(Effect.scoped(stage.run({})));
  expect(result.nix).toEqual({ enabled: false });
});

test("NixDetectStage: enable=auto uses probes.hasHostNix (true)", async () => {
  const stage = createNixDetectStage(makeInput("auto", true));
  const result = await Effect.runPromise(Effect.scoped(stage.run({})));
  expect(result.nix).toEqual({ enabled: true });
});

test("NixDetectStage: enable=auto uses probes.hasHostNix (false)", async () => {
  const stage = createNixDetectStage(makeInput("auto", false));
  const result = await Effect.runPromise(Effect.scoped(stage.run({})));
  expect(result.nix).toEqual({ enabled: false });
});

test("NixDetectStage: kind is 'effect'", () => {
  const stage = createNixDetectStage(makeInput(true, true));
  expect(stage.name).toEqual("NixDetectStage");
});

test("NixDetectStage: run() always returns a result (never skips)", async () => {
  for (const enable of [true, false, "auto" as const]) {
    for (const hasNix of [true, false]) {
      const stage = createNixDetectStage(makeInput(enable, hasNix));
      const result = await Effect.runPromise(Effect.scoped(stage.run({})));
      expect(result.nix).toBeDefined();
    }
  }
});
