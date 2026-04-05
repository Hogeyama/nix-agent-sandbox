import { assertEquals } from "@std/assert";
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

Deno.test("StagePlan: can construct a valid StagePlan object", () => {
  const plan: StagePlan = {
    effects: [],
    dockerArgs: ["--rm"],
    envVars: { FOO: "bar" },
    outputOverrides: { nixEnabled: true },
  };

  assertEquals(plan.effects.length, 0);
  assertEquals(plan.dockerArgs, ["--rm"]);
  assertEquals(plan.envVars.FOO, "bar");
  assertEquals(plan.outputOverrides.nixEnabled, true);
});

Deno.test("StagePlan: can include various ResourceEffect kinds", () => {
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

  assertEquals(effects.length, 10);
  assertEquals(effects[0].kind, "directory-create");
  assertEquals(effects[1].kind, "file-write");
  assertEquals(effects[2].kind, "docker-container");
  assertEquals(effects[3].kind, "docker-network");
  assertEquals(effects[4].kind, "docker-volume");
  assertEquals(effects[5].kind, "symlink");
  assertEquals(effects[6].kind, "process-spawn");
  assertEquals(effects[7].kind, "wait-for-ready");
  assertEquals(effects[8].kind, "dind-sidecar");
  assertEquals(effects[9].kind, "docker-run-interactive");
});

Deno.test("ReadinessCheck: all variants are assignable", () => {
  const checks: ReadinessCheck[] = [
    { kind: "tcp-port", host: "localhost", port: 8080 },
    { kind: "http-ok", url: "http://localhost:8080/health" },
    { kind: "docker-healthy", container: "envoy" },
    { kind: "file-exists", path: "/tmp/socket" },
  ];
  assertEquals(checks.length, 4);
});

Deno.test("PlanStage: can implement interface", () => {
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

  assertEquals(stage.kind, "plan");
  assertEquals(stage.name, "test-plan-stage");
});

Deno.test("PlanStage: plan() returns StagePlan", () => {
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
  assertEquals(result !== null, true);
  assertEquals(result!.dockerArgs, ["--network=host"]);
  assertEquals(result!.envVars, { MY_VAR: "value" });
  assertEquals(result!.outputOverrides.nixEnabled, true);
});

Deno.test("PlanStage: plan() returns null to skip stage", () => {
  const stage: PlanStage = {
    kind: "plan",
    name: "skip-stage",
    plan(_input: StageInput): StagePlan | null {
      return null;
    },
  };

  const result = stage.plan(dummyStageInput);
  assertEquals(result, null);
});

Deno.test("ProceduralStage: can implement interface", () => {
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "test-procedural-stage",
    async execute(_input: StageInput): Promise<ProceduralResult> {
      return { outputOverrides: { workDir: "/new/path" } };
    },
    async teardown(_input: StageInput): Promise<void> {
      // cleanup
    },
  };

  assertEquals(stage.kind, "procedural");
  assertEquals(stage.name, "test-procedural-stage");
});

Deno.test("ProceduralStage: execute() returns ProceduralResult", async () => {
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "exec-stage",
    async execute(_input: StageInput): Promise<ProceduralResult> {
      return { outputOverrides: { workDir: "/new/path", nixEnabled: true } };
    },
  };

  const result = await stage.execute(dummyStageInput);
  assertEquals(result.outputOverrides.workDir, "/new/path");
  assertEquals(result.outputOverrides.nixEnabled, true);
});

Deno.test("ProceduralStage: teardown() is callable when provided", async () => {
  let teardownCalled = false;
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "teardown-stage",
    async execute(_input: StageInput): Promise<ProceduralResult> {
      return { outputOverrides: {} };
    },
    async teardown(_input: StageInput): Promise<void> {
      teardownCalled = true;
    },
  };

  assertEquals(stage.teardown !== undefined, true);
  await stage.teardown!(dummyStageInput);
  assertEquals(teardownCalled, true);
});

Deno.test("ProceduralStage: teardown is optional and can be omitted", () => {
  const stage: ProceduralStage = {
    kind: "procedural",
    name: "no-teardown-stage",
    async execute(_input: StageInput): Promise<ProceduralResult> {
      return { outputOverrides: {} };
    },
  };

  assertEquals(stage.teardown, undefined);
});

Deno.test("AnyStage: discriminated union works with kind field", () => {
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
    assertEquals(typeof planStage.plan, "function");
  }
  if (procStage.kind === "procedural") {
    assertEquals(typeof procStage.execute, "function");
  }
});

Deno.test("HostEnv: can construct with ReadonlyMap", () => {
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

  assertEquals(env.home, "/home/user");
  assertEquals(env.uid, 1000);
  assertEquals(env.env.get("HOME"), "/home/user");
});

Deno.test("ProbeResults: can construct with all fields", () => {
  const probes: ProbeResults = {
    hasHostNix: true,
    xdgDbusProxyPath: "/usr/bin/xdg-dbus-proxy",
    dbusSessionAddress: "unix:path=/run/user/1000/bus",
    gpgAgentSocket: "/run/user/1000/gnupg/S.gpg-agent",
    auditDir: "/tmp/nas-audit",
  };

  assertEquals(probes.hasHostNix, true);
  assertEquals(probes.gpgAgentSocket, "/run/user/1000/gnupg/S.gpg-agent");
});

Deno.test("PriorStageOutputs: can construct with required and optional fields", () => {
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

  assertEquals(outputs.workDir, "/workspace");
  assertEquals(outputs.dindContainerName, undefined);
});

Deno.test("UnixListenerEffect: can use ListenerSpec variants", () => {
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

  assertEquals(_sessionBroker.kind, "unix-listener");
  assertEquals(_sessionBroker.spec.kind, "session-broker");
});
