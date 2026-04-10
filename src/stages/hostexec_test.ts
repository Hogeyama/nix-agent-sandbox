import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import * as path from "node:path";
import { DEFAULT_DISPLAY_CONFIG, DEFAULT_UI_CONFIG } from "../config/types.ts";
import type { Config, Profile } from "../config/types.ts";
import type {
  HostEnv,
  PriorStageOutputs,
  StageInput,
  SymlinkEffect,
  UnixListenerEffect,
} from "../pipeline/types.ts";
import { createHostExecStage } from "./hostexec.ts";

function makeProfile(): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: {
      allowlist: [],
      prompt: {
        enable: false,
        denylist: [],
        timeoutSeconds: 300,
        defaultScope: "host-port",
        notify: "off",
      },
    },
    dbus: {
      session: {
        enable: false,
        see: [],
        talk: [],
        own: [],
        calls: [],
        broadcasts: [],
      },
    },
    extraMounts: [],
    env: [],
    hostexec: {
      prompt: {
        enable: true,
        timeoutSeconds: 300,
        defaultScope: "capability",
        notify: "off",
      },
      secrets: {
        token: { from: "env:TOKEN", required: false },
      },
      rules: [{
        id: "git-readonly",
        match: { argv0: "git", argRegex: "^pull\\b" },
        cwd: { mode: "workspace-or-session-tmp", allow: [] },
        env: { GITHUB_TOKEN: "secret:token" },
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "prompt",
        fallback: "container",
      }],
    },
  };
}

function makeHostEnv(runtimeDir: string): HostEnv {
  return {
    home: "/home/testuser",
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([
      ["HOME", "/home/testuser"],
      ["XDG_RUNTIME_DIR", runtimeDir],
    ]),
  };
}

function makeStageInput(
  profile: Profile,
  hostEnv: HostEnv,
  workDir?: string,
): StageInput {
  const config: Config = {
    profiles: { default: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  const prior: PriorStageOutputs = {
    dockerArgs: [],
    envVars: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    workDir: workDir ?? "/workspace",
    nixEnabled: false,
    imageName: "nas-test",
    agentCommand: ["claude"],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
  };
  return {
    config,
    profile,
    profileName: "default",
    sessionId: "test-session-id",
    host: hostEnv,
    probes: {
      hasHostNix: false,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: "/tmp/nas-test-audit",
    },
    prior,
  };
}

test("HostExecStage plan: returns null when no rules", () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [];
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();
  const plan = stage.plan(input);
  expect(plan).toEqual(null);
});

test("HostExecStage plan: produces correct effects and docker args", () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  // Check that wrapper directory mount is present
  expect(plan.dockerArgs.some((arg) => arg.includes("/opt/nas/hostexec/bin")))
    .toEqual(true);

  // Wrapper PATH activation is deferred to entrypoint agent exec.
  expect(plan.envVars["PATH"]).toBeUndefined();
  expect(plan.envVars["NAS_HOSTEXEC_WRAPPER_DIR"]).toEqual(
    "/opt/nas/hostexec/bin",
  );

  // Check socket env is set
  expect(plan.envVars["NAS_HOSTEXEC_SOCKET"] !== undefined).toEqual(true);
  expect(plan.envVars["NAS_HOSTEXEC_SESSION_ID"]).toEqual("test-session-id");

  // Check outputOverrides
  expect(plan.outputOverrides.hostexecBrokerSocket !== undefined).toEqual(true);
  expect(plan.outputOverrides.hostexecRuntimeDir !== undefined).toEqual(true);
  expect(
    (plan.outputOverrides.hostexecSessionTmpDir as string)?.includes(
      "test-session-id",
    ),
  ).toEqual(true);

  // Check socket path matches the env var
  expect(plan.envVars["NAS_HOSTEXEC_SOCKET"]).toEqual(
    plan.outputOverrides.hostexecBrokerSocket!,
  );
});

