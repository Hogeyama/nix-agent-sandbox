import { expect, test } from "bun:test";
import type { Config, Profile } from "../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import type { PriorStageOutputs, StageInput } from "../pipeline/types.ts";
import { NixDetectStage } from "./nix_detect.ts";

function makeProfile(nixEnable: boolean | "auto"): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: nixEnable, mountSocket: true, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    extraMounts: [],
    env: [],
  };
}

function makePrior(overrides?: Partial<PriorStageOutputs>): PriorStageOutputs {
  return {
    dockerArgs: [],
    envVars: {},
    workDir: "/tmp/work",
    nixEnabled: false,
    imageName: "nas-sandbox",
    agentCommand: ["claude"],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
    ...overrides,
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
    prior: makePrior(),
  };
}

test("NixDetectStage: enable=true sets nixEnabled to true", () => {
  const plan = NixDetectStage.plan(makeInput(true, false));
  expect(plan?.outputOverrides.nixEnabled).toEqual(true);
});

test("NixDetectStage: enable=false sets nixEnabled to false", () => {
  const plan = NixDetectStage.plan(makeInput(false, true));
  expect(plan?.outputOverrides.nixEnabled).toEqual(false);
});

test("NixDetectStage: enable=auto uses probes.hasHostNix (true)", () => {
  const plan = NixDetectStage.plan(makeInput("auto", true));
  expect(plan?.outputOverrides.nixEnabled).toEqual(true);
});

test("NixDetectStage: enable=auto uses probes.hasHostNix (false)", () => {
  const plan = NixDetectStage.plan(makeInput("auto", false));
  expect(plan?.outputOverrides.nixEnabled).toEqual(false);
});

test("NixDetectStage: returns empty effects, dockerArgs, envVars", () => {
  const plan = NixDetectStage.plan(makeInput(true, false));
  expect(plan?.effects).toEqual([]);
  expect(plan?.dockerArgs).toEqual([]);
  expect(plan?.envVars).toEqual({});
});

test("NixDetectStage: kind is 'plan'", () => {
  expect(NixDetectStage.kind).toEqual("plan");
});

test("NixDetectStage: plan() always returns non-null (never skips)", () => {
  // NixDetectStage always produces a plan regardless of inputs
  for (const enable of [true, false, "auto" as const]) {
    for (const hasNix of [true, false]) {
      const plan = NixDetectStage.plan(makeInput(enable, hasNix));
      expect(plan !== null).toEqual(true);
    }
  }
});
