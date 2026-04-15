import { expect, test } from "bun:test";
import type {
  AnyStage,
  EffectStageResult,
  HostEnv,
  PriorStageOutputs,
  ProbeResults,
  StageInput,
} from "./types.ts";
import type {
  ContainerPlan,
  DbusState,
  DindState,
  DynamicEnvOp,
  EnvPlan,
  HostExecState,
  MountSpec,
  NetworkState,
  NixState,
  PipelineState,
  PromptState,
  ProxyState,
  SessionState,
  SliceKey,
  WorkspaceState,
} from "./state.ts";

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

// ---------------------------------------------------------------------------
// PipelineState slice types (state.ts)
// ---------------------------------------------------------------------------

test("WorkspaceState: can construct with required and optional fields", () => {
  const ws: WorkspaceState = {
    workDir: "/workspace",
    imageName: "nas-sandbox",
  };
  expect(ws.workDir).toEqual("/workspace");
  expect(ws.mountDir).toBeUndefined();

  const withMount: WorkspaceState = {
    workDir: "/workspace",
    mountDir: "/mnt/repo",
    imageName: "nas-sandbox",
  };
  expect(withMount.mountDir).toEqual("/mnt/repo");
});

test("SessionState: can construct with and without sessionName", () => {
  const s: SessionState = { sessionId: "sess_abc" };
  expect(s.sessionId).toEqual("sess_abc");
  expect(s.sessionName).toBeUndefined();

  const named: SessionState = { sessionId: "sess_abc", sessionName: "my-session" };
  expect(named.sessionName).toEqual("my-session");
});

test("NixState: can construct enabled and disabled", () => {
  const off: NixState = { enabled: false };
  const on: NixState = { enabled: true };
  expect(off.enabled).toEqual(false);
  expect(on.enabled).toEqual(true);
});

test("DbusState: discriminated union prevents invalid state", () => {
  const disabled: DbusState = { enabled: false };
  expect(disabled.enabled).toEqual(false);

  const enabled: DbusState = {
    enabled: true,
    runtimeDir: "/run/user/1000/nas",
    socket: "/run/user/1000/nas/dbus.sock",
    sourceAddress: "unix:path=/run/user/1000/bus",
  };
  expect(enabled.enabled).toEqual(true);
  if (enabled.enabled) {
    expect(enabled.socket).toEqual("/run/user/1000/nas/dbus.sock");
  }
});

test("HostExecState: can construct with all fields", () => {
  const he: HostExecState = {
    runtimeDir: "/run/nas/hostexec",
    brokerSocket: "/run/nas/hostexec/broker.sock",
    sessionTmpDir: "/run/nas/hostexec/sess_abc",
  };
  expect(he.runtimeDir).toEqual("/run/nas/hostexec");
});

test("DindState: can construct", () => {
  const d: DindState = { containerName: "nas-dind-abc" };
  expect(d.containerName).toEqual("nas-dind-abc");
});

test("NetworkState: can construct", () => {
  const n: NetworkState = {
    networkName: "nas-net-abc",
    runtimeDir: "/run/nas/network/abc",
  };
  expect(n.networkName).toEqual("nas-net-abc");
});

test("PromptState: can construct with promptEnabled false", () => {
  const p: PromptState = { promptToken: "", promptEnabled: false };
  expect(p.promptEnabled).toEqual(false);
});

test("ProxyState: can construct", () => {
  const p: ProxyState = {
    brokerSocket: "/run/nas/broker.sock",
    proxyEndpoint: "http://localhost:9901",
  };
  expect(p.proxyEndpoint).toEqual("http://localhost:9901");
});

test("MountSpec: readOnly is optional", () => {
  const rw: MountSpec = { source: "/src", target: "/dst" };
  expect(rw.readOnly).toBeUndefined();

  const ro: MountSpec = { source: "/src", target: "/dst", readOnly: true };
  expect(ro.readOnly).toEqual(true);
});

