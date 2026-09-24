import { expect, test } from "bun:test";

/**
 * MountStage の純粋ロジックテスト (unit test)
 *
 * planMount() は純粋関数なので、HostEnv / ProbeResults / MountProbes を
 * リテラルで組み立てて渡す。実行環境に依存しない。
 * run() テストは MountSetupService fake を使う。
 */

import { Effect, Exit, Scope } from "effect";
import type { AgentProbes } from "../../agents/types.ts";
import type { Config, Profile } from "../../config/types.ts";
import {
  DEFAULT_AGENT_STATE_CONFIG,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_GUIDE_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../../config/types.ts";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { PipelineState } from "../../pipeline/state.ts";
import type {
  HostEnv,
  ProbeResults,
  StageInput,
} from "../../pipeline/types.ts";
import type { MountProbes, ResolvedEnvEntry } from "./mount_probes.ts";
import {
  type MountDirectoryEntry,
  makeMountSetupServiceFake,
} from "./mount_setup_service.ts";
import { createMountStage, planMount } from "./stage.ts";

// ============================================================
// テスト用ヘルパー — 全て純粋なリテラル構築
// ============================================================

const TEST_HOME = "/home/testuser";
const TEST_USER = "testuser";
const CONTAINER_HOME = `/home/${TEST_USER}`;
const TEST_WORK_DIR = "/workspace/project";

type NetworkOverrides = Partial<Profile["network"]>;

type ProfileOverrides = Omit<Partial<Profile>, "network"> & {
  network?: NetworkOverrides;
};

function makeProfile(overrides: ProfileOverrides = {}): Profile {
  const baseNetwork = structuredClone(DEFAULT_NETWORK_CONFIG);
  const { network, ...rest } = overrides;
  return {
    agent: "claude",
    agentArgs: [],
    extraAgents: [],
    agentState: DEFAULT_AGENT_STATE_CONFIG,
    direnv: { enable: false },
    nix: { enable: false, mountSocket: false },
    docker: { enable: false, shared: false },
    session: DEFAULT_SESSION_CONFIG,
    network: {
      ...baseNetwork,
      ...network,
    },
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
    secrets: {},
    guide: DEFAULT_GUIDE_CONFIG,
    ...rest,
  };
}

const defaultHostEnv: HostEnv = {
  home: TEST_HOME,
  user: TEST_USER,
  uid: 1000,
  gid: 1000,
  isWSL: false,
  env: new Map(),
};

const defaultProbeResults: ProbeResults = {
  hasHostNix: false,
  xdgDbusProxyPath: null,
  dbusSessionAddress: null,
  auditDir: "/tmp/audit",
  hostexecInterceptLibPath: null,
  hostexecClientPath: null,
  hostexecGatewayPath: null,
};

const defaultClaudeProbes: AgentProbes = {
  claudeDirExists: false,
  claudeJsonExists: false,
  claudeBinPath: null,
  claudeSettingsFiles: [],
};

function makeMountProbes(overrides: Partial<MountProbes> = {}): MountProbes {
  return {
    agentProbes: defaultClaudeProbes,
    extraAgentProbes: [],
    direnvDataDir: null,
    nixConfRealPath: null,
    nixBinPath: null,
    gitConfigExists: false,
    resolvedExtraMounts: [],
    resolvedEnvEntries: [],
    gitWorktreeMainRoot: null,
    xpraBinPath: null,
    xauthBinPath: null,
    takenX11Displays: new Set<number>(),
    x11UnixDirReadOnly: false,
    localConfigPaths: [],
    gitMetadata: null,
    ...overrides,
  };
}

const baseConfig: Config = {
  default: "test",
  profiles: { test: makeProfile() },
  ui: DEFAULT_UI_CONFIG,
  observability: DEFAULT_OBSERVABILITY_CONFIG,
};

type MountStageSlices = Pick<
  PipelineState,
  "workspace" | "nix" | "dbus" | "display" | "container"
>;

function makeSlices(
  overrides: Partial<MountStageSlices> = {},
): MountStageSlices {
  return {
    workspace: {
      workDir: TEST_WORK_DIR,
      imageName: "nas-sandbox",
    },
    nix: { enabled: false },
    dbus: { enabled: false },
    display: { enabled: false },
    container: {
      ...emptyContainerPlan("nas-sandbox", TEST_WORK_DIR),
      env: { static: { NAS_LOG_LEVEL: "info" }, dynamicOps: [] },
    },
    ...overrides,
  };
}

function makeInput(
  opts: {
    profile?: Profile;
    mountProbes?: MountProbes;
    hostEnv?: HostEnv;
    probes?: ProbeResults;
    slices?: Partial<MountStageSlices>;
  } = {},
): {
  input: StageInput & MountStageSlices;
  sharedInput: StageInput;
  slices: MountStageSlices;
  mountProbes: MountProbes;
} {
  const profile = opts.profile ?? makeProfile();
  const mountProbes = opts.mountProbes ?? makeMountProbes();
  const sharedInput: StageInput = {
    config: baseConfig,
    profile,
    profileName: "test",
    sessionId: "sess_test",
    host: opts.hostEnv ?? defaultHostEnv,
    probes: opts.probes ?? defaultProbeResults,
  };
  const slices = makeSlices(opts.slices);
  return {
    input: { ...sharedInput, ...slices },
    sharedInput,
    slices,
    mountProbes,
  };
}

/** resolvedEnvEntries を簡易構築するヘルパー */
function envEntry(
  key: string,
  value: string,
  mode: "set" | "prefix" | "suffix" = "set",
  opts: {
    separator?: string;
    index?: number;
    keySource?: "key" | "keyCmd";
  } = {},
): ResolvedEnvEntry {
  const base = {
    key,
    value,
    index: opts.index ?? 0,
    keySource: opts.keySource ?? ("key" as const),
  };
  if (mode === "set") {
    return { ...base, mode: "set" };
  }
  return { ...base, mode, separator: opts.separator ?? "" };
}

// ============================================================
// 環境変数バリデーション
// ============================================================

test("MountStage: valid env var names accepted", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("SIMPLE", "value", "set", { index: 0 }),
      envEntry("_UNDERSCORE_START", "value", "set", { index: 1 }),
      envEntry("WITH_123_NUMBERS", "value", "set", { index: 2 }),
      envEntry("A", "single-char", "set", { index: 3 }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.SIMPLE).toEqual("value");
  expect(plan.envVars._UNDERSCORE_START).toEqual("value");
  expect(plan.envVars.WITH_123_NUMBERS).toEqual("value");
  expect(plan.envVars.A).toEqual("single-char");
});

test("MountStage: static env var with special chars in value", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("URL", "https://example.com/path?foo=bar&baz=qux", "set", {
        index: 0,
      }),
      envEntry("JSON", '{"key": "value"}', "set", { index: 1 }),
      envEntry("SPACES", "hello world", "set", { index: 2 }),
      envEntry("EMPTY", "", "set", { index: 3 }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.URL).toEqual("https://example.com/path?foo=bar&baz=qux");
  expect(plan.envVars.JSON).toEqual('{"key": "value"}');
  expect(plan.envVars.SPACES).toEqual("hello world");
  expect(plan.envVars.EMPTY).toEqual("");
});

test("MountStage: invalid static env key (starts with number)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [envEntry("123BAD", "value")],
  });
  const { input } = makeInput({ mountProbes });
  expect(() => planMount(input, mountProbes)).toThrow("Invalid env var name");
});

test("MountStage: invalid static env key (contains dash)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [envEntry("MY-VAR", "value")],
  });
  const { input } = makeInput({ mountProbes });
  expect(() => planMount(input, mountProbes)).toThrow("Invalid env var name");
});

test("MountStage: invalid static env key (contains dot)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [envEntry("MY.VAR", "value")],
  });
  const { input } = makeInput({ mountProbes });
  expect(() => planMount(input, mountProbes)).toThrow("Invalid env var name");
});

test("MountStage: invalid dynamic key (keyCmd source)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("BAD KEY", "value", "set", { keySource: "keyCmd" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  expect(() => planMount(input, mountProbes)).toThrow("Invalid env var name");
});

test("MountStage: multiple env vars including both static and dynamic", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("STATIC_A", "a", "set", { index: 0 }),
      envEntry("DYNAMIC_B", "b", "set", { index: 1, keySource: "keyCmd" }),
      envEntry("STATIC_C", "c", "set", { index: 2 }),
      envEntry("DYNAMIC_D", "d", "set", { index: 3, keySource: "keyCmd" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.STATIC_A).toEqual("a");
  expect(plan.envVars.DYNAMIC_B).toEqual("b");
  expect(plan.envVars.STATIC_C).toEqual("c");
  expect(plan.envVars.DYNAMIC_D).toEqual("d");
});

// ============================================================
// env prefix/suffix モード
// ============================================================

test("MountStage: prefix mode prepends to existing var", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("MY_PATH", "/usr/bin", "set", { index: 0 }),
      envEntry("MY_PATH", "/opt/bin", "prefix", { index: 1, separator: ":" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.MY_PATH).toEqual("/opt/bin:/usr/bin");
});

