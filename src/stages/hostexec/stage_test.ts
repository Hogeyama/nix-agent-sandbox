import { expect, test } from "bun:test";
import * as path from "node:path";
import { Cause, Effect, Exit, Option, Scope } from "effect";
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
import {
  HostExecTeardownError,
  makeHostExecBrokerServiceFake,
} from "./broker_service.ts";
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
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
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

function makeSharedInput(
  profile: Profile,
  hostEnv: HostEnv,
  probeOverrides: Partial<StageInput["probes"]> = {},
): StageInput {
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
      gpgAgentSocket: null,
      auditDir: "/tmp/nas-test-audit",
      // Both clients present by default: the interesting cases are the two
      // tests that take one away.
      hostexecInterceptLibPath: "/fake/intercept.so",
      hostexecClientPath: "/fake/nas-hostexec-client",
      hostexecGatewayPath: "/fake/nas-hostexec-gateway",
      ...probeOverrides,
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
  const plan = await planHostExec(input);
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
  const plan = await planHostExec(input);

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
  const plan = await planHostExec(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  // User rule "git" + internal rule "nas"
  expect(plan.symlinks.length).toEqual(2);
  const names = plan.symlinks.map((s) => path.basename(s.path)).sort();
  expect(names).toEqual(["git", "nas"]);
  // Every wrapper symlink points at the standalone client, by its
  // *container* path: the link is only ever resolved from inside the
  // container, where the binary is bind-mounted there.
  for (const s of plan.symlinks) {
    expect(s.target).toEqual("/opt/nas/hostexec/libexec/nas-hostexec-client");
  }
});

test("HostExecStage plan: mounts the hostexec client for bare command rules", async () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = { ...makeSharedInput(profile, hostEnv), ...makeStageState() };
  const plan = await planHostExec(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  const mount = plan.mounts.find(
    (m) => m.target === "/opt/nas/hostexec/libexec/nas-hostexec-client",
  );
  expect(mount).toBeDefined();
  expect(mount!.source).toEqual("/fake/nas-hostexec-client");
  expect(mount!.readOnly).toEqual(true);
});

test("HostExecStage plan: rejects bare command rules when the client binary is missing", async () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = {
    ...makeSharedInput(profile, hostEnv, { hostexecClientPath: null }),
    ...makeStageState(),
  };

  // Without the client there is nothing for the wrapper symlinks to point at,
  // so the command would silently run in the container instead of on the host.
  expect(() => planHostExec(input)).toThrow(/nas-hostexec-client/);
});

test("HostExecStage plan: broker spec contains correct fields", async () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = { ...makeSharedInput(profile, hostEnv), ...makeStageState() };
  const plan = await planHostExec(input);

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
  expect(plan.broker.gatewayBinaryPath).toEqual("/fake/nas-hostexec-gateway");
  expect(plan.broker.internalSocketPath).toContain("/gateway.sock");
  expect(plan.broker.internalSocketPath).not.toEqual(
    plan.broker.execSocketPath,
  );
});

test("HostExecStage plan: mounts only the exec socket dir, never the control socket dir", async () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = { ...makeSharedInput(profile, hostEnv), ...makeStageState() };
  const plan = await planHostExec(input);

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
    expect(arg.includes(plan.broker.internalSocketPath)).toEqual(false);
  }
  for (const mount of plan.mounts) {
    expect(mount.source).not.toEqual(plan.broker.internalSocketPath);
    expect(mount.target).not.toEqual(plan.broker.internalSocketPath);
  }
  for (const value of Object.values(plan.envVars)) {
    expect(value).not.toContain(plan.broker.internalSocketPath);
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
      fallback: "container",
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
  const plan = await planHostExec(input);

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
      fallback: "container",
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
  const plan = await planHostExec(input);

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
      fallback: "deny",
    },
  ];
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const input = { ...makeSharedInput(profile, hostEnv), ...makeStageState() };
  const plan = await planHostExec(input);

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
  const plan = await planHostExec(input);

  expect(plan).not.toEqual(null);
  if (!plan) return;

  expect(plan.broker.notify).toEqual("desktop");
});

