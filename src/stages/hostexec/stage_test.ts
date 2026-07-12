import { expect, test } from "bun:test";
import * as path from "node:path";
import { Effect, Exit, Scope } from "effect";
import type { Config, Profile } from "../../config/types.ts";
import {
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../../config/types.ts";
import { INTERCEPT_LIB_CONTAINER_PATH } from "../../hostexec/intercept_path.ts";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { PipelineState } from "../../pipeline/state.ts";
import type { HostEnv, StageInput } from "../../pipeline/types.ts";
import { makeHostExecBrokerServiceFake } from "./broker_service.ts";
import {
  type HostExecWorkspacePlan,
  makeHostExecSetupServiceFake,
} from "./setup_service.ts";
import {
  createHostExecStage,
  planHostExec,
  validateAbsoluteArgv0,
} from "./stage.ts";

function makeProfile(): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    display: DEFAULT_DISPLAY_CONFIG,
    session: DEFAULT_SESSION_CONFIG,
    network: {
      reviewRules: [],
      credentials: [],
      proxy: { forwardPorts: [] },
      pendingTimeoutSeconds: 300,
      pendingDefaultScope: "host-port",
      pendingNotify: "off",
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

function makeSharedInput(profile: Profile, hostEnv: HostEnv): StageInput {
  const config: Config = {
    profiles: { default: profile },
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
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
      auditDir: "/tmp/nas-test-audit",
    },
  };
}

function makeStageState(
  overrides: Partial<Pick<PipelineState, "workspace" | "container">> = {},
): Pick<PipelineState, "workspace" | "container"> {
  const workspace = overrides.workspace ?? {
    workDir: "/workspace",
    imageName: "nas-test",
  };
  const container = overrides.container ?? {
    ...emptyContainerPlan(workspace.imageName, workspace.workDir),
    env: {
      static: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      dynamicOps: [],
    },
    command: { agentCommand: ["claude"], extraArgs: [] },
  };
  return { workspace, container };
}

// ============================================================
// planHostExec tests
// ============================================================

test("HostExecStage plan: returns a plan with __nas_hook even when user rules are empty", async () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [];
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const input = { ...makeSharedInput(profile, hostEnv), ...makeStageState() };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/intercept.so",
  });
  expect(plan).not.toBeNull();
  // The internal __nas_hook rule creates a "nas" symlink
  expect(plan!.symlinks.some((s) => path.basename(s.path) === "nas")).toEqual(
    true,
  );
});

test("HostExecStage plan: produces correct docker args and env vars", async () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = { ...makeSharedInput(profile, hostEnv), ...makeStageState() };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/intercept.so",
  });

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

  expect(plan.outputOverrides.hostexec?.brokerSocket !== undefined).toEqual(
    true,
  );
  expect(plan.outputOverrides.hostexec?.runtimeDir !== undefined).toEqual(true);
  expect(
    plan.outputOverrides.hostexec?.sessionTmpDir?.includes("test-session-id"),
  ).toEqual(true);

  // The container-facing socket (NAS_HOSTEXEC_SOCKET) is the exec socket; the
  // host-facing registry socket (brokerSocket) is the control socket. They
  // must differ so a hostile container cannot reach the control channel.
  const execSocket = plan.envVars.NAS_HOSTEXEC_SOCKET;
  const controlSocket = plan.outputOverrides.hostexec!.brokerSocket;
  expect(execSocket).toBeDefined();
  expect(controlSocket).toBeDefined();
  expect(execSocket).not.toEqual(controlSocket);
  expect(execSocket.includes("/exec/")).toEqual(true);
  expect(controlSocket.includes("/exec/")).toEqual(false);
});

test("HostExecStage plan: creates symlinks for bare command argv0s", async () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = { ...makeSharedInput(profile, hostEnv), ...makeStageState() };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/intercept.so",
  });

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

