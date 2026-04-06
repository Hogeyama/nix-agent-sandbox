import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type {
  AnyStage,
  DindSidecarEffect,
  DirectoryCreateEffect,
  DockerContainerEffect,
  DockerNetworkEffect,
  DockerRunInteractiveEffect,
  DockerVolumeEffect,
  FileWriteEffect,
  HostEnv,
  PlanStage,
  PriorStageOutputs,
  ProbeResults,
  ProceduralResult,
  ProceduralStage,
  ProcessSpawnEffect,
  ReadinessCheck,
  ResourceEffect,
  StagePlan,
  SymlinkEffect,
  UnixListenerEffect,
  WaitForReadyEffect,
} from "./types.ts";
import type { StageInput } from "./types.ts";

// ---------------------------------------------------------------------------
// Type import verification — these tests confirm that types are importable
// and structurally correct at runtime.
// ---------------------------------------------------------------------------

/** Minimal StageInput for invoking plan()/execute()/teardown() in tests. */
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

test("StagePlan: can construct a valid StagePlan object", () => {
  const plan: StagePlan = {
    effects: [],
    dockerArgs: ["--rm"],
    envVars: { FOO: "bar" },
    outputOverrides: { nixEnabled: true },
  };

  expect(plan.effects.length).toEqual(0);
  expect(plan.dockerArgs).toEqual(["--rm"]);
  expect(plan.envVars.FOO).toEqual("bar");
  expect(plan.outputOverrides.nixEnabled).toEqual(true);
});

test("StagePlan: can include various ResourceEffect kinds", () => {
  const dirEffect: DirectoryCreateEffect = {
    kind: "directory-create",
    path: "/tmp/test",
    mode: 0o755,
    removeOnTeardown: true,
  };
  const fileEffect: FileWriteEffect = {
    kind: "file-write",
    path: "/tmp/test/file.txt",
    content: "hello",
    mode: 0o644,
  };
  const containerEffect: DockerContainerEffect = {
    kind: "docker-container",
    name: "test-container",
    image: "alpine:latest",
    reuseIfRunning: false,
    keepOnTeardown: false,
    args: [],
    envVars: {},
    labels: {},
  };
  const networkEffect: DockerNetworkEffect = {
    kind: "docker-network",
    name: "test-net",
    connect: [{ container: "c1", aliases: ["alias1"] }],
  };
  const volumeEffect: DockerVolumeEffect = {
    kind: "docker-volume",
    name: "test-vol",
  };
  const symlinkEffect: SymlinkEffect = {
    kind: "symlink",
    target: "/usr/bin/foo",
    path: "/tmp/link",
  };
  const spawnEffect: ProcessSpawnEffect = {
    kind: "process-spawn",
    id: "proc1",
    command: "/usr/bin/echo",
    args: ["hello"],
  };
  const waitEffect: WaitForReadyEffect = {
    kind: "wait-for-ready",
    check: { kind: "file-exists", path: "/tmp/ready" },
    timeoutMs: 5000,
    pollIntervalMs: 100,
  };
  const dindEffect: DindSidecarEffect = {
    kind: "dind-sidecar",
    containerName: "dind",
    sharedTmpVolume: "shared-tmp",
    networkName: "dind-net",
    shared: false,
    disableCache: false,
    readinessTimeoutMs: 30000,
  };
  const interactiveEffect: DockerRunInteractiveEffect = {
    kind: "docker-run-interactive",
    image: "nas-sandbox",
    name: "session",
    args: ["--rm"],
    envVars: { TERM: "xterm" },
    command: ["bash"],
    labels: { "nas.session": "test" },
  };

  const effects: ResourceEffect[] = [
    dirEffect,
    fileEffect,
    containerEffect,
    networkEffect,
    volumeEffect,
    symlinkEffect,
    spawnEffect,
    waitEffect,
    dindEffect,
    interactiveEffect,
  ];

  expect(effects.length).toEqual(10);
  expect(effects[0].kind).toEqual("directory-create");
  expect(effects[1].kind).toEqual("file-write");
  expect(effects[2].kind).toEqual("docker-container");
  expect(effects[3].kind).toEqual("docker-network");
  expect(effects[4].kind).toEqual("docker-volume");
  expect(effects[5].kind).toEqual("symlink");
  expect(effects[6].kind).toEqual("process-spawn");
  expect(effects[7].kind).toEqual("wait-for-ready");
  expect(effects[8].kind).toEqual("dind-sidecar");
  expect(effects[9].kind).toEqual("docker-run-interactive");
});

test("ReadinessCheck: all variants are assignable", () => {
  const checks: ReadinessCheck[] = [
    { kind: "tcp-port", host: "localhost", port: 8080 },
    { kind: "http-ok", url: "http://localhost:8080/health" },
    { kind: "docker-healthy", container: "envoy" },
    { kind: "file-exists", path: "/tmp/socket" },
  ];
  expect(checks.length).toEqual(4);
});