test("MountStage: suffix mode appends to existing var", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("MY_PATH", "/usr/bin", "set", { index: 0 }),
      envEntry("MY_PATH", "/opt/lib", "suffix", { index: 1, separator: ":" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.MY_PATH).toEqual("/usr/bin:/opt/lib");
});

test("MountStage: prefix on unset var generates NAS_ENV_OPS", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("NEW_VAR", "/opt/bin", "prefix", { index: 0, separator: ":" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.NEW_VAR).toBeUndefined();
  expect(plan.envVars.NAS_ENV_OPS).toEqual(
    "__nas_pfx 'NEW_VAR' '/opt/bin' ':'",
  );
});

test("MountStage: suffix on unset var generates NAS_ENV_OPS", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("NEW_VAR", "/opt/lib", "suffix", { index: 0, separator: ":" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.NEW_VAR).toBeUndefined();
  expect(plan.envVars.NAS_ENV_OPS).toEqual(
    "__nas_sfx 'NEW_VAR' '/opt/lib' ':'",
  );
});

test("MountStage: multiple prefix entries generate ordered NAS_ENV_OPS", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("MY_PATH", "/opt/a", "prefix", { index: 0, separator: ":" }),
      envEntry("MY_PATH", "/opt/b", "prefix", { index: 1, separator: ":" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.MY_PATH).toBeUndefined();
  expect(plan.envVars.NAS_ENV_OPS).toEqual(
    "__nas_pfx 'MY_PATH' '/opt/a' ':'\n__nas_pfx 'MY_PATH' '/opt/b' ':'",
  );
});

test("MountStage: suffix with empty separator concatenates directly", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("FLAGS", "-O2", "set", { index: 0 }),
      envEntry("FLAGS", " -Wall", "suffix", { index: 1, separator: "" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.FLAGS).toEqual("-O2 -Wall");
});

test("MountStage: prefix with dynamic val", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("MY_PATH", "/usr/bin", "set", { index: 0 }),
      envEntry("MY_PATH", "/opt/dynamic", "prefix", {
        index: 1,
        separator: ":",
      }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.MY_PATH).toEqual("/opt/dynamic:/usr/bin");
});

test("MountStage: set after prefix replaces entire value", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("MY_PATH", "/opt/bin", "prefix", { index: 0, separator: ":" }),
      envEntry("MY_PATH", "/only/this", "set", { index: 1 }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.MY_PATH).toEqual("/only/this");
  expect(plan.envVars.NAS_ENV_OPS).toBeUndefined();
});

// ============================================================
// extra-mounts バリデーション
// ============================================================

test("MountStage: extra-mount with ~ src expansion (resolved by probe)", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "~", dst: "/mnt/home", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: TEST_HOME,
        srcExists: true,
        srcIsDirectory: true,
        mode: "ro",
        index: 0,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.includes(`${TEST_HOME}:/mnt/home:ro`)).toEqual(true);
});

test("MountStage: extra-mount dst ~ expands to container home", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/some/dir", dst: "~/mounted", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/some/dir",
        srcExists: true,
        srcIsDirectory: true,
        mode: "ro",
        index: 0,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.includes(`/some/dir:${CONTAINER_HOME}/mounted:ro`),
  ).toEqual(true);
});

test("MountStage: extra-mount rw mode has no suffix", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/some/dir", dst: "/mnt/rw-test", mode: "rw" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/some/dir",
        srcExists: true,
        srcIsDirectory: true,
        mode: "rw",
        index: 0,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.includes("/some/dir:/mnt/rw-test")).toEqual(true);
});

test("MountStage: extra-mount relative dst resolves from workDir", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/dev/null", dst: ".env", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/dev/null",
        srcExists: true,
        srcIsDirectory: false,
        mode: "ro",
        index: 0,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.includes(`/dev/null:${TEST_WORK_DIR}/.env:ro`),
  ).toEqual(true);
});

test("MountStage: extra-mount to /var/run/docker.sock is allowed", () => {
  const profile = makeProfile({
    extraMounts: [
      {
        src: "/some/dir",
        dst: "/var/run/docker.sock",
        mode: "ro",
      },
    ],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/some/dir",
        srcExists: true,
        srcIsDirectory: true,
        mode: "ro",
        index: 0,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.some((a: string) => a.includes(":/var/run/docker.sock")),
  ).toEqual(true);
});

test("MountStage: extra-mount to workspace dir is allowed", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/tmp", dst: TEST_WORK_DIR, mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/tmp",
        srcExists: true,
        srcIsDirectory: true,
        mode: "ro",
        index: 0,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.some((a: string) => a.includes(`:${TEST_WORK_DIR}:ro`)),
  ).toEqual(true);
});

test("MountStage: extra-mount file under workspace dir is allowed", () => {
  const profile = makeProfile({
    extraMounts: [
      {
        src: "/dev/null",
        dst: `${TEST_WORK_DIR}/.env`,
        mode: "ro",
      },
    ],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/dev/null",
        srcExists: true,
        srcIsDirectory: false,
        mode: "ro",
        index: 0,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.includes(`/dev/null:${TEST_WORK_DIR}/.env:ro`),
  ).toEqual(true);
});

test("MountStage: extra-mount directory under workspace dir is allowed", () => {
  const profile = makeProfile({
    extraMounts: [
      {
        src: "/tmp/some-dir",
        dst: `${TEST_WORK_DIR}/.config`,
        mode: "ro",
      },
    ],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/tmp/some-dir",
        srcExists: true,
        srcIsDirectory: true,
        mode: "ro",
        index: 0,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.some((a: string) =>
      a.includes(`:${TEST_WORK_DIR}/.config:ro`),
    ),
  ).toEqual(true);
});

test("MountStage: extra-mount nonexistent src is skipped", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/nonexistent", dst: "/mnt/missing", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/nonexistent",
        srcExists: false,
        srcIsDirectory: false,
        mode: "ro",
        index: 0,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.some((a: string) => a.includes("/mnt/missing")),
  ).toEqual(false);
});

test("MountStage: multiple valid extra-mounts all mounted", () => {
  const profile = makeProfile({
    extraMounts: [
      { src: "/dir1", dst: "/mnt/one", mode: "ro" },
      { src: "/dir2", dst: "/mnt/two", mode: "rw" },
    ],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/dir1",
        srcExists: true,
        srcIsDirectory: true,
        mode: "ro",
        index: 0,
      },
      {
        normalizedSrc: "/dir2",
        srcExists: true,
        srcIsDirectory: true,
        mode: "rw",
        index: 1,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.includes("/dir1:/mnt/one:ro")).toEqual(true);
  expect(plan.dockerArgs.includes("/dir2:/mnt/two")).toEqual(true);
});

test("MountStage: extra-mount relative dst with ../ escaping workDir throws", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/dev/null", dst: "../../etc/passwd", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/dev/null",
        srcExists: true,
        srcIsDirectory: false,
        mode: "ro",
        index: 0,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  expect(() => planMount(input, mountProbes)).toThrow(
    /extra-mounts\.dst .* escapes containerWorkDir/,
  );
});

test("MountStage: extra-mount ~ dst with ../ escaping containerHome throws", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/dev/null", dst: "~/../etc/passwd", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/dev/null",
        srcExists: true,
        srcIsDirectory: false,
        mode: "ro",
        index: 0,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  expect(() => planMount(input, mountProbes)).toThrow(
    /extra-mounts\.dst .* escapes containerHome/,
  );
});

test("MountStage: extra-mount relative dst with inner ../ that stays inside workDir is allowed", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/dev/null", dst: "sub/../.env", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/dev/null",
        srcExists: true,
        srcIsDirectory: false,
        mode: "ro",
        index: 0,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.includes(`/dev/null:${TEST_WORK_DIR}/.env:ro`),
  ).toEqual(true);
});

// ============================================================

// ============================================================
// docker (DinD rootless)
// ============================================================