test("HostExecStage plan: creates file entry for wrapper script", async () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = { ...makeSharedInput(profile, hostEnv), ...makeStageState() };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/intercept.so",
  });

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

test("HostExecStage plan: broker spec contains correct fields", async () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = { ...makeSharedInput(profile, hostEnv), ...makeStageState() };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/intercept.so",
  });

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(plan.broker.sessionId).toEqual("test-session-id");
  expect(plan.broker.auditDir).toEqual("/tmp/nas-test-audit");
  expect(plan.broker.notify).toEqual("off");
  // The broker spec carries the split socket paths: exec (container-facing,
  // under exec/) and control (host-facing, the session broker dir's sock).
  expect(plan.broker.execSocketPath.includes("/exec/")).toEqual(true);
  expect(plan.broker.controlSocketPath.includes("/exec/")).toEqual(false);
  expect(plan.broker.execSocketPath).not.toEqual(plan.broker.controlSocketPath);
});

test("HostExecStage plan: mounts only the exec socket dir, never the control socket dir", async () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = { ...makeSharedInput(profile, hostEnv), ...makeStageState() };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/intercept.so",
  });

  expect(plan).not.toEqual(null);
  if (!plan) return;

  const execSocketDir = path.dirname(plan.broker.execSocketPath);
  const controlSocketDir = path.dirname(plan.broker.controlSocketPath);

  // The exec socket dir (exec/) is mounted into the container so the wrapper
  // can reach the exec channel.
  expect(plan.mounts.some((m) => m.source === execSocketDir)).toEqual(true);

  // The control socket and its enclosing session broker dir must never be
  // mounted into the container: that would re-enable self-approval.
  for (const m of plan.mounts) {
    expect(m.source).not.toEqual(plan.broker.controlSocketPath);
    expect(m.source).not.toEqual(controlSocketDir);
    expect(m.target).not.toEqual(plan.broker.controlSocketPath);
    expect(m.target).not.toEqual(controlSocketDir);
  }
  for (const arg of plan.dockerArgs) {
    expect(arg.includes(plan.broker.controlSocketPath)).toEqual(false);
  }

  // The exec socket dir is provisioned with 0o700 in the directories plan.
  const execDirEntry = plan.directories.find((d) => d.path === execSocketDir);
  expect(execDirEntry).toBeDefined();
  expect(execDirEntry!.mode).toEqual(0o700);
});

test("HostExecStage plan: sets LD_PRELOAD for relative argv0 intercept", async () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "gradlew",
      match: { argv0: "./gradlew" },
      cwd: { mode: "workspace-only", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
    },
  ];
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const workspace = "/workspace";
  const input = {
    ...makeSharedInput(profile, hostEnv),
    ...makeStageState({
      workspace: { workDir: workspace, imageName: "nas-test" },
    }),
  };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/path/to/intercept.so",
  });

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(plan.envVars.LD_PRELOAD).toEqual(INTERCEPT_LIB_CONTAINER_PATH);
  expect(plan.envVars.NAS_HOSTEXEC_INTERCEPT_PATHS).toEqual(
    path.join(workspace, "gradlew"),
  );
  expect(
    plan.dockerArgs.some((arg) => arg.includes(INTERCEPT_LIB_CONTAINER_PATH)),
  ).toEqual(true);
});

test("HostExecStage plan: uses workspace slice for LD_PRELOAD intercept and broker root", async () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "gradlew",
      match: { argv0: "./gradlew" },
      cwd: { mode: "workspace-only", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
    },
  ];
  const input = {
    ...makeSharedInput(profile, makeHostEnv("/tmp/nas-test-runtime")),
    ...makeStageState({
      workspace: {
        workDir: "/slice-workspace",
        mountDir: "/slice-root",
        imageName: "slice-image",
      },
    }),
  };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/path/to/intercept.so",
  });

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(plan.envVars.LD_PRELOAD).toEqual(INTERCEPT_LIB_CONTAINER_PATH);
  expect(plan.envVars.NAS_HOSTEXEC_INTERCEPT_PATHS).toEqual(
    path.join("/slice-workspace", "gradlew"),
  );
  expect(plan.broker.workspaceRoot).toEqual("/slice-root");
});