test("DynamicEnvOp: prefix and suffix modes", () => {
  const prefix: DynamicEnvOp = {
    mode: "prefix",
    key: "PATH",
    value: "/nix/store/xxx/bin",
    separator: ":",
  };
  const suffix: DynamicEnvOp = {
    mode: "suffix",
    key: "PATH",
    value: "/extra/bin",
    separator: ":",
  };
  expect(prefix.mode).toEqual("prefix");
  expect(suffix.mode).toEqual("suffix");
});

test("EnvPlan: can construct with static env and dynamicOps", () => {
  const plan: EnvPlan = {
    static: { TERM: "xterm", HOME: "/root" },
    dynamicOps: [
      { mode: "prefix", key: "PATH", value: "/nix/store/xxx/bin", separator: ":" },
    ],
  };
  expect(plan.static["TERM"]).toEqual("xterm");
  expect(plan.dynamicOps).toHaveLength(1);
});

test("ContainerPlan: can construct full plan", () => {
  const plan: ContainerPlan = {
    image: "nas-sandbox:latest",
    workDir: "/workspace",
    mounts: [{ source: "/repo", target: "/workspace" }],
    env: { static: { TERM: "xterm" }, dynamicOps: [] },
    extraRunArgs: ["--rm"],
    command: { agentCommand: ["claude"], extraArgs: [] },
    labels: { "nas.session": "sess_abc" },
  };
  expect(plan.image).toEqual("nas-sandbox:latest");
  expect(plan.mounts).toHaveLength(1);
  expect(plan.network).toBeUndefined();
});

test("ContainerPlan: network attachment is optional", () => {
  const plan: ContainerPlan = {
    image: "nas-sandbox:latest",
    workDir: "/workspace",
    mounts: [],
    env: { static: {}, dynamicOps: [] },
    extraRunArgs: [],
    command: { agentCommand: ["claude"], extraArgs: [] },
    labels: {},
    network: { name: "nas-net-abc" },
  };
  expect(plan.network?.name).toEqual("nas-net-abc");
  expect(plan.network?.alias).toBeUndefined();
});

test("SliceKey: covers all expected slice names", () => {
  // Verify at runtime that all expected keys are valid as SliceKey.
  const keys: SliceKey[] = [
    "workspace",
    "session",
    "nix",
    "dbus",
    "hostexec",
    "dind",
    "network",
    "prompt",
    "proxy",
    "container",
  ];
  expect(keys).toHaveLength(10);
});

test("PipelineState: can construct with all slices", () => {
  const state: PipelineState = {
    workspace: { workDir: "/workspace", imageName: "nas-sandbox" },
    session: { sessionId: "sess_abc" },
    nix: { enabled: false },
    dbus: { enabled: false },
    hostexec: {
      runtimeDir: "/run/nas/hostexec",
      brokerSocket: "/run/nas/hostexec/broker.sock",
      sessionTmpDir: "/run/nas/hostexec/sess_abc",
    },
    dind: { containerName: "nas-dind-abc" },
    network: { networkName: "nas-net-abc", runtimeDir: "/run/nas/network" },
    prompt: { promptToken: "tok_abc", promptEnabled: true },
    proxy: {
      brokerSocket: "/run/nas/broker.sock",
      proxyEndpoint: "http://localhost:9901",
    },
    container: {
      image: "nas-sandbox:latest",
      workDir: "/workspace",
      mounts: [],
      env: { static: {}, dynamicOps: [] },
      extraRunArgs: [],
      command: { agentCommand: ["claude"], extraArgs: [] },
      labels: {},
    },
  };

  expect(state.workspace.workDir).toEqual("/workspace");
  expect(state.session.sessionId).toEqual("sess_abc");
  expect(state.nix.enabled).toEqual(false);
  expect(state.dbus.enabled).toEqual(false);
  expect(state.container.image).toEqual("nas-sandbox:latest");
});