test("MountStage: docker socket not mounted even when docker.enable is true", () => {
  const profile = makeProfile({ docker: { enable: true, shared: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.includes("/var/run/docker.sock:/var/run/docker.sock"),
  ).toEqual(false);
});

test("MountStage: docker socket not mounted when docker.enable is false", () => {
  const profile = makeProfile({ docker: { enable: false, shared: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.includes("/var/run/docker.sock:/var/run/docker.sock"),
  ).toEqual(false);
});

// ============================================================
// GPG mount
// ============================================================

// gpg.forwardAgent は廃止した。ソケットを渡すと、コンテナ内のエージェントは
// ホストの鍵すべてで署名・復号できてしまう。署名させたいならホスト側に移譲する
// hostexec ルールで、通す呼び出しの形を固定する。
test("MountStage: the host gpg-agent is never shared with the container", () => {
  const { input, mountProbes } = makeInput();
  const plan = planMount(input, mountProbes);
  for (const gnupgPath of [
    "S.gpg-agent",
    "gpg.conf",
    "gpg-agent.conf",
    "pubring.kbx",
    "trustdb.gpg",
  ]) {
    expect(plan.dockerArgs.some((a: string) => a.includes(gnupgPath))).toEqual(
      false,
    );
  }
  expect("GPG_AGENT_INFO" in plan.envVars).toEqual(false);
});

// ============================================================
// workspace mount
// ============================================================

test("MountStage: workspace uses absolute path", () => {
  const { input, mountProbes } = makeInput();
  const plan = planMount(input, mountProbes);

  const vIdx = plan.dockerArgs.indexOf("-v");
  expect(vIdx >= 0).toEqual(true);
  expect(plan.dockerArgs[vIdx + 1]).toEqual(
    `${TEST_WORK_DIR}:${TEST_WORK_DIR}`,
  );

  const wIdx = plan.dockerArgs.indexOf("-w");
  expect(wIdx >= 0).toEqual(true);
  expect(plan.dockerArgs[wIdx + 1]).toEqual(TEST_WORK_DIR);
});

test("MountStage: NAS_USER and NAS_HOME are set", () => {
  const { input, mountProbes } = makeInput();
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.NAS_USER).toEqual(TEST_USER);
  expect(plan.envVars.NAS_HOME).toEqual(CONTAINER_HOME);
});

test("MountStage: NAS_UID and NAS_GID are set when host provides them", () => {
  const { input, mountProbes } = makeInput();
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.NAS_UID).toEqual("1000");
  expect(plan.envVars.NAS_GID).toEqual("1000");
});

test("MountStage: NAS_UID and NAS_GID absent when uid/gid null", () => {
  const hostEnv: HostEnv = { ...defaultHostEnv, uid: null, gid: null };
  const { input, mountProbes } = makeInput({ hostEnv });
  const plan = planMount(input, mountProbes);
  expect("NAS_UID" in plan.envVars).toEqual(false);
  expect("NAS_GID" in plan.envVars).toEqual(false);
});

// ============================================================
// Nix マウント
// ============================================================

test("MountStage: nix disabled does not mount /nix", () => {
  const profile = makeProfile({
    nix: { enable: false, mountSocket: true },
  });
  const { input, mountProbes } = makeInput({ profile });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.includes("/nix:/nix")).toEqual(false);
  expect("NIX_REMOTE" in plan.envVars).toEqual(false);
});

test("MountStage: nix enabled but mountSocket false skips socket", () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: false },
  });
  const { input, mountProbes } = makeInput({
    profile,
    slices: { nix: { enabled: true } },
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.includes("/nix:/nix")).toEqual(false);
});

test("MountStage: nix enabled with mountSocket mounts /nix when host has nix", () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true },
  });
  const probes: ProbeResults = { ...defaultProbeResults, hasHostNix: true };
  const mountProbes = makeMountProbes({ nixBinPath: "/nix/store/xxx/bin/nix" });
  const { input } = makeInput({
    profile,
    mountProbes,
    probes,
    slices: { nix: { enabled: true } },
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.includes("/nix:/nix")).toEqual(true);
  expect(plan.envVars.NIX_REMOTE).toEqual("daemon");
  expect(plan.envVars.NIX_ENABLED).toEqual("true");
});

test("MountStage: nix enabled but host has no nix does not mount /nix", () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true },
  });
  const probes: ProbeResults = { ...defaultProbeResults, hasHostNix: false };
  const { input, mountProbes } = makeInput({
    profile,
    probes,
    slices: { nix: { enabled: true } },
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.includes("/nix:/nix")).toEqual(false);
});

test("MountStage: nix conf outside /nix is mounted to temp path", () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true },
  });
  const probes: ProbeResults = { ...defaultProbeResults, hasHostNix: true };
  const mountProbes = makeMountProbes({
    nixConfRealPath: "/etc/static/nix.conf",
  });
  const { input } = makeInput({
    profile,
    mountProbes,
    probes,
    slices: { nix: { enabled: true } },
  });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.NIX_CONF_PATH).toEqual("/tmp/nas-host-nix.conf");
  expect(
    plan.dockerArgs.some((a: string) =>
      a.includes("/etc/static/nix.conf:/tmp/nas-host-nix.conf:ro"),
    ),
  ).toEqual(true);
});

test("MountStage: nix conf under /nix uses original path", () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true },
  });
  const probes: ProbeResults = { ...defaultProbeResults, hasHostNix: true };
  const mountProbes = makeMountProbes({
    nixConfRealPath: "/nix/store/xxx/etc/nix.conf",
  });
  const { input } = makeInput({
    profile,
    mountProbes,
    probes,
    slices: { nix: { enabled: true } },
  });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.NIX_CONF_PATH).toEqual("/nix/store/xxx/etc/nix.conf");
});

// ============================================================
// gcloud / AWS mount
// ============================================================

// gcloud.mountConfig / aws.mountConfig は廃止した。設定ディレクトリごと渡すと
// 資格情報が読めるうえ、書き換えもホストに残る。必要な値は使う場所で注入するか、
// 要るパスだけを extraMounts で ro 指定する。
test("MountStage: cloud credential directories are never shared wholesale", () => {
  const { input, mountProbes } = makeInput();
  const plan = planMount(input, mountProbes);
  for (const configDir of [".config/gcloud", ".aws"]) {
    expect(plan.dockerArgs.some((a: string) => a.includes(configDir))).toEqual(
      false,
    );
  }
});

// ============================================================
// git config mount
// ============================================================

test("MountStage: git config mounted when exists", () => {
  const mountProbes = makeMountProbes({ gitConfigExists: true });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.some((a: string) => a.includes(".config/git")),
  ).toEqual(true);
});

test("MountStage: git config not mounted when absent", () => {
  const mountProbes = makeMountProbes({ gitConfigExists: false });
  const { input } = makeInput({ mountProbes });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.some((a: string) => a.includes(".config/git")),
  ).toEqual(false);
});

// ============================================================
// agent dispatch
// ============================================================

test("MountStage: claude agent sets agentCommand and PATH", () => {
  const profile = makeProfile({ agent: "claude" });
  const mountProbes = makeMountProbes({ agentProbes: defaultClaudeProbes });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  const agentCommand = plan.containerPatch.command!.agentCommand;
  expect(agentCommand.length > 0).toEqual(true);
  expect(plan.envVars.PATH?.includes(`${CONTAINER_HOME}/.local/bin`)).toEqual(
    true,
  );
});

// agentState.protectSettings reaches the agent configurator through planMount;
// without the wiring the state directory stays writable end to end.
test("MountStage: agentState.protectSettings reaches the agent mounts", () => {
  const agentProbes: AgentProbes = {
    ...defaultClaudeProbes,
    claudeDirExists: true,
    claudeSettingsFiles: ["settings.json"],
  };
  const roMount = {
    source: `${TEST_HOME}/.claude/settings.json`,
    target: `${CONTAINER_HOME}/.claude/settings.json`,
    readOnly: true,
  };

  const mountProbes = makeMountProbes({ agentProbes });
  const protected_ = planMount(
    makeInput({
      profile: makeProfile({
        agent: "claude",
        agentState: { protectSettings: true },
      }),
      mountProbes,
    }).input,
    mountProbes,
    undefined,
    {
      runtimeDir: "/tmp/claude-state",
      claudeJson: `${TEST_HOME}/.claude.json`,
      entries: [
        { source: roMount.source, name: "settings.json", readOnly: true },
      ],
    },
  );
  expect(protected_.containerPatch.mounts).toContainEqual(roMount);

  const unprotected = planMount(
    makeInput({
      profile: makeProfile({
        agent: "claude",
        agentState: { protectSettings: false },
      }),
      mountProbes,
    }).input,
    mountProbes,
  );
  expect(unprotected.containerPatch.mounts).not.toContainEqual(roMount);
});

test("MountStage: copilot agent sets agentCommand", () => {
  const copilotProbes: AgentProbes = {
    copilotBinPath: "/usr/bin/copilot",
    copilotLegacyDirExists: false,
    copilotSettingsFiles: [],
  };
  const profile = makeProfile({ agent: "copilot" });
  const mountProbes = makeMountProbes({ agentProbes: copilotProbes });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.containerPatch.command!.agentCommand).toEqual(["copilot"]);
});

test("MountStage: codex agent sets agentCommand", () => {
  const codexProbes: AgentProbes = {
    codexDirExists: false,
    codexBinPath: "/usr/bin/codex",
    codexCodeModeHostBinPath: null,
    codexSettingsFiles: [],
  };
  const profile = makeProfile({ agent: "codex" });
  const mountProbes = makeMountProbes({ agentProbes: codexProbes });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.containerPatch.command!.agentCommand).toEqual([
    "codex",
    "-c",
    "shell_environment_policy.inherit=all",
  ]);
});

