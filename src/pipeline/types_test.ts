import { expect, test } from "bun:test";
import type {
  AnyStage,
  EffectStageResult,
  HostEnv,
  PriorStageOutputs,
  ProbeResults,
  StageInput,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Type import verification — these tests confirm that types are importable
// and structurally correct at runtime.
// ---------------------------------------------------------------------------

/** Minimal StageInput for tests. */
const dummyStageInput: StageInput = {
  config: { profiles: {} } as StageInput["config"],
  profile: { agent: "claude" } as StageInput["profile"],
  profileName: "default",
  sessionId: "test-session",
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

test("HostEnv: can construct with ReadonlyMap", () => {
  const env: HostEnv = {
    home: "/home/user",
    user: "user",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([
      ["HOME", "/home/user"],
      ["XDG_CACHE_HOME", "/home/user/.cache"],
    ]),
  };

  expect(env.home).toEqual("/home/user");
  expect(env.uid).toEqual(1000);
  expect(env.env.get("HOME")).toEqual("/home/user");
});

test("ProbeResults: can construct with all fields", () => {
  const probes: ProbeResults = {
    hasHostNix: true,
    xdgDbusProxyPath: "/usr/bin/xdg-dbus-proxy",
    dbusSessionAddress: "unix:path=/run/user/1000/bus",
    gpgAgentSocket: "/run/user/1000/gnupg/S.gpg-agent",
    auditDir: "/tmp/nas-audit",
  };

  expect(probes.hasHostNix).toEqual(true);
  expect(probes.gpgAgentSocket).toEqual("/run/user/1000/gnupg/S.gpg-agent");
});

test("PriorStageOutputs: can construct with required and optional fields", () => {
  const outputs: PriorStageOutputs = {
    dockerArgs: ["--rm"],
    envVars: { TERM: "xterm" },
    workDir: "/workspace",
    nixEnabled: false,
    imageName: "nas-sandbox",
    agentCommand: ["claude"],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
  };

  expect(outputs.workDir).toEqual("/workspace");
  expect(outputs.dindContainerName).toEqual(undefined);
});

test("EffectStageResult: is a partial of PriorStageOutputs", () => {
  const result: EffectStageResult = {
    workDir: "/new/path",
    nixEnabled: true,
  };

  expect(result.workDir).toEqual("/new/path");
  expect(result.nixEnabled).toEqual(true);
});

test("AnyStage: is EffectStage with kind 'effect'", () => {
  // Verify that AnyStage only accepts effect kind
  const stage: AnyStage = {
    kind: "effect",
    name: "test-effect-stage",
    run: (_input) => {
      // Just verify this compiles — Effect type not needed at runtime
      throw new Error("not called");
    },
  };

  expect(stage.kind).toEqual("effect");
  expect(stage.name).toEqual("test-effect-stage");
});

// Suppress unused variable warning
void dummyStageInput;