test("HostExecStage plan: sets LD_PRELOAD for absolute argv0 intercept", async () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "usr-bin-git",
      match: { argv0: "/usr/bin/git" },
      cwd: { mode: "workspace-only", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
    },
  ];
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = { ...makeSharedInput(profile, hostEnv), ...makeStageState() };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/path/to/intercept.so",
  });

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(plan.envVars.LD_PRELOAD).toEqual(INTERCEPT_LIB_CONTAINER_PATH);
  expect(plan.envVars.NAS_HOSTEXEC_INTERCEPT_PATHS).toEqual("/usr/bin/git");
  expect(
    plan.dockerArgs.some((arg) => arg.includes(INTERCEPT_LIB_CONTAINER_PATH)),
  ).toEqual(true);
});

test("HostExecStage plan: auto notify resolves to desktop", async () => {
  const profile = makeProfile();
  profile.hostexec!.prompt.notify = "auto";
  const input = {
    ...makeSharedInput(profile, makeHostEnv("/tmp/nas-test-runtime")),
    ...makeStageState(),
  };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/intercept.so",
  });

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(plan.broker.notify).toEqual("desktop");
});

test("HostExecStage plan: falls back to bind mount when interceptLibPath is null", async () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "gradlew",
      match: { argv0: "./gradlew" },
      cwd: { mode: "workspace-only", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
    },
  ];
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const workspace = "/workspace";
  const input = {
    ...makeSharedInput(profile, hostEnv),
    ...makeStageState({
      workspace: { workDir: workspace, imageName: "nas-test" },
    }),
  };
  const plan = await planHostExec(input, { interceptLibPath: null });

  expect(plan).not.toEqual(null);
  if (!plan) return;

  // LD_PRELOAD should NOT be set in fallback mode
  expect(plan.envVars.LD_PRELOAD).toBeUndefined();
  expect(plan.envVars.NAS_HOSTEXEC_INTERCEPT_PATHS).toBeUndefined();

  // Traditional bind mount should be present
  expect(
    plan.dockerArgs.some((arg) =>
      arg.endsWith(`:${path.join(workspace, "gradlew")}:ro`),
    ),
  ).toEqual(true);
});

test("HostExecStage plan: LD_PRELOAD value has no spurious colons when set", async () => {
  // The colon-concatenation logic in planHostExec is defensive:
  // currently envVars is freshly constructed so existingLdPreload is always
  // undefined, but the code path is ready if a future change seeds LD_PRELOAD.
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "gradlew",
      match: { argv0: "./gradlew" },
      cwd: { mode: "workspace-only", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
    },
  ];
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const workspace = "/workspace";
  const input = {
    ...makeSharedInput(profile, hostEnv),
    ...makeStageState({
      workspace: { workDir: workspace, imageName: "nas-test" },
    }),
  };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/path/to/intercept.so",
  });

  expect(plan).not.toEqual(null);
  if (!plan) return;

  // LD_PRELOAD should be exactly the intercept lib path (no spurious colons)
  expect(plan.envVars.LD_PRELOAD).toEqual(INTERCEPT_LIB_CONTAINER_PATH);
  expect(plan.envVars.LD_PRELOAD).not.toContain(":");
});