test("MountStage: extraAgents are provisioned without replacing the launched command", () => {
  const codexProbes: AgentProbes = {
    codexDirExists: true,
    codexBinPath: "/usr/bin/codex",
    codexCodeModeHostBinPath: null,
    codexSettingsFiles: [],
  };
  const claudeProbes: AgentProbes = {
    ...defaultClaudeProbes,
    claudeDirExists: true,
    claudeBinPath: "/nix/store/claude/bin/claude",
  };
  const profile = makeProfile({ agent: "codex", extraAgents: ["claude"] });
  const mountProbes = makeMountProbes({
    agentProbes: codexProbes,
    extraAgentProbes: [{ agent: "claude", probes: claudeProbes }],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);

  expect(plan.containerPatch.command!.agentCommand).toEqual([
    "codex",
    "-c",
    "shell_environment_policy.inherit=all",
  ]);
  const targets = plan.containerPatch.mounts!.map((m) => m.target);
  expect(targets).toContain(`${CONTAINER_HOME}/.codex`);
  expect(targets).toContain(`${CONTAINER_HOME}/.claude`);
  expect(targets).toContain(`${CONTAINER_HOME}/.local/bin/claude`);
  expect(plan.envVars.PATH?.startsWith(`${CONTAINER_HOME}/.local/bin:`)).toBe(
    true,
  );
});

// REMOTE_CONTAINERS is for Copilot's interactive clipboard; as a
// container-wide variable it would also reach the launched agent.
test("MountStage: an extra Copilot does not set its launch-only env", () => {
  const profile = makeProfile({ agent: "claude", extraAgents: ["copilot"] });
  const mountProbes = makeMountProbes({
    extraAgentProbes: [
      {
        agent: "copilot",
        probes: {
          copilotBinPath: "/usr/bin/copilot",
          copilotLegacyDirExists: true,
          copilotSettingsFiles: [],
        },
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);

  expect(plan.dockerArgs).toContain(
    "/usr/bin/copilot:/usr/local/bin/copilot:ro",
  );
  expect(plan.envVars.REMOTE_CONTAINERS).toBeUndefined();
});

// protectSettings covers Claude's state whether Claude is launched or only
// provisioned: the host ~/.claude is mounted either way.
test("MountStage: protectSettings requires protected Claude state when Claude is an extra agent", () => {
  const profile = makeProfile({
    agent: "codex",
    extraAgents: ["claude"],
    agentState: { protectSettings: true },
  });
  const mountProbes = makeMountProbes({
    agentProbes: {
      codexDirExists: false,
      codexBinPath: null,
      codexCodeModeHostBinPath: null,
      codexSettingsFiles: [],
    },
    extraAgentProbes: [{ agent: "claude", probes: defaultClaudeProbes }],
  });
  const { input } = makeInput({ profile, mountProbes });
  expect(() => planMount(input, mountProbes)).toThrow(
    "Protected Claude state must be prepared",
  );
});

// ============================================================
// DBus proxy
// ============================================================

test("MountStage: dbus proxy mounts runtime dir", () => {
  const profile = makeProfile();
  const { input, mountProbes } = makeInput({
    profile,
    slices: {
      dbus: {
        enabled: true,
        runtimeDir: "/tmp/nas-dbus-123",
        socket: "/tmp/nas-dbus-123/bus",
        sourceAddress: "unix:path=/tmp/nas-dbus-123/bus",
      },
    },
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.includes(`/tmp/nas-dbus-123:/run/user/1000`)).toEqual(
    true,
  );
  expect(plan.envVars.XDG_RUNTIME_DIR).toEqual("/run/user/1000");
  expect(plan.envVars.DBUS_SESSION_BUS_ADDRESS).toEqual(
    "unix:path=/run/user/1000/bus",
  );
});

test("MountStage: dbus proxy requires uid", () => {
  const hostEnv: HostEnv = { ...defaultHostEnv, uid: null, gid: null };
  const { input, mountProbes } = makeInput({
    hostEnv,
    slices: {
      dbus: {
        enabled: true,
        runtimeDir: "/tmp/nas-dbus-123",
        socket: "/tmp/nas-dbus-123/bus",
        sourceAddress: "unix:path=/tmp/nas-dbus-123/bus",
      },
    },
  });
  expect(() => planMount(input, mountProbes)).toThrow(
    "dbus.session.enable requires a host UID",
  );
});

// ============================================================
// mountDir
// ============================================================

test("MountStage: mountDir overrides workspace mount source", () => {
  const { input, mountProbes } = makeInput({
    slices: {
      workspace: {
        workDir: TEST_WORK_DIR,
        mountDir: "/alt/mount/source",
        imageName: "nas-sandbox",
      },
    },
  });
  const plan = planMount(input, mountProbes);
  const vIdx = plan.dockerArgs.indexOf("-v");
  // mountDir は -v のソース側だけ変える。dst は workDir のまま
  // ただし path.resolve で mountDir 自体が dst にもなる
  expect(plan.dockerArgs[vIdx + 1]).toEqual(
    "/alt/mount/source:/alt/mount/source",
  );
  // -w は workDir
  const wIdx = plan.dockerArgs.indexOf("-w");
  expect(plan.dockerArgs[wIdx + 1]).toEqual(TEST_WORK_DIR);
});

// ============================================================
// git worktree
// ============================================================

test("MountStage: git worktree widens mount source to main repo root", () => {
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ gitWorktreeMainRoot: "/repo" }),
  });
  const plan = planMount(input, mountProbes);
  const vIdx = plan.dockerArgs.indexOf("-v");
  expect(plan.dockerArgs[vIdx + 1]).toEqual("/repo:/repo");
});

test("MountStage: no mount widening when not in a worktree", () => {
  const { input, mountProbes } = makeInput();
  const plan = planMount(input, mountProbes);
  const vIdx = plan.dockerArgs.indexOf("-v");
  expect(plan.dockerArgs[vIdx + 1]).toEqual(
    `${TEST_WORK_DIR}:${TEST_WORK_DIR}`,
  );
});

// ============================================================
// maskfs (maskedRoot バインドソース差し替え)
// ============================================================

test("MountStage: maskedRoot set uses maskedRoot as bind source, real path as target", () => {
  const maskedRoot = "/run/user/1000/nas/maskfs/sessions/s1/mnt";
  const { input, mountProbes } = makeInput({
    slices: {
      workspace: {
        workDir: TEST_WORK_DIR,
        imageName: "nas-sandbox",
        maskedRoot,
      },
    },
  });
  const plan = planMount(input, mountProbes);

  const workspaceMount = plan.containerPatch.mounts?.find(
    (m) => m.target === TEST_WORK_DIR,
  );
  expect(workspaceMount?.source).toEqual(maskedRoot);
  expect(plan.dockerArgs).toContain(`${maskedRoot}:${TEST_WORK_DIR}`);
});

test("MountStage: maskedRoot unset keeps bind source == target", () => {
  const { input, mountProbes } = makeInput();
  const plan = planMount(input, mountProbes);

  const workspaceMount = plan.containerPatch.mounts?.find(
    (m) => m.target === TEST_WORK_DIR,
  );
  expect(workspaceMount?.source).toEqual(TEST_WORK_DIR);
});

test("MountStage: mask with maskfs=false does not require maskedRoot (proxy-only masking)", () => {
  // proxy マスクのみの構成では MaskFsStage がスキップされ maskedRoot は未設定。
  // ガードが maskfs 有効時のみ発火することを確認する (バインドソースは実パス)。
  const { input, mountProbes } = makeInput({
    profile: makeProfile({
      mask: {
        writePolicy: "readonly",
        maskfs: false,
        proxy: true,
        filter: true,
      },
    }),
  });

  const plan = planMount(input, mountProbes);
  const workspaceMount = plan.containerPatch.mounts?.find(
    (m) => m.target === TEST_WORK_DIR,
  );
  expect(workspaceMount?.source).toEqual(TEST_WORK_DIR);
});

test("MountStage: mask with maskfs=true but maskedRoot unset throws ordering guard", () => {
  const { input, mountProbes } = makeInput({
    profile: makeProfile({
      secrets: { workspace: { from: "env:TEST_SECRET" } },
      mask: {
        writePolicy: "readonly",
        maskfs: true,
        proxy: false,
        filter: true,
      },
    }),
  });

  expect(() => planMount(input, mountProbes)).toThrow(
    /MaskFsStage must run before MountStage/,
  );
});

test("MountStage: maskedRoot set does not affect .nas/config.pkl RO mount source", () => {
  // config.pkl は secrets にリテラルを書けないため秘密値を含まず、
  // 実パスを RO で見せる方が改ざん防止として優先される。
  const maskedRoot = "/run/user/1000/nas/maskfs/sessions/s1/mnt";
  const configPath = `${TEST_WORK_DIR}/.nas/config.pkl`;
  const { input, mountProbes } = makeInput({
    slices: {
      workspace: {
        workDir: TEST_WORK_DIR,
        imageName: "nas-sandbox",
        maskedRoot,
      },
    },
    mountProbes: makeMountProbes({ localConfigPaths: [configPath] }),
  });
  const plan = planMount(input, mountProbes);

  expect(plan.dockerArgs).toContain(`${configPath}:${configPath}:ro`);
  expect(plan.containerPatch.mounts).toContainEqual({
    source: configPath,
    target: configPath,
    readOnly: true,
  });
});

// ============================================================
// .nas/config.pkl RO bind mount (改ざん防止)
// ============================================================

test("MountStage: .nas/config.pkl inside mountSource is RO bind mounted", () => {
  const configPath = `${TEST_WORK_DIR}/.nas/config.pkl`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ localConfigPaths: [configPath] }),
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs).toContain(`${configPath}:${configPath}:ro`);
  expect(plan.containerPatch.mounts).toContainEqual({
    source: configPath,
    target: configPath,
    readOnly: true,
  });
});