test("PlanStage: can implement interface", () => {
  const stage: PlanStage = {
    kind: "plan",
    name: "test-plan-stage",
    plan(_input: StageInput): StagePlan | null {
      return {
        effects: [],
        dockerArgs: [],
        envVars: {},
        outputOverrides: {},
      };
    },
  };

  expect(stage.kind).toEqual("plan");
  expect(stage.name).toEqual("test-plan-stage");
});

test("PlanStage: plan() returns StagePlan", () => {
  const stage: PlanStage = {
    kind: "plan",
    name: "returns-plan",
    plan(_input: StageInput): StagePlan | null {
      return {
        effects: [],
        dockerArgs: ["--network=host"],
        envVars: { MY_VAR: "value" },
        outputOverrides: { nixEnabled: true },
      };
    },
  };

  const result = stage.plan(dummyStageInput);
  expect(result !== null).toEqual(true);
  expect(result!.dockerArgs).toEqual(["--network=host"]);
  expect(result!.envVars).toEqual({ MY_VAR: "value" });
  expect(result!.outputOverrides.nixEnabled).toEqual(true);
});

test("PlanStage: plan() returns null to skip stage", () => {
  const stage: PlanStage = {
    kind: "plan",
    name: "skip-stage",
    plan(_input: StageInput): StagePlan | null {
      return null;
    },
  };

  const result = stage.plan(dummyStageInput);
  expect(result).toEqual(null);
});

test("ProceduralStage: can implement interface", () => {
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "test-procedural-stage",
    // deno-lint-ignore require-await
    async execute(_input: StageInput): Promise<ProceduralResult> {
      return { outputOverrides: { workDir: "/new/path" } };
    },
    async teardown(_input: StageInput): Promise<void> {
      // cleanup
    },
  };

  expect(stage.kind).toEqual("procedural");
  expect(stage.name).toEqual("test-procedural-stage");
});

test("ProceduralStage: execute() returns ProceduralResult", async () => {
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "exec-stage",
    // deno-lint-ignore require-await
    async execute(_input: StageInput): Promise<ProceduralResult> {
      return { outputOverrides: { workDir: "/new/path", nixEnabled: true } };
    },
  };

  const result = await stage.execute(dummyStageInput);
  expect(result.outputOverrides.workDir).toEqual("/new/path");
  expect(result.outputOverrides.nixEnabled).toEqual(true);
});

test("ProceduralStage: teardown() is callable when provided", async () => {
  let teardownCalled = false;
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "teardown-stage",
    // deno-lint-ignore require-await
    async execute(_input: StageInput): Promise<ProceduralResult> {
      return { outputOverrides: {} };
    },
    // deno-lint-ignore require-await
    async teardown(_input: StageInput): Promise<void> {
      teardownCalled = true;
    },
  };

  expect(stage.teardown !== undefined).toEqual(true);
  await stage.teardown!(dummyStageInput);
  expect(teardownCalled).toEqual(true);
});

test("ProceduralStage: teardown is optional and can be omitted", () => {
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "no-teardown-stage",
    // deno-lint-ignore require-await
    async execute(_input: StageInput): Promise<ProceduralResult> {
      return { outputOverrides: {} };
    },
  };

  expect(stage.teardown).toEqual(undefined);
});

test("AnyStage: discriminated union works with kind field", () => {
  const planStage: AnyStage = {
    kind: "plan",
    name: "plan",
    plan: () => null,
  };
  const procStage: AnyStage = {
    kind: "procedural",
    name: "proc",
    execute: () => Promise.resolve({ outputOverrides: {} }),
  };

  // Discriminated union narrows correctly
  if (planStage.kind === "plan") {
    expect(typeof planStage.plan).toEqual("function");
  }
  if (procStage.kind === "procedural") {
    expect(typeof procStage.execute).toEqual("function");
  }
});

test("HostEnv: can construct with ReadonlyMap", () => {
  const env: HostEnv = {
    home: "/home/user",
    user: "user",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([["HOME", "/home/user"], [
      "XDG_CACHE_HOME",
      "/home/user/.cache",
    ]]),
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
    // optional fields omitted
  };

  expect(outputs.workDir).toEqual("/workspace");
  expect(outputs.dindContainerName).toEqual(undefined);
});

test("UnixListenerEffect: can use ListenerSpec variants", () => {
  const _sessionBroker: UnixListenerEffect = {
    kind: "unix-listener",
    id: "session-broker",
    socketPath: "/tmp/broker.sock",
    spec: {
      kind: "session-broker",
      paths: {
        runtimeDir: "/tmp/runtime",
        sessionsDir: "/tmp/sessions",
        pendingDir: "/tmp/pending",
        brokersDir: "/tmp/brokers",
        authRouterSocket: "/tmp/auth.sock",
        authRouterPidFile: "/tmp/auth.pid",
        envoyConfigFile: "/tmp/envoy.yaml",
      },
      sessionId: "sess_abc123",
      allowlist: ["github.com"],
      denylist: [],
      promptEnabled: true,
    },
  };

  expect(_sessionBroker.kind).toEqual("unix-listener");
  expect(_sessionBroker.spec.kind).toEqual("session-broker");
});