test("HostExecStage plan: mixed relative and absolute argv0s produce multi-line intercept paths", async () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "hello",
      match: { argv0: "./hello.bash" },
      cwd: { mode: "workspace-only", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
    },
    {
      id: "tool",
      match: { argv0: "/usr/local/bin/tool" },
      cwd: { mode: "any", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
    },
  ];
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const workspace = "/workspace";
  const input = {
    ...makeSharedInput(profile, hostEnv),
    ...makeStageState({
      workspace: { workDir: workspace, imageName: "nas-test" },
    }),
  };
  const plan = await planHostExec(input, {
    interceptLibPath: "/fake/path/to/intercept.so",
  });

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(plan.envVars.LD_PRELOAD).toEqual(INTERCEPT_LIB_CONTAINER_PATH);

  // NAS_HOSTEXEC_INTERCEPT_PATHS should contain both entries separated by newline
  const interceptPaths = plan.envVars.NAS_HOSTEXEC_INTERCEPT_PATHS.split("\n");
  expect(interceptPaths).toEqual([
    path.join(workspace, "hello.bash"),
    "/usr/local/bin/tool",
  ]);

  // Only one .so mount, not per-target bind mounts
  const soMounts = plan.dockerArgs.filter((arg) =>
    arg.includes(INTERCEPT_LIB_CONTAINER_PATH),
  );
  expect(soMounts.length).toEqual(1);
});

// ============================================================
// planHostExec: mask filter intent (pure planning only; the planner must
// not touch disk or resolve the filter binary -- see runHostExec tests
// below for the I/O-resolving half of this behavior)
// ============================================================

test("HostExecStage plan: sets maskFilterIntent when mask.filter enabled and values non-empty", async () => {
  const profile = makeProfile();
  profile.mask = {
    values: [{ source: "env:TEST_SECRET" }],
    writePolicy: "readonly",
    maskfs: false,
    proxy: false,
    filter: true,
  };
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const hostEnvWithSecret: HostEnv = {
    ...hostEnv,
    env: new Map([...hostEnv.env, ["TEST_SECRET", "supersecretvalue"]]),
  };
  const input = {
    ...makeSharedInput(profile, hostEnvWithSecret),
    ...makeStageState(),
  };
  const plan = await planHostExec(input, { interceptLibPath: null });

  expect(plan).not.toBeNull();
  if (!plan) return;

  expect(plan.maskFilterIntent).toBeDefined();

  // The secrets frame path must match the one MaskFilterStage computes (see
  // mask_filter_stage.ts): HostExecStage reuses that file instead of
  // resolving the same secrets a second time, so it must never live in the
  // session tmp dir that gets mounted into the container.
  const expectedFramePath = `${resolveRuntimeSubdir(hostEnvWithSecret, "mask-filter")}/${input.sessionId}/mask-secrets`;
  expect(plan.maskFilterIntent!.secretsFramePath).toEqual(expectedFramePath);
  expect(plan.maskFilterIntent!.secretsFramePath).not.toContain(
    plan.broker.sessionTmpDir,
  );

  // Pure planning: no I/O, so the file must not exist on disk yet.
  const exists = await Bun.file(
    plan.maskFilterIntent!.secretsFramePath,
  ).exists();
  expect(exists).toEqual(false);
});

test("HostExecStage plan: omits maskFilterIntent when mask.filter disabled", async () => {
  const profile = makeProfile();
  profile.mask = {
    values: [{ source: "env:TEST_SECRET" }],
    writePolicy: "readonly",
    maskfs: false,
    proxy: false,
    filter: false,
  };
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const hostEnvWithSecret: HostEnv = {
    ...hostEnv,
    env: new Map([...hostEnv.env, ["TEST_SECRET", "supersecretvalue"]]),
  };
  const input = {
    ...makeSharedInput(profile, hostEnvWithSecret),
    ...makeStageState(),
  };
  const plan = await planHostExec(input, { interceptLibPath: null });

  expect(plan).not.toBeNull();
  if (!plan) return;
  expect(plan.maskFilterIntent).toBeUndefined();
});