test("MountStage: multiple .nas/config.pkl at different levels are all RO bind mounted", () => {
  const pklPath1 = `${TEST_WORK_DIR}/.nas/config.pkl`;
  const pklPath2 = `${TEST_WORK_DIR}/sub/.nas/config.pkl`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ localConfigPaths: [pklPath1, pklPath2] }),
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs).toContain(`${pklPath1}:${pklPath1}:ro`);
  expect(plan.dockerArgs).toContain(`${pklPath2}:${pklPath2}:ro`);
});

test("MountStage: config path outside mountSource is skipped", () => {
  // workspace = /workspace/project だが、config は /etc/other/.nas/config.pkl
  // (mountSource 外なのでコンテナからは見えない → RO mount する必要もない)
  const outsidePath = "/etc/other/.nas/config.pkl";
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ localConfigPaths: [outsidePath] }),
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs).not.toContain(`${outsidePath}:${outsidePath}:ro`);
});

test("MountStage: with gitWorktreeMainRoot, config within main root is RO mounted", () => {
  // worktree 内にいるが、config は本体リポジトリルート直下にある
  const mainRoot = "/repo";
  const configPath = `${mainRoot}/.nas/config.pkl`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({
      gitWorktreeMainRoot: mainRoot,
      localConfigPaths: [configPath],
    }),
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs).toContain(`${configPath}:${configPath}:ro`);
});

test("MountStage: RO mount is emitted AFTER the workspace RW mount", () => {
  // Docker は後から指定された具体的なサブマウントで上書きするため順序が重要
  const configPath = `${TEST_WORK_DIR}/.nas/config.pkl`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ localConfigPaths: [configPath] }),
  });
  const plan = planMount(input, mountProbes);
  const wsIdx = plan.dockerArgs.indexOf(`${TEST_WORK_DIR}:${TEST_WORK_DIR}`);
  const configIdx = plan.dockerArgs.indexOf(`${configPath}:${configPath}:ro`);
  expect(wsIdx).toBeGreaterThanOrEqual(0);
  expect(configIdx).toBeGreaterThan(wsIdx);
});

/** 自分自身への RW bind mount (rename 防止の pin) の target 一覧 */
function pinnedTargets(plan: {
  containerPatch: { mounts?: readonly MountSpecLike[] };
}): string[] {
  return (plan.containerPatch.mounts ?? [])
    .filter((m) => !m.readOnly && m.source === m.target)
    .map((m) => m.target)
    .filter((t) => t !== TEST_WORK_DIR && t !== "/repo");
}
type MountSpecLike = { source: string; target: string; readOnly?: boolean };

test("MountStage: .nas is pinned so `mv .nas .nas.old` cannot drop the config.pkl RO mount", () => {
  const configPath = `${TEST_WORK_DIR}/.nas/config.pkl`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ localConfigPaths: [configPath] }),
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs).toContain(`${configPath}:${configPath}:ro`);
  expect(pinnedTargets(plan)).toEqual([`${TEST_WORK_DIR}/.nas`]);
});

test("MountStage: nested config.pkl pins every intermediate dir", () => {
  const configPath = `${TEST_WORK_DIR}/sub/.nas/config.pkl`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ localConfigPaths: [configPath] }),
  });
  const plan = planMount(input, mountProbes);
  expect(pinnedTargets(plan)).toEqual([
    `${TEST_WORK_DIR}/sub`,
    `${TEST_WORK_DIR}/sub/.nas`,
  ]);
});

test("MountStage: nas worktree pins .nas once for both config.pkl and the worktree .git file", () => {
  const repoRoot = "/repo";
  const worktree = `${repoRoot}/.nas/worktrees/nas-1`;
  const configPath = `${repoRoot}/.nas/config.pkl`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ localConfigPaths: [configPath] }),
    slices: {
      workspace: {
        workDir: worktree,
        mountDir: repoRoot,
        imageName: "nas-sandbox",
      },
    },
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs).toContain(`${configPath}:${configPath}:ro`);
  expect(plan.dockerArgs).toContain(`${worktree}/.git:${worktree}/.git:ro`);
  expect(pinnedTargets(plan)).toEqual([
    `${repoRoot}/.nas`,
    `${repoRoot}/.nas/worktrees`,
    worktree,
  ]);
});

test("MountStage: IDE .nas RO dir is itself a mount point, so only its ancestors are pinned", () => {
  const configPath = `${TEST_WORK_DIR}/sub/.nas/config.pkl`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ localConfigPaths: [configPath] }),
  });
  const plan = planMount(input, mountProbes, ideMounts);
  expect(plan.containerPatch.mounts).toContainEqual({
    source: `${TEST_WORK_DIR}/sub/.nas`,
    target: `${TEST_WORK_DIR}/sub/.nas`,
    readOnly: true,
  });
  expect(pinnedTargets(plan)).toEqual([`${TEST_WORK_DIR}/sub`]);
  // 同じ target への重複 mount は作らない
  const targets = (plan.containerPatch.mounts ?? []).map((m) => m.target);
  expect(new Set(targets).size).toBe(targets.length);
});

// ============================================================
// .git/config / hooks RO bind mount (ホストでのコード実行防止)
// ============================================================

function mountIndex(plan: { dockerArgs: readonly string[] }, spec: string) {
  return plan.dockerArgs.indexOf(spec);
}

test("MountStage: .git/config and .git/hooks are RO mounted, .git pinned in between", () => {
  const gitDir = `${TEST_WORK_DIR}/.git`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({
      gitMetadata: {
        readOnlyPaths: [`${gitDir}/config`, `${gitDir}/hooks`],
        missingHookDirs: [],
        skippedSymlinks: [],
      },
    }),
  });
  const plan = planMount(input, mountProbes);
  const ws = mountIndex(plan, `${TEST_WORK_DIR}:${TEST_WORK_DIR}`);
  // `mv .git .git.old` で RO を外せないよう .git 自体を mount point にする
  const pin = mountIndex(plan, `${gitDir}:${gitDir}`);
  const config = mountIndex(plan, `${gitDir}/config:${gitDir}/config:ro`);
  const hooks = mountIndex(plan, `${gitDir}/hooks:${gitDir}/hooks:ro`);
  expect(ws).toBeGreaterThanOrEqual(0);
  expect(pin).toBeGreaterThan(ws);
  expect(config).toBeGreaterThan(pin);
  expect(hooks).toBeGreaterThan(pin);
  expect(plan.containerPatch.mounts).toContainEqual({
    source: `${gitDir}/config`,
    target: `${gitDir}/config`,
    readOnly: true,
  });
  expect(plan.directories).toEqual([]);
});

test("MountStage: missing hooks dir is created on the host and RO mounted", () => {
  const hooks = `${TEST_WORK_DIR}/.git/hooks`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({
      gitMetadata: {
        readOnlyPaths: [],
        missingHookDirs: [hooks, "/elsewhere/hooks"],
        skippedSymlinks: [],
      },
    }),
  });
  const plan = planMount(input, mountProbes);
  expect(plan.directories).toEqual([
    { path: hooks, mode: 0o755, removeOnTeardown: false },
  ]);
  expect(plan.dockerArgs).toContain(`${hooks}:${hooks}:ro`);
  // mountSource 外はコンテナから見えないので作らない・mount しない
  expect(plan.dockerArgs.some((a) => a.includes("/elsewhere"))).toBe(false);
});

test("MountStage: core.hooksPath inside the worktree is RO without pinning the root", () => {
  const husky = `${TEST_WORK_DIR}/.husky`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({
      gitMetadata: {
        readOnlyPaths: [husky],
        missingHookDirs: [],
        skippedSymlinks: [],
      },
    }),
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs).toContain(`${husky}:${husky}:ro`);
  // workspace mount 以外に mountSource 自体の mount は増えない
  expect(
    plan.dockerArgs.filter((a) => a === `${TEST_WORK_DIR}:${TEST_WORK_DIR}`),
  ).toHaveLength(1);
});

test("MountStage: nas worktree .git file is RO and its ancestors up to the repo root are pinned", () => {
  const repoRoot = "/repo";
  const worktree = `${repoRoot}/.nas/worktrees/nas-1`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({
      gitMetadata: {
        readOnlyPaths: [`${repoRoot}/.git/config`],
        missingHookDirs: [],
        skippedSymlinks: [],
      },
    }),
    slices: {
      workspace: {
        workDir: worktree,
        mountDir: repoRoot,
        imageName: "nas-sandbox",
      },
    },
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs).toContain(`${worktree}/.git:${worktree}/.git:ro`);
  for (const dir of [
    `${repoRoot}/.git`,
    `${repoRoot}/.nas`,
    `${repoRoot}/.nas/worktrees`,
    worktree,
  ]) {
    expect(plan.dockerArgs).toContain(`${dir}:${dir}`);
  }
  expect(mountIndex(plan, `${repoRoot}/.nas:${repoRoot}/.nas`)).toBeLessThan(
    mountIndex(plan, `${worktree}:${worktree}`),
  );
});

