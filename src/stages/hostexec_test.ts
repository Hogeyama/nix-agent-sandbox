import { expect, test } from "bun:test";
import * as path from "node:path";
import { Effect, Exit, Scope } from "effect";
import type { Config, Profile } from "../config/types.ts";
import {
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import { emptyContainerPlan } from "../pipeline/container_plan.ts";
import type { HostEnv, StageInput } from "../pipeline/types.ts";
import { makeHostExecBrokerServiceFake } from "../services/hostexec_broker.ts";
import {
  type HostExecWorkspacePlan,
  makeHostExecSetupServiceFake,
} from "../services/hostexec_setup.ts";
import { createHostExecStage, planHostExec } from "./hostexec.ts";

function makeProfile(): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
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
    hook: DEFAULT_HOOK_CONFIG,
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
      rules: [
        {
          id: "git-readonly",
          match: { argv0: "git", argRegex: "^pull\\b" },
          cwd: { mode: "workspace-or-session-tmp", allow: [] },
          env: { GITHUB_TOKEN: "secret:token" },
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
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
  priorOverrides: Partial<StageInput["prior"]> = {},
): StageInput {
  const config: Config = {
    profiles: { default: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  const prior: StageInput["prior"] = {
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
    ...priorOverrides,
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

// ============================================================
// planHostExec tests
// ============================================================

test("HostExecStage plan: returns a plan with __nas_hook even when user rules are empty", () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [];
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const input = makeStageInput(profile, hostEnv);
  const plan = planHostExec(input);
  expect(plan).not.toBeNull();
  // The internal __nas_hook rule creates a "nas" symlink
  expect(plan!.symlinks.some((s) => path.basename(s.path) === "nas")).toEqual(
    true,
  );
});

test("HostExecStage plan: produces correct docker args and env vars", () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const plan = planHostExec(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(
    plan.dockerArgs.some((arg) => arg.includes("/opt/nas/hostexec/bin")),
  ).toEqual(true);

  expect(plan.envVars.PATH).toBeUndefined();
  expect(plan.envVars.NAS_HOSTEXEC_WRAPPER_DIR).toEqual(
    "/opt/nas/hostexec/bin",
  );

  expect(plan.envVars.NAS_HOSTEXEC_SOCKET !== undefined).toEqual(true);
  expect(plan.envVars.NAS_HOSTEXEC_SESSION_ID).toEqual("test-session-id");

  expect(plan.outputOverrides.hostexecBrokerSocket !== undefined).toEqual(true);
  expect(plan.outputOverrides.hostexecRuntimeDir !== undefined).toEqual(true);
  expect(
    (plan.outputOverrides.hostexecSessionTmpDir as string)?.includes(
      "test-session-id",
    ),
  ).toEqual(true);

  expect(plan.envVars.NAS_HOSTEXEC_SOCKET).toEqual(
    plan.outputOverrides.hostexecBrokerSocket!,
  );
});

test("HostExecStage plan: creates symlinks for bare command argv0s", () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const plan = planHostExec(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  // User rule "git" + internal rule "nas"
  expect(plan.symlinks.length).toEqual(2);
  const names = plan.symlinks.map((s) => path.basename(s.path)).sort();
  expect(names).toEqual(["git", "nas"]);
  for (const s of plan.symlinks) {
    expect(s.target).toEqual("hostexec-wrapper.py");
  }
});

test("HostExecStage plan: creates file entry for wrapper script", () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const plan = planHostExec(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(plan.files.length).toEqual(1);
  expect(
    plan.files[0].content.includes("select.select([fd], [], [], 0)"),
  ).toEqual(true);
  expect(plan.files[0].content.includes('"argv0": argv0,')).toEqual(true);
  expect(
    plan.files[0].content.includes("relative argv0 fallback is not supported"),
  ).toEqual(true);
  expect(
    plan.files[0].content.includes(
      "(not os.path.isabs(argv0)) and (os.path.sep in argv0)",
    ),
  ).toEqual(true);
});

test("HostExecStage plan: broker spec contains correct fields", () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const plan = planHostExec(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(plan.broker.sessionId).toEqual("test-session-id");
  expect(plan.broker.auditDir).toEqual("/tmp/nas-test-audit");
  expect(plan.broker.notify).toEqual("off");
});

test("HostExecStage plan: mounts relative argv0 wrapper target", () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "gradlew",
      match: { argv0: "./gradlew" },
      cwd: { mode: "workspace-only", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
      fallback: "container",
    },
  ];
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const workspace = "/workspace";
  const input = makeStageInput(profile, hostEnv, workspace);
  const plan = planHostExec(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(
    plan.dockerArgs.some((arg) =>
      arg.endsWith(`:${path.join(workspace, "gradlew")}:ro`),
    ),
  ).toEqual(true);
});

test("HostExecStage plan: prefers workspace slice for relative mounts and broker root", () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "gradlew",
      match: { argv0: "./gradlew" },
      cwd: { mode: "workspace-only", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
      fallback: "container",
    },
  ];
  const input = makeStageInput(
    profile,
    makeHostEnv("/tmp/nas-test-runtime"),
    "/legacy-workspace",
    {
      mountDir: "/legacy-root",
      workspace: {
        workDir: "/slice-workspace",
        mountDir: "/slice-root",
        imageName: "slice-image",
      },
    },
  );
  const plan = planHostExec(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(
    plan.dockerArgs.some((arg) =>
      arg.endsWith(`:${path.join("/slice-workspace", "gradlew")}:ro`),
    ),
  ).toEqual(true);
  expect(
    plan.dockerArgs.some((arg) =>
      arg.endsWith(`:${path.join("/legacy-workspace", "gradlew")}:ro`),
    ),
  ).toEqual(false);
  expect(plan.broker.workspaceRoot).toEqual("/slice-root");
});

test("HostExecStage plan: mounts absolute argv0 wrapper at exact container path", () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "usr-bin-git",
      match: { argv0: "/usr/bin/git" },
      cwd: { mode: "workspace-only", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
      fallback: "deny",
    },
  ];
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const plan = planHostExec(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(
    plan.dockerArgs.some((arg) => arg.endsWith(":/usr/bin/git:ro")),
  ).toEqual(true);
});

test("HostExecStage plan: auto notify resolves to desktop", () => {
  const profile = makeProfile();
  profile.hostexec!.prompt.notify = "auto";
  const input = makeStageInput(profile, makeHostEnv("/tmp/nas-test-runtime"));
  const plan = planHostExec(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(plan.broker.notify).toEqual("desktop");
});

// ============================================================
// EffectStage run() tests
// ============================================================

test("HostExecStage: run still starts broker when user rules are empty (internal __nas_hook)", async () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [];
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const input = makeStageInput(profile, hostEnv);
  const stage = createHostExecStage();

  const setupLayer = makeHostExecSetupServiceFake();
  const brokerLayer = makeHostExecBrokerServiceFake();
  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run(input)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(setupLayer),
        Effect.provide(brokerLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  // Internal __nas_hook rule causes the stage to produce docker args
  expect(result.dockerArgs?.length).toBeGreaterThan(0);
});

test("HostExecStage: run delegates directories, files, and symlinks to HostExecSetupService", async () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = makeStageInput(profile, hostEnv);
  const plan = planHostExec(input)!;

  let capturedPlan: HostExecWorkspacePlan | null = null;
  const setupLayer = makeHostExecSetupServiceFake({
    prepareWorkspace: (p) =>
      Effect.sync(() => {
        capturedPlan = p;
      }),
  });
  const brokerLayer = makeHostExecBrokerServiceFake();

  const stage = createHostExecStage();
  const scope = Effect.runSync(Scope.make());

  await Effect.runPromiseExit(
    stage
      .run(input)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(setupLayer),
        Effect.provide(brokerLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(capturedPlan).not.toBeNull();
  expect(capturedPlan!.directories).toEqual(plan.directories);
  expect(capturedPlan!.files).toEqual(plan.files);
  expect(capturedPlan!.symlinks).toEqual(plan.symlinks);
});

test("HostExecStage: run merges hostexec mounts and env into container and hostexec slices", async () => {
  const profile = makeProfile();
  const input = makeStageInput(
    profile,
    makeHostEnv("/tmp/nas-test-runtime"),
    "/legacy-workspace",
    {
      workspace: {
        workDir: "/slice-workspace",
        mountDir: "/slice-root",
        imageName: "slice-image",
      },
      container: {
        ...emptyContainerPlan("slice-image", "/slice-workspace"),
        mounts: [{ source: "/existing-src", target: "/existing-target" }],
        env: { static: { EXISTING_ENV: "1" }, dynamicOps: [] },
        extraRunArgs: ["--shm-size", "2g"],
        command: { agentCommand: ["copilot"], extraArgs: ["--safe"] },
        labels: { "nas.managed": "true" },
      },
    },
  );

  const stage = createHostExecStage();
  const setupLayer = makeHostExecSetupServiceFake();
  const brokerLayer = makeHostExecBrokerServiceFake();
  const scope = Effect.runSync(Scope.make());

  const result = await Effect.runPromise(
    stage
      .run(input)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(setupLayer),
        Effect.provide(brokerLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(result.hostexec).toEqual({
    runtimeDir: "/tmp/nas-test-runtime/nas/hostexec",
    brokerSocket:
      "/tmp/nas-test-runtime/nas/hostexec/brokers/test-session-id.sock",
    sessionTmpDir: "/tmp/nas-hostexec/test-session-id",
  });
  expect(result.container?.mounts).toEqual(
    expect.arrayContaining([
      { source: "/existing-src", target: "/existing-target" },
      {
        source:
          "/tmp/nas-test-runtime/nas/hostexec/wrappers/test-session-id/bin",
        target: "/opt/nas/hostexec/bin",
        readOnly: true,
      },
    ]),
  );
  expect(result.container?.env.static).toEqual({
    EXISTING_ENV: "1",
    NAS_HOSTEXEC_SOCKET:
      "/tmp/nas-test-runtime/nas/hostexec/brokers/test-session-id.sock",
    NAS_HOSTEXEC_WRAPPER_DIR: "/opt/nas/hostexec/bin",
    NAS_HOSTEXEC_SESSION_ID: "test-session-id",
    NAS_HOSTEXEC_SESSION_TMP: "/tmp/nas-hostexec/test-session-id",
  });
  expect(result.container?.extraRunArgs).toEqual(["--shm-size", "2g"]);
  expect(result.container?.command).toEqual({
    agentCommand: ["copilot"],
    extraArgs: ["--safe"],
  });
  expect(result.dockerArgs).toEqual(
    expect.arrayContaining([
      "-w",
      "/slice-workspace",
      "--shm-size",
      "2g",
      "/existing-src:/existing-target",
      "/tmp/nas-test-runtime/nas/hostexec/wrappers/test-session-id/bin:/opt/nas/hostexec/bin:ro",
    ]),
  );
  expect(result.envVars).toEqual({
    EXISTING_ENV: "1",
    NAS_HOSTEXEC_SOCKET:
      "/tmp/nas-test-runtime/nas/hostexec/brokers/test-session-id.sock",
    NAS_HOSTEXEC_WRAPPER_DIR: "/opt/nas/hostexec/bin",
    NAS_HOSTEXEC_SESSION_ID: "test-session-id",
    NAS_HOSTEXEC_SESSION_TMP: "/tmp/nas-hostexec/test-session-id",
  });
});