test("HostExecStage plan: omits maskFilterIntent when mask config is absent", async () => {
  const profile = makeProfile();
  profile.mask = undefined;
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = {
    ...makeSharedInput(profile, hostEnv),
    ...makeStageState(),
  };
  const plan = await planHostExec(input, { interceptLibPath: null });

  expect(plan).not.toBeNull();
  if (!plan) return;
  expect(plan.maskFilterIntent).toBeUndefined();
});

test("HostExecStage plan: omits maskFilterIntent when mask.values is empty", async () => {
  const profile = makeProfile();
  profile.mask = {
    values: [],
    writePolicy: "readonly",
    maskfs: false,
    proxy: false,
    filter: true,
  };
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = {
    ...makeSharedInput(profile, hostEnv),
    ...makeStageState(),
  };
  const plan = await planHostExec(input, { interceptLibPath: null });

  expect(plan).not.toBeNull();
  if (!plan) return;
  expect(plan.maskFilterIntent).toBeUndefined();
});

// ============================================================
// runHostExec: mask filter resolution (I/O half of mask filtering)
// ============================================================

test("HostExecStage: run fails closed when mask.filter is enabled but the filter binary is not found", async () => {
  const profile = makeProfile();
  profile.mask = {
    values: [{ source: "env:TEST_SECRET" }],
    writePolicy: "readonly",
    maskfs: false,
    proxy: false,
    filter: true,
  };
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const hostEnvWithSecret: HostEnv = {
    ...hostEnv,
    env: new Map([...hostEnv.env, ["TEST_SECRET", "supersecretvalue"]]),
  };
  const sharedInput = makeSharedInput(profile, hostEnvWithSecret);
  const stageState = makeStageState();
  // Inject a resolver that always reports the binary as missing, so this
  // test exercises the fail-closed path deterministically regardless of
  // whether `zig build` has produced the binary on the host running tests.
  const stage = createHostExecStage(sharedInput, {
    resolveMaskFilterBinPath: async () => null,
  });

  const setupLayer = makeHostExecSetupServiceFake();
  const brokerLayer = makeHostExecBrokerServiceFake();
  const scope = Effect.runSync(Scope.make());

  const exit = await Effect.runPromiseExit(
    stage
      .run(stageState)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(setupLayer),
        Effect.provide(brokerLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(Exit.isFailure(exit)).toEqual(true);
  if (Exit.isFailure(exit)) {
    const message = String(exit.cause);
    expect(message).toContain("nas-mask-filter binary not found");
  }
});

// ============================================================
// validateAbsoluteArgv0 tests
// ============================================================

test("validateAbsoluteArgv0: accepts allowed prefixes", () => {
  for (const argv0 of [
    "/usr/bin/git",
    "/usr/local/bin/mytool",
    "/opt/android-sdk/bin/adb",
    "/opt/jdk-21/bin/java",
    "/home/testuser/.local/bin/foo",
  ]) {
    expect(() => validateAbsoluteArgv0("r", argv0)).not.toThrow();
  }
});

test("validateAbsoluteArgv0: rejects sensitive container paths", () => {
  for (const argv0 of [
    "/etc/passwd",
    "/etc/cron.d/evil",
    "/bin/sh",
    "/sbin/init",
    "/lib/x.so",
    "/lib64/x.so",
    "/usr/lib/x.so",
    "/usr/sbin/sshd",
    "/boot/vmlinuz",
    "/dev/null",
    "/proc/self/mem",
    "/sys/kernel/x",
    "/root/.ssh/authorized_keys",
    "/var/log/x",
    "/run/docker.sock",
  ]) {
    expect(() => validateAbsoluteArgv0("bad-rule", argv0)).toThrow(/bad-rule/);
  }
});

test("validateAbsoluteArgv0: rejects '/', trailing slash, '..', and '.' segments", () => {
  expect(() => validateAbsoluteArgv0("r", "/")).toThrow();
  expect(() => validateAbsoluteArgv0("r", "/usr/bin/")).toThrow();
  expect(() => validateAbsoluteArgv0("r", "/usr/bin/../../etc/passwd")).toThrow(
    /\.\./,
  );
  expect(() => validateAbsoluteArgv0("r", "/usr/bin/./git")).toThrow(/'\.'/);
});

test("validateAbsoluteArgv0: rejects partial prefix matches like /usr/bin (no trailing file)", () => {
  expect(() => validateAbsoluteArgv0("r", "/usr/bin")).toThrow();
  // /opt/foo without /bin/<file> should be rejected
  expect(() => validateAbsoluteArgv0("r", "/opt/foo/lib/x")).toThrow();
  // /opt/bin/x is not /opt/*/bin/x (missing product segment)
  expect(() => validateAbsoluteArgv0("r", "/opt/bin/x")).toThrow();
});

test("HostExecStage plan: rejects rule whose absolute argv0 targets a sensitive path", async () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "evil",
      match: { argv0: "/etc/passwd" },
      cwd: { mode: "any", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
    },
  ];
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const input = { ...makeSharedInput(profile, hostEnv), ...makeStageState() };
  await expect(
    planHostExec(input, { interceptLibPath: "/fake/intercept.so" }),
  ).rejects.toThrow(/evil.*\/etc\/passwd/);
});