test("MountStage: git metadata RO source follows the maskfs view", () => {
  const maskedRoot = "/run/user/1000/nas/maskfs/sessions/s1/mnt";
  const config = `${TEST_WORK_DIR}/.git/config`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({
      gitMetadata: {
        readOnlyPaths: [config],
        missingHookDirs: [],
        skippedSymlinks: [],
      },
    }),
    slices: {
      workspace: {
        workDir: TEST_WORK_DIR,
        imageName: "nas-sandbox",
        maskedRoot,
      },
    },
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs).toContain(`${maskedRoot}/.git/config:${config}:ro`);
});

test("MountStage: git metadata outside mountSource or symlinked is not mounted", () => {
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({
      gitMetadata: {
        readOnlyPaths: ["/other/repo/.git/config"],
        missingHookDirs: [],
        skippedSymlinks: [`${TEST_WORK_DIR}/.git/hooks`],
      },
    }),
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.some((a) => a.includes(".git"))).toBe(false);
});

test("MountStage: structured workspace, nix, and dbus slices drive planning", () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true },
  });
  const { input, mountProbes } = makeInput({
    profile,
    probes: {
      ...defaultProbeResults,
      hasHostNix: true,
    },
    slices: {
      workspace: {
        workDir: "/slice/workdir",
        mountDir: "/slice/mountdir",
        imageName: "slice-image",
      },
      nix: { enabled: true },
      dbus: {
        enabled: true,
        runtimeDir: "/slice/dbus",
        socket: "/slice/dbus/bus",
        sourceAddress: "unix:path=/slice/dbus/bus",
      },
    },
  });

  const plan = planMount(input, mountProbes);

  expect(plan.dockerArgs).toContain("/slice/mountdir:/slice/mountdir");
  expect(plan.dockerArgs).toContain("/slice/dbus:/run/user/1000");
  expect(plan.dockerArgs).toContain("/nix:/nix");
  expect(plan.envVars.WORKSPACE).toEqual("/slice/workdir");
  expect(plan.envVars.XDG_RUNTIME_DIR).toEqual("/run/user/1000");
  expect(plan.envVars.NIX_ENABLED).toEqual("true");
});

test("MountStage: planner emits container patch with structured mounts and dynamic env ops", () => {
  const profile = makeProfile({
    env: [
      {
        key: "PATH",
        val: "/opt/nas/bin",
        mode: "prefix",
        separator: ":",
      },
    ],
  });
  const { input, mountProbes } = makeInput({
    profile,
    mountProbes: makeMountProbes({
      resolvedEnvEntries: [
        {
          key: "PATH",
          value: "/opt/nas/bin",
          mode: "prefix",
          separator: ":",
          index: 0,
          keySource: "key",
        },
      ],
    }),
    slices: {
      container: {
        image: "slice-image",
        workDir: "/slice/workdir",
        mounts: [{ source: "/existing/src", target: "/existing/dst" }],
        namedVolumes: [],
        env: {
          static: { EXISTING_ENV: "1" },
          dynamicOps: [],
        },
        extraHosts: [],
        extraRunArgs: ["--init"],
        command: { agentCommand: ["legacy-agent"], extraArgs: ["--safe"] },
        labels: { "nas.managed": "true" },
      },
    },
  });

  const plan = planMount(input, mountProbes);

  expect(plan.containerPatch.workDir).toEqual(TEST_WORK_DIR);
  expect(plan.containerPatch.mounts).toContainEqual({
    source: TEST_WORK_DIR,
    target: TEST_WORK_DIR,
  });
  expect(plan.containerPatch.env).toEqual({
    static: {
      NAS_USER: TEST_USER,
      NAS_HOME: CONTAINER_HOME,
      NAS_UID: "1000",
      NAS_GID: "1000",
      WORKSPACE: TEST_WORK_DIR,
      PATH:
        `${CONTAINER_HOME}/.local/bin:` +
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    },
    dynamicOps: [
      {
        mode: "prefix",
        key: "PATH",
        value: "/opt/nas/bin",
        separator: ":",
      },
    ],
  });
  expect(plan.containerPatch.command).toEqual({
    agentCommand: [
      "bash",
      "-c",
      'curl -fsSL https://claude.ai/install.sh | bash && claude "$@"',
      "claude",
    ],
    extraArgs: ["--safe"],
  });
});

// ============================================================
// minimal profile
// ============================================================

test("MountStage: minimal profile produces valid docker args", () => {
  const { input, mountProbes } = makeInput();
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.includes("-v")).toEqual(true);
  expect(plan.dockerArgs.includes("-w")).toEqual(true);
  expect("NAS_USER" in plan.envVars).toEqual(true);
  expect("NAS_HOME" in plan.envVars).toEqual(true);
  expect("WORKSPACE" in plan.envVars).toEqual(true);
});

test("MountStage: display records shared memory size as structured state", () => {
  const { input, mountProbes } = makeInput({
    slices: {
      display: {
        enabled: true,
        displayNumber: 42,
        socketPath: "/run/nas/xpra/X42",
        xauthorityPath: "/run/nas/xpra/Xauthority",
      },
    },
  });

  const plan = planMount(input, mountProbes);

  expect(plan.containerPatch.shmSize).toBe("2g");
  expect(plan.containerPatch.extraRunArgs).not.toContain("--shm-size");
});

// ============================================================
// run() with MountSetupService fake
// ============================================================

test("MountStage run(): creates directories via MountSetupService and returns result", async () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true },
    agentState: { protectSettings: false, auth: "shared" },
  });
  const hostEnv: HostEnv = {
    ...defaultHostEnv,
    env: new Map([["XDG_CACHE_HOME", "/home/testuser/.cache"]]),
  };
  const probes: ProbeResults = {
    ...defaultProbeResults,
    hasHostNix: true,
  };
  const mountProbes = makeMountProbes({
    nixBinPath: "/nix/store/xxx/bin/nix",
  });
  const { sharedInput, slices } = makeInput({
    profile,
    mountProbes,
    hostEnv,
    probes,
    slices: { nix: { enabled: true } },
  });

  const createdDirs: MountDirectoryEntry[] = [];
  const layer = makeMountSetupServiceFake({
    ensureDirectories: (dirs) =>
      Effect.sync(() => {
        createdDirs.push(...dirs);
      }),
  });
  const stage = createMountStage(sharedInput, mountProbes);

  const scope = Effect.runSync(Scope.make());
  const effect = stage
    .run(slices)
    .pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(layer));
  const result = await Effect.runPromise(effect);
  await Effect.runPromise(Scope.close(scope, Exit.void));

  const createdPaths = createdDirs.map((d) => d.path);
  expect(createdPaths).not.toContain("/home/testuser/.cache/nas");
  expect(createdPaths).toContain("/home/testuser/.cache/nix");

  expect(result.container!.extraRunArgs).toBeDefined();
  expect(result.container!.env.static).toBeDefined();
  expect(result.container).toEqual({
    image: "nas-sandbox",
    workDir: TEST_WORK_DIR,
    mounts: [
      { source: TEST_WORK_DIR, target: TEST_WORK_DIR },
      { source: "/nix", target: "/nix" },
      {
        source: "/home/testuser/.cache/nix",
        target: `${CONTAINER_HOME}/.cache/nix`,
      },
    ],
    env: {
      static: {
        NAS_LOG_LEVEL: "info",
        NAS_USER: TEST_USER,
        NAS_HOME: CONTAINER_HOME,
        NAS_UID: "1000",
        NAS_GID: "1000",
        NIX_REMOTE: "daemon",
        NIX_ENABLED: "true",
        NIX_BIN_PATH: "/nix/store/xxx/bin/nix",
        WORKSPACE: TEST_WORK_DIR,
        PATH:
          `${CONTAINER_HOME}/.local/bin:` +
          "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
      dynamicOps: [],
    },
    extraHosts: [],
    namedVolumes: [],
    extraRunArgs: [],
    command: {
      agentCommand: [
        "bash",
        "-c",
        'curl -fsSL https://claude.ai/install.sh | bash && claude "$@"',
        "claude",
      ],
      extraArgs: [],
    },
    labels: {},
  });
  expect(result.container!.env.static.NAS_USER).toEqual(TEST_USER);
  expect(result.container!.env.static.NIX_ENABLED).toEqual("true");
});