test("HostExecStage plan: creates symlink effects for bare command argv0s", () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  // "git" is a bare command argv0 — should have a symlink effect
  const symlinkEffects = plan.effects.filter(
    (e): e is SymlinkEffect => e.kind === "symlink",
  );
  expect(symlinkEffects.length).toEqual(1);
  expect(symlinkEffects[0].target).toEqual("hostexec-wrapper.py");
  expect(path.basename(symlinkEffects[0].path)).toEqual("git");
});

test("HostExecStage plan: creates unix-listener effect for hostexec-broker", () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  const listenerEffects = plan.effects.filter(
    (e): e is UnixListenerEffect => e.kind === "unix-listener",
  );
  expect(listenerEffects.length).toEqual(1);
  expect(listenerEffects[0].id).toEqual("hostexec-broker");
  expect(listenerEffects[0].spec.kind).toEqual("hostexec-broker");
  if (listenerEffects[0].spec.kind === "hostexec-broker") {
    expect(listenerEffects[0].spec.sessionId).toEqual("test-session-id");
    expect(listenerEffects[0].spec.auditDir).toEqual("/tmp/nas-test-audit");
  }
});

test("HostExecStage plan: creates file-write effect for wrapper script", () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  const fileWriteEffects = plan.effects.filter(
    (e) => e.kind === "file-write",
  );
  expect(fileWriteEffects.length).toEqual(1);
  expect(fileWriteEffects[0].kind).toEqual("file-write");
  if (fileWriteEffects[0].kind === "file-write") {
    expect(
      fileWriteEffects[0].content.includes("select.select([fd], [], [], 0)"),
    ).toEqual(true);
    expect(fileWriteEffects[0].content.includes('"argv0": argv0,')).toEqual(
      true,
    );
    expect(fileWriteEffects[0].content.includes(
      "relative argv0 fallback is not supported",
    )).toEqual(true);
    expect(fileWriteEffects[0].content.includes(
      "(not os.path.isabs(argv0)) and (os.path.sep in argv0)",
    )).toEqual(true);
  }
});

test("HostExecStage plan: mounts relative argv0 wrapper target", () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [{
    id: "gradlew",
    match: { argv0: "./gradlew" },
    cwd: { mode: "workspace-only", allow: [] },
    env: {},
    inheritEnv: { mode: "minimal", keys: [] },
    approval: "allow",
    fallback: "container",
  }];
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const workspace = "/workspace";
  const input = makeStageInput(profile, hostEnv, workspace);
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  // Relative argv0 should produce a docker mount for the wrapper script
  expect(
    plan.dockerArgs.some((arg) =>
      arg.endsWith(`:${path.join(workspace, "gradlew")}:ro`)
    ),
  ).toEqual(true);
});

test("HostExecStage plan: mounts absolute argv0 wrapper at exact container path", () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [{
    id: "usr-bin-git",
    match: { argv0: "/usr/bin/git" },
    cwd: { mode: "workspace-only", allow: [] },
    env: {},
    inheritEnv: { mode: "minimal", keys: [] },
    approval: "allow",
    fallback: "deny",
  }];
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  // Absolute argv0 should produce a docker mount at that exact path in the container
  expect(plan.dockerArgs.some((arg) => arg.endsWith(":/usr/bin/git:ro")))
    .toEqual(true);
});

test("HostExecStage plan: auto notify resolves to desktop", () => {
  const profile = makeProfile();
  profile.hostexec!.prompt.notify = "auto";
  const input = makeStageInput(profile, makeHostEnv("/tmp/nas-test-runtime"));
  const stage = createHostExecStage();
  const plan = stage.plan(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  const listenerEffects = plan.effects.filter(
    (e): e is UnixListenerEffect => e.kind === "unix-listener",
  );
  expect(listenerEffects.length).toEqual(1);
  if (listenerEffects[0].spec.kind === "hostexec-broker") {
    expect(listenerEffects[0].spec.notify).toEqual("desktop");
  }
});