test("HostExecStage plan: throws when a relative/absolute rule has no intercept lib", async () => {
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
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const input = {
    ...makeSharedInput(profile, hostEnv, { hostexecInterceptLibPath: null }),
    ...makeStageState({
      workspace: { workDir: "/workspace", imageName: "nas-test" },
    }),
  };
  expect(() => planHostExec(input)).toThrow(/intercept/i);
});

test("HostExecStage plan: broker.integrityTargets lists resolved LD_PRELOAD argv0 paths", async () => {
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "abs",
      match: { argv0: "/home/user/.local/share/nas/tool.sh" },
      cwd: { mode: "any", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
      fallback: "deny",
    },
    {
      id: "rel",
      match: { argv0: "./gradlew" },
      cwd: { mode: "workspace-only", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
      fallback: "container",
    },
  ];
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const input = {
    ...makeSharedInput(profile, hostEnv),
    ...makeStageState({
      workspace: { workDir: "/workspace", imageName: "nas-test" },
    }),
  };
  const plan = await planHostExec(input);
  expect(plan).not.toBeNull();
  if (!plan) return;
  expect(plan.broker.integrityTargets).toContain(
    "/home/user/.local/share/nas/tool.sh",
  );
  expect(plan.broker.integrityTargets).toContain("/workspace/gradlew");
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
      fallback: "container",
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
  const plan = await planHostExec(input);

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
      fallback: "container",
    },
    {
      id: "tool",
      match: { argv0: "/usr/local/bin/tool" },
      cwd: { mode: "any", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
      fallback: "deny",
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
  const plan = await planHostExec(input);

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
  const plan = await planHostExec(input);

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
  const plan = await planHostExec(input);

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
  const plan = await planHostExec(input);

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
  const plan = await planHostExec(input);

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

test("validateAbsoluteArgv0: allows non-system absolute paths (allowlist removed)", () => {
  for (const argv0 of [
    "/etc/passwd",
    "/home/user/.local/share/nas/tool.sh",
    "/home/user/.claude/skills/x/scripts/diffityw",
    "/opt/whatever/tool",
  ]) {
    expect(() => validateAbsoluteArgv0("r", argv0)).not.toThrow();
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

test("HostExecStage plan: absolute argv0 pointing at a sensitive container path resolves without throwing", async () => {
  // Complements the validateAbsoluteArgv0 unit tests above by exercising the
  // actual call site in planHostExec (the path.isAbsolute loop). Now that the
  // argv0 allowlist and its fallback bind-mount have been removed, the caller
  // must no longer reject sensitive absolute paths such as /etc/passwd.
  const profile = makeProfile();
  profile.hostexec!.rules = [
    {
      id: "etc-passwd",
      match: { argv0: "/etc/passwd" },
      cwd: { mode: "any", allow: [] },
      env: {},
      inheritEnv: { mode: "minimal", keys: [] },
      approval: "allow",
      fallback: "deny",
    },
  ];
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  const input = {
    ...makeSharedInput(profile, hostEnv),
    ...makeStageState(),
  };
  const plan = await planHostExec(input);

  expect(plan).not.toBeNull();
});

// ============================================================
// EffectStage run() tests
// ============================================================

test("HostExecStage plan: a missing gateway artifact fails with rebuild guidance", async () => {
  const profile = makeProfile();
  const input = {
    ...makeSharedInput(profile, makeHostEnv("/tmp/nas-test-runtime"), {
      hostexecGatewayPath: null,
    }),
    ...makeStageState(),
  };

  expect(() => planHostExec(input)).toThrow(/nas-hostexec-gateway/);
  expect(() => planHostExec(input)).toThrow(/zig build|reinstall/);
});

test("HostExecStage: a missing client binary is a stage failure, not a defect", async () => {
  const profile = makeProfile();
  const hostEnv = makeHostEnv("/tmp/nas-test-runtime");
  // Artifact resolution is a pipeline-startup probe, so a test drops the
  // client by fabricating the probe result -- no filesystem, no fake layer.
  const sharedInput = makeSharedInput(profile, hostEnv, {
    hostexecClientPath: null,
  });
  const stageState = makeStageState();
  const stage = createHostExecStage(sharedInput);

  const scope = Effect.runSync(Scope.make());
  const exit = await Effect.runPromiseExit(
    stage
      .run(stageState)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(makeHostExecSetupServiceFake()),
        Effect.provide(makeHostExecBrokerServiceFake()),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(Exit.isFailure(exit)).toEqual(true);
  if (!Exit.isFailure(exit)) return;
  // A defect would print as an unhandled error and bury the instructions for
  // building the missing artifact.
  expect(Cause.isDieType(exit.cause)).toEqual(false);
  expect(Cause.isFailType(exit.cause)).toEqual(true);
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toEqual(true);
  if (Option.isSome(failure)) {
    expect(String(failure.value)).toContain("nas-hostexec-client");
  }
});

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

test("HostExecStage: run delegates directories and symlinks to HostExecSetupService", async () => {
  const profile = makeProfile();
  const runtimeDir = "/tmp/nas-test-runtime";
  const hostEnv = makeHostEnv(runtimeDir);
  const sharedInput = makeSharedInput(profile, hostEnv);
  const stageState = makeStageState();
  const input = { ...sharedInput, ...stageState };
  const plan = (await planHostExec(input))!;

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

test("HostExecStage: scope release retries a transient broker close failure", async () => {
  const profile = makeProfile();
  const sharedInput = makeSharedInput(
    profile,
    makeHostEnv("/tmp/nas-test-runtime"),
  );
  const stage = createHostExecStage(sharedInput);
  const closeError = new Error("transient teardown failure");
  let closeAttempts = 0;
  let diagnostics = 0;
  const brokerLayer = makeHostExecBrokerServiceFake({
    start: () =>
      Effect.succeed({
        close: () =>
          Effect.suspend(() => {
            closeAttempts += 1;
            return closeAttempts === 1 ? Effect.fail(closeError) : Effect.void;
          }),
        reportTeardown: () =>
          Effect.sync(() => {
            diagnostics += 1;
          }),
      }),
  });
  const scope = Effect.runSync(Scope.make());

  const stageExit = await Effect.runPromiseExit(
    stage
      .run(makeStageState())
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(makeHostExecSetupServiceFake()),
        Effect.provide(brokerLayer),
      ),
  );
  const scopeExit = await Effect.runPromiseExit(Scope.close(scope, Exit.void));

  expect(Exit.isSuccess(stageExit)).toBe(true);
  expect(Exit.isSuccess(scopeExit)).toBe(true);
  expect(closeAttempts).toBe(2);
  expect(diagnostics).toBe(0);
});

test("HostExecStage: persistent broker close failure is reported once and finalizer recovers", async () => {
  const profile = makeProfile();
  const sharedInput = makeSharedInput(
    profile,
    makeHostEnv("/tmp/nas-test-runtime"),
  );
  const stage = createHostExecStage(sharedInput);
  const closeError = new HostExecTeardownError([
    { operation: "stopGateway", error: new Error("gateway stop failed") },
    { operation: "closeBroker", error: new Error("broker close failed") },
  ]);
  let closeAttempts = 0;
  const diagnostics: Cause.Cause<unknown>[] = [];
  const brokerLayer = makeHostExecBrokerServiceFake({
    start: () =>
      Effect.succeed({
        close: () =>
          Effect.suspend(() => {
            closeAttempts += 1;
            return Effect.fail(closeError);
          }),
        reportTeardown: (cause) =>
          Effect.sync(() => {
            diagnostics.push(cause);
          }),
      }),
  });
  const scope = Effect.runSync(Scope.make());

  const stageExit = await Effect.runPromiseExit(
    stage
      .run(makeStageState())
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(makeHostExecSetupServiceFake()),
        Effect.provide(brokerLayer),
      ),
  );
  const scopeExit = await Effect.runPromiseExit(Scope.close(scope, Exit.void));

  expect(Exit.isSuccess(stageExit)).toBe(true);
  expect(Exit.isSuccess(scopeExit)).toBe(true);
  expect(closeAttempts).toBe(3);
  expect(diagnostics).toHaveLength(1);
  const diagnostic = diagnostics[0];
  expect(diagnostic).toBeDefined();
  if (diagnostic !== undefined) {
    const failure = Cause.failureOption(diagnostic);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "Some") {
      expect(failure.value).toBe(closeError);
      expect(
        (failure.value as HostExecTeardownError).failures.map(
          ({ operation }) => operation,
        ),
      ).toEqual(["stopGateway", "closeBroker"]);
      expect(String(failure.value)).toContain("stopGateway -> closeBroker");
    }
  }
});