test("MountStage run(): no directories when nix disabled", async () => {
  const { sharedInput, slices, mountProbes } = makeInput({
    profile: makeProfile({
      agentState: { protectSettings: false, auth: "shared" },
    }),
  });

  const createdDirs: MountDirectoryEntry[] = [];
  const layer = makeMountSetupServiceFake({
    ensureDirectories: (dirs) =>
      Effect.sync(() => {
        createdDirs.push(...dirs);
      }),
  });
  const stage = createMountStage(sharedInput, mountProbes);

  const scope = Effect.runSync(Scope.make());
  const effect = stage
    .run(slices)
    .pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(layer));
  const result = await Effect.runPromise(effect);
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(createdDirs.length).toEqual(0);
  expect(result.container!.extraRunArgs).toBeDefined();
  expect(result.container!.env.static).toBeDefined();
  expect(result.container!.env.static.NAS_USER).toEqual(TEST_USER);
});

test("MountStage run(): preserves structured base container state", async () => {
  const mountProbes = makeMountProbes({});
  const profile = makeProfile({
    agentState: { protectSettings: false, auth: "shared" },
  });
  const { sharedInput, slices } = makeInput({
    profile,
    mountProbes,
    slices: {
      container: {
        image: "slice-image",
        workDir: "/slice/workdir",
        mounts: [{ source: "/structured/src", target: "/structured/dst" }],
        namedVolumes: [],
        env: {
          static: { STRUCTURED_ONLY: "1" },
          dynamicOps: [],
        },
        extraHosts: [],
        extraRunArgs: ["--structured-flag"],
        command: { agentCommand: ["legacy-agent"], extraArgs: [] },
        labels: {},
      },
    },
  });

  const layer = makeMountSetupServiceFake();
  const stage = createMountStage(sharedInput, mountProbes);

  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run(slices)
      .pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(layer)),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(result.container!.mounts).toEqual([
    { source: "/structured/src", target: "/structured/dst" },
    { source: TEST_WORK_DIR, target: TEST_WORK_DIR },
  ]);
  expect(result.container!.extraRunArgs).toEqual(["--structured-flag"]);
  expect(result.container!.env.static).toEqual({
    STRUCTURED_ONLY: "1",
    NAS_USER: TEST_USER,
    NAS_HOME: CONTAINER_HOME,
    NAS_UID: "1000",
    NAS_GID: "1000",
    WORKSPACE: TEST_WORK_DIR,
    PATH:
      `${CONTAINER_HOME}/.local/bin:` +
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  });
});

for (const enabled of [false, true]) {
  for (const data of [null, "/host/data/direnv"]) {
    test(`MountStage: native direnv approvals enabled=${enabled} data=${data}`, () => {
      const { input, mountProbes } = makeInput({
        profile: makeProfile({ direnv: { enable: enabled } }),
        mountProbes: makeMountProbes({ direnvDataDir: data }),
      });
      const plan = planMount(input, mountProbes);
      if (enabled) expect(plan.envVars.NAS_DIRENV_ENABLED).toBe("true");
      else expect(plan.envVars.NAS_DIRENV_ENABLED).toBeUndefined();
      expect(plan.containerPatch.mounts).toContainEqual({
        source: TEST_WORK_DIR,
        target: TEST_WORK_DIR,
      });
      const approvals = plan.containerPatch.mounts?.filter(
        (m) => m.source === data,
      );
      expect(approvals).toEqual(
        enabled && data
          ? [
              {
                source: data,
                target: `${CONTAINER_HOME}/.local/share/direnv`,
                readOnly: true,
              },
            ]
          : [],
      );
      expect(plan.dockerArgs.join(" ")).not.toContain(".config/direnv");
    });
  }
}
for (const [value, target] of [
  ["/custom/data", "/custom/data"],
  ["~/data", `${CONTAINER_HOME}/data`],
  ["data", `${TEST_WORK_DIR}/data`],
  ["", `${CONTAINER_HOME}/.local/share`],
]) {
  test(`MountStage: direnv uses resolved static XDG_DATA_HOME ${value}`, () => {
    const { input, mountProbes } = makeInput({
      profile: makeProfile({ direnv: { enable: true } }),
      mountProbes: makeMountProbes({
        direnvDataDir: "/host/data/direnv",
        resolvedEnvEntries: [envEntry("XDG_DATA_HOME", value)],
      }),
    });
    const plan = planMount(input, mountProbes);
    expect(plan.containerPatch.mounts).toContainEqual({
      source: "/host/data/direnv",
      target: `${target}/direnv`,
      readOnly: true,
    });
    if (value) expect(plan.envVars.XDG_DATA_HOME).toBe(target);
  });
}

test("MountStage: dynamic XDG_DATA_HOME operations do not move startup approvals", () => {
  const { input, mountProbes } = makeInput({
    profile: makeProfile({ direnv: { enable: true } }),
    mountProbes: makeMountProbes({
      direnvDataDir: "/host/data/direnv",
      resolvedEnvEntries: [
        envEntry("XDG_DATA_HOME", "/later", "suffix", { separator: ":" }),
      ],
    }),
  });
  const plan = planMount(input, mountProbes);
  expect(plan.containerPatch.mounts).toContainEqual({
    source: "/host/data/direnv",
    target: `${CONTAINER_HOME}/.local/share/direnv`,
    readOnly: true,
  });
  expect(plan.envVars.XDG_DATA_HOME).toBeUndefined();
  expect(plan.containerPatch.env?.dynamicOps).toHaveLength(1);
});

for (const value of ["~/../outside", "../outside"]) {
  test(`MountStage: direnv data path obeys container path boundaries (${value})`, () => {
    const { input, mountProbes } = makeInput({
      profile: makeProfile({ direnv: { enable: true } }),
      mountProbes: makeMountProbes({
        direnvDataDir: "/host/data/direnv",
        resolvedEnvEntries: [envEntry("XDG_DATA_HOME", value)],
      }),
    });
    expect(() => planMount(input, mountProbes)).toThrow("escapes");
  });
}

const ideMounts = {
  vscodeDir: "/state:$x/vscode",
  claudeState: {
    claudeDir: "/state:$x/claude",
    claudeJson: "/state:$x/claude.json",
  },
};
test("IDE mounts dedicated state and managed config", () => {
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ gitConfigExists: true }),
  });
  const plan = planMount(input, mountProbes, ideMounts);
  expect(plan.containerPatch.mounts).toContainEqual({
    source: ideMounts.claudeState.claudeDir,
    target: `${CONTAINER_HOME}/.claude`,
  });
  expect(plan.containerPatch.mounts).toContainEqual({
    source: ideMounts.vscodeDir,
    target: `${CONTAINER_HOME}/.vscode-server`,
  });
  expect(plan.containerPatch.mounts).toContainEqual({
    source: `${TEST_WORK_DIR}/.devcontainer`,
    target: `${TEST_WORK_DIR}/.devcontainer`,
    readOnly: true,
  });
});

// IDE launches used to withhold this mount even when a plain CLI launch would
// include it; that gap is intentionally closed so both paths behave the same.
test("IDE mounts host git config same as a plain CLI launch", () => {
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ gitConfigExists: true }),
  });
  const plan = planMount(input, mountProbes, ideMounts);
  expect(plan.containerPatch.mounts).toContainEqual({
    source: `${TEST_HOME}/.config/git`,
    target: `${CONTAINER_HOME}/.config/git`,
    readOnly: true,
  });
});
test("IDE shares the main repository root of a worktree, same as a plain CLI launch", () => {
  const workDir = "/repo/worktrees/one";
  const { input, mountProbes } = makeInput({
    slices: { workspace: { workDir, imageName: "nas", maskedRoot: "/masked" } },
    mountProbes: makeMountProbes({
      gitWorktreeMainRoot: "/repo",
      localConfigPaths: [`${workDir}/.nas/config.pkl`],
    }),
  });
  const ide = planMount(input, mountProbes, ideMounts);
  const cli = planMount(input, mountProbes);
  const repoMount = { source: "/masked", target: "/repo" };
  expect(ide.containerPatch.mounts).toContainEqual(repoMount);
  expect(cli.containerPatch.mounts).toContainEqual(repoMount);
  expect(ide.containerPatch.mounts).toContainEqual({
    source: "/masked/worktrees/one/.nas",
    target: `${workDir}/.nas`,
    readOnly: true,
  });
});

test("IDE mounts codex state read-write next to the IDE server dir", () => {
  const { input, mountProbes } = makeInput({
    profile: makeProfile({
      agent: "codex",
      agentState: { protectSettings: true },
    }),
    mountProbes: makeMountProbes({
      agentProbes: {
        codexDirExists: true,
        codexBinPath: "/host/codex",
        codexCodeModeHostBinPath: null,
        codexSettingsFiles: ["config.toml"],
      },
    }),
  });
  const plan = planMount(input, mountProbes, {
    vscodeDir: "/state:$x/vscode",
    codexState: { codexDir: "/state:$x/codex" },
  });
  expect(plan.containerPatch.mounts).toContainEqual({
    source: "/state:$x/codex",
    target: `${CONTAINER_HOME}/.codex`,
  });
  expect(plan.containerPatch.mounts).toContainEqual({
    source: "/state:$x/codex/config.toml",
    target: `${CONTAINER_HOME}/.codex/config.toml`,
    readOnly: true,
  });
  expect(plan.containerPatch.mounts).toContainEqual({
    source: "/state:$x/vscode",
    target: `${CONTAINER_HOME}/.vscode-server`,
  });
  // The host codex binary is deliberately not mounted for IDE sessions.
  expect(plan.dockerArgs.join(" ")).not.toContain("/host/codex");
});