// ============================================================
// EffectStage run() tests
// ============================================================

test("HostExecStage: run still starts broker when user rules are empty (internal __nas_hook)", async () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [];
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const sharedInput = makeSharedInput(profile, hostEnv);
  const stageState = makeStageState();
  const stage = createHostExecStage(sharedInput);

  const setupLayer = makeHostExecSetupServiceFake();
  const brokerLayer = makeHostExecBrokerServiceFake();
  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run(stageState)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(setupLayer),
        Effect.provide(brokerLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(result.container?.mounts.length).toBeGreaterThan(0);
});

test("HostExecStage: run delegates directories, files, and symlinks to HostExecSetupService", async () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const sharedInput = makeSharedInput(profile, hostEnv);
  const stageState = makeStageState();
  const input = { ...sharedInput, ...stageState };
  const plan = (await planHostExec(input, {
    interceptLibPath: "/fake/intercept.so",
  }))!;

  let capturedPlan: HostExecWorkspacePlan | null = null;
  const setupLayer = makeHostExecSetupServiceFake({
    prepareWorkspace: (p) =>
      Effect.sync(() => {
        capturedPlan = p;
      }),
  });
  const brokerLayer = makeHostExecBrokerServiceFake();

  const stage = createHostExecStage(sharedInput);
  const scope = Effect.runSync(Scope.make());

  await Effect.runPromiseExit(
    stage
      .run(stageState)
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
  const sharedInput = makeSharedInput(
    profile,
    makeHostEnv("/tmp/nas-test-runtime"),
  );
  const stageState = makeStageState({
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
  });

  const stage = createHostExecStage(sharedInput);
  const setupLayer = makeHostExecSetupServiceFake();
  const brokerLayer = makeHostExecBrokerServiceFake();
  const scope = Effect.runSync(Scope.make());

  const result = await Effect.runPromise(
    stage
      .run(stageState)
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
      "/tmp/nas-test-runtime/nas/hostexec/brokers/test-session-id/sock",
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
      "/tmp/nas-test-runtime/nas/hostexec/brokers/test-session-id/exec/sock",
    NAS_HOSTEXEC_WRAPPER_DIR: "/opt/nas/hostexec/bin",
    NAS_HOSTEXEC_SESSION_ID: "test-session-id",
    NAS_HOSTEXEC_SESSION_TMP: "/tmp/nas-hostexec/test-session-id",
  });
  expect(result.container?.extraRunArgs).toEqual(["--shm-size", "2g"]);
  expect(result.container?.command).toEqual({
    agentCommand: ["copilot"],
    extraArgs: ["--safe"],
  });
  expect(result.container?.extraRunArgs).toEqual(["--shm-size", "2g"]);
});