test("IDE with maskfs refuses a linked worktree outside the main repository root", () => {
  const workDir = "/repo-linked/worktrees/one";
  const { input, mountProbes } = makeInput({
    slices: { workspace: { workDir, imageName: "nas", maskedRoot: "/masked" } },
    mountProbes: makeMountProbes({
      gitWorktreeMainRoot: "/repo",
      localConfigPaths: [`${workDir}/.nas/config.pkl`],
    }),
  });
  // workDir が mountSource (/repo) の外にあるとマスク済みビューに対応する
  // ソースが無い。`..` で maskedRoot を脱出したゴミパスを bind する代わりに
  // 明示的なエラーにする。
  expect(() => planMount(input, mountProbes, ideMounts)).toThrow(
    "beneath the mounted root",
  );
});

test("MountStage run(): prepares protected Claude state before planning and retains it until scope closes", async () => {
  const mountProbes = makeMountProbes();
  const { sharedInput, slices } = makeInput({
    profile: makeProfile({
      agentState: { protectSettings: true, auth: "shared" },
    }),
    mountProbes,
  });
  const prepared = {
    runtimeDir: "/private/claude",
    claudeJson: `${TEST_HOME}/.claude.json`,
    entries: [],
  };
  const events: string[] = [];
  const layer = makeMountSetupServiceFake({
    prepareClaudeState: (home) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          expect(home).toBe(TEST_HOME);
          events.push("prepare");
          return prepared;
        }),
        () =>
          Effect.sync(() => {
            events.push("release");
          }),
      ),
    ensureDirectories: () =>
      Effect.sync(() => {
        events.push("directories");
      }),
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* createMountStage(sharedInput, mountProbes).run(
          slices,
        );
        expect(result.container.mounts).toContainEqual({
          source: prepared.runtimeDir,
          target: `${CONTAINER_HOME}/.claude`,
        });
        expect(events).toEqual(["prepare", "directories"]);
      }),
    ).pipe(Effect.provide(layer)),
  );
  expect(events).toEqual(["prepare", "directories", "release"]);
});

test("MountStage run(): a failed protected-state preparation cannot fall back to RW sharing", async () => {
  const mountProbes = makeMountProbes();
  const { sharedInput, slices } = makeInput({
    profile: makeProfile({ agentState: { protectSettings: true } }),
    mountProbes,
  });
  let created = false;
  const layer = makeMountSetupServiceFake({
    prepareClaudeState: () => Effect.fail(new Error("invalid shared path")),
    ensureDirectories: () =>
      Effect.sync(() => {
        created = true;
      }),
  });
  await expect(
    Effect.runPromise(
      createMountStage(sharedInput, mountProbes)
        .run(slices)
        .pipe(Effect.provide(layer), Effect.scoped),
    ),
  ).rejects.toThrow("invalid shared path");
  expect(created).toBe(false);
});

for (const protectSettings of [true, false] as const) {
  test(`MountStage run(): proxied Claude credentials use the private root (protectSettings=${protectSettings})`, async () => {
    const mountProbes = makeMountProbes();
    const { sharedInput, slices } = makeInput({
      profile: makeProfile({ agentState: { protectSettings } }),
      mountProbes,
    });
    const prepared = {
      runtimeDir: "/private/claude-state",
      claudeJson: `${TEST_HOME}/.claude.json`,
      entries: [],
    };
    let receivedOptions: unknown;
    const events: string[] = [];
    const layer = makeMountSetupServiceFake({
      prepareClaudeState: (home, options) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            expect(home).toBe(TEST_HOME);
            receivedOptions = options;
            events.push("prepare-state");
            return prepared;
          }),
          () =>
            Effect.sync(() => {
              events.push("release-state");
            }),
        ),
      prepareClaudeCredentials: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push("prepare-credentials");
            return "/private/dummy/.credentials.json";
          }),
          () =>
            Effect.sync(() => {
              events.push("release-credentials");
            }),
        ),
      ensureDirectories: () => Effect.void,
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        createMountStage(sharedInput, mountProbes).run(slices),
      ).pipe(Effect.provide(layer)),
    );
    // Proxied credentials always share a session-private root; protectSettings
    // only decides whether that root also protects the rest of ~/.claude.
    expect(receivedOptions).toEqual({
      shareCredentials: false,
      protectSettings,
    });
    // The dummy must land after the runtime-root mount in the final mount
    // list — it overrides one entry inside that root, not a bare directory.
    const mounts = result.container?.mounts ?? [];
    const runtimeRootIndex = mounts.findIndex(
      (m) => m.source === prepared.runtimeDir,
    );
    const dummyIndex = mounts.findIndex(
      (m) => m.source === "/private/dummy/.credentials.json",
    );
    expect(runtimeRootIndex).toBeGreaterThanOrEqual(0);
    expect(mounts[runtimeRootIndex]).toEqual({
      source: prepared.runtimeDir,
      target: `${CONTAINER_HOME}/.claude`,
    });
    expect(mounts[dummyIndex]).toEqual({
      source: "/private/dummy/.credentials.json",
      target: `${CONTAINER_HOME}/.claude/.credentials.json`,
    });
    expect(dummyIndex).toBeGreaterThan(runtimeRootIndex);
    expect(events).toEqual([
      "prepare-state",
      "prepare-credentials",
      "release-credentials",
      "release-state",
    ]);
  });
}

test("MountStage run(): shared Claude credentials do not prepare a dummy file", async () => {
  const mountProbes = makeMountProbes();
  const { sharedInput, slices } = makeInput({
    profile: makeProfile({
      agentState: { protectSettings: false, auth: "shared" },
    }),
    mountProbes,
  });
  const layer = makeMountSetupServiceFake({
    ensureDirectories: () => Effect.void,
  });
  // prepareClaudeCredentials fake is deliberately absent: dying if it were
  // called is how this test proves the dummy file is not prepared.
  await Effect.runPromise(
    Effect.scoped(createMountStage(sharedInput, mountProbes).run(slices)).pipe(
      Effect.provide(layer),
    ),
  );
});

test("MountStage: proxied Codex credentials hide the host auth.json behind the dummy", () => {
  const profile = makeProfile({ agent: "codex" });
  const mountProbes = makeMountProbes({
    agentProbes: {
      codexDirExists: true,
      codexBinPath: "/usr/bin/codex",
      codexCodeModeHostBinPath: null,
      codexSettingsFiles: [],
    },
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(
    input,
    mountProbes,
    undefined,
    undefined,
    undefined,
    "/tmp/nas-codex-credentials-x/auth.json",
  );
  const targets = plan.containerPatch.mounts!.map((m) => m.target);
  const dirIndex = targets.indexOf(`${CONTAINER_HOME}/.codex`);
  const authIndex = targets.indexOf(`${CONTAINER_HOME}/.codex/auth.json`);
  expect(dirIndex).toBeGreaterThanOrEqual(0);
  expect(authIndex).toBeGreaterThan(dirIndex);
});

test("MountStage: an extra Claude receives the dummy credentials file", () => {
  const profile = makeProfile({ agent: "codex", extraAgents: ["claude"] });
  const mountProbes = makeMountProbes({
    agentProbes: {
      codexDirExists: true,
      codexBinPath: "/usr/bin/codex",
      codexCodeModeHostBinPath: null,
      codexSettingsFiles: [],
    },
    extraAgentProbes: [{ agent: "claude", probes: defaultClaudeProbes }],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(
    input,
    mountProbes,
    undefined,
    {
      runtimeDir: "/private/claude",
      claudeJson: "/private/claude.json",
      entries: [],
    },
    "/tmp/nas-claude-credentials-x/.credentials.json",
  );
  const targets = plan.containerPatch.mounts!.map((m) => m.target);
  expect(targets).toContain(`${CONTAINER_HOME}/.claude/.credentials.json`);
});

test("MountStage: run prepares the dummy auth.json for a proxied Codex", async () => {
  const profile = makeProfile({ agent: "codex" });
  const mountProbes = makeMountProbes({
    agentProbes: {
      codexDirExists: true,
      codexBinPath: "/usr/bin/codex",
      codexCodeModeHostBinPath: null,
      codexSettingsFiles: [],
    },
  });
  const { sharedInput, slices } = makeInput({ profile, mountProbes });
  const prepared: string[] = [];
  const layer = makeMountSetupServiceFake({
    prepareCodexCredentials: (home) =>
      Effect.sync(() => {
        prepared.push(home);
        return "/tmp/nas-codex-credentials-x/auth.json";
      }),
  });
  const result = await Effect.runPromise(
    Effect.scoped(
      createMountStage(sharedInput, mountProbes)
        .run(slices)
        .pipe(Effect.provide(layer)),
    ),
  );
  expect(prepared).toEqual([TEST_HOME]);
  expect(result.container!.mounts.map((m) => m.target)).toContain(
    `${CONTAINER_HOME}/.codex/auth.json`,
  );
});
