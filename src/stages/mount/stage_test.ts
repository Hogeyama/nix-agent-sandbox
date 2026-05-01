import { expect, test } from "bun:test";

/**
 * MountStage の純粋ロジックテスト (unit test)
 *
 * planMount() は純粋関数なので、HostEnv / ProbeResults / MountProbes を
 * リテラルで組み立てて渡す。実行環境に依存しない。
 * run() テストは MountSetupService fake を使う。
 */

import { Effect, Exit, Scope } from "effect";
import type { ClaudeProbes } from "../../agents/claude.ts";
import type { CodexProbes } from "../../agents/codex.ts";
import type { CopilotProbes } from "../../agents/copilot.ts";
import type { Config, Profile } from "../../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
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
import {
  createMountStage,
  planMount,
  serializeNixExtraPackages,
} from "./stage.ts";

// ============================================================
// テスト用ヘルパー — 全て純粋なリテラル構築
// ============================================================

const TEST_HOME = "/home/testuser";
const TEST_USER = "testuser";
const CONTAINER_HOME = `/home/${TEST_USER}`;
const TEST_WORK_DIR = "/workspace/project";

type NetworkOverrides = Partial<Omit<Profile["network"], "prompt">> & {
  prompt?: Partial<Profile["network"]["prompt"]>;
};

type ProfileOverrides = Omit<Partial<Profile>, "network"> & {
  network?: NetworkOverrides;
};

function makeProfile(overrides: ProfileOverrides = {}): Profile {
  const baseNetwork = structuredClone(DEFAULT_NETWORK_CONFIG);
  const { network, ...rest } = overrides;
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    network: {
      ...baseNetwork,
      ...network,
      prompt: {
        ...baseNetwork.prompt,
        ...network?.prompt,
      },
    },
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
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
  gpgAgentSocket: null,
  auditDir: "/tmp/audit",
};

const defaultClaudeProbes: ClaudeProbes = {
  claudeDirExists: false,
  claudeJsonExists: false,
  claudeBinPath: null,
};

function makeMountProbes(overrides: Partial<MountProbes> = {}): MountProbes {
  return {
    agentProbes: defaultClaudeProbes,
    nixConfRealPath: null,
    nixBinPath: null,
    gitConfigExists: false,
    gcloudConfigExists: false,
    gpgSocketExists: false,
    gpgConfExists: false,
    gpgAgentConfExists: false,
    gpgPubringExists: false,
    gpgTrustdbExists: false,
    awsConfigExists: false,
    resolvedExtraMounts: [],
    resolvedEnvEntries: [],
    gitWorktreeMainRoot: null,
    xpraBinPath: null,
    takenX11Displays: new Set<number>(),
    x11UnixDirReadOnly: false,
    localConfigPaths: [],
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
    keySource?: "key" | "key_cmd";
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

test("MountStage: invalid dynamic key (key_cmd source)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("BAD KEY", "value", "set", { keySource: "key_cmd" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  expect(() => planMount(input, mountProbes)).toThrow("Invalid env var name");
});

test("MountStage: multiple env vars including both static and dynamic", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("STATIC_A", "a", "set", { index: 0 }),
      envEntry("DYNAMIC_B", "b", "set", { index: 1, keySource: "key_cmd" }),
      envEntry("STATIC_C", "c", "set", { index: 2 }),
      envEntry("DYNAMIC_D", "d", "set", { index: 3, keySource: "key_cmd" }),
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
// serializeNixExtraPackages
// ============================================================

test("serializeNixExtraPackages: single package", () => {
  expect(serializeNixExtraPackages(["nixpkgs#gh"])).toEqual("nixpkgs#gh");
});

test("serializeNixExtraPackages: multiple packages", () => {
  expect(
    serializeNixExtraPackages(["nixpkgs#gh", "nixpkgs#ripgrep", "nixpkgs#fd"]),
  ).toEqual("nixpkgs#gh\nnixpkgs#ripgrep\nnixpkgs#fd");
});

test("serializeNixExtraPackages: trims whitespace", () => {
  expect(serializeNixExtraPackages(["  nixpkgs#gh  ", " nixpkgs#fd "])).toEqual(
    "nixpkgs#gh\nnixpkgs#fd",
  );
});

test("serializeNixExtraPackages: filters empty strings", () => {
  expect(
    serializeNixExtraPackages(["nixpkgs#gh", "", "  ", "nixpkgs#fd"]),
  ).toEqual("nixpkgs#gh\nnixpkgs#fd");
});

test("serializeNixExtraPackages: all empty returns null", () => {
  expect(serializeNixExtraPackages([""])).toEqual(null);
  expect(serializeNixExtraPackages(["  ", "   "])).toEqual(null);
  expect(serializeNixExtraPackages([])).toEqual(null);
});

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

test("MountStage: GPG not mounted when disabled", () => {
  const profile = makeProfile({ gpg: { forwardAgent: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.some((a: string) => a.includes("S.gpg-agent")),
  ).toEqual(false);
  expect("GPG_AGENT_INFO" in plan.envVars).toEqual(false);
});

test("MountStage: GPG socket mounted when enabled and socket exists", () => {
  const gpgSocket = "/run/user/1000/gnupg/S.gpg-agent";
  const profile = makeProfile({ gpg: { forwardAgent: true } });
  const mountProbes = makeMountProbes({
    gpgSocketExists: true,
    gpgConfExists: true,
    gpgAgentConfExists: true,
    gpgPubringExists: true,
    gpgTrustdbExists: true,
  });
  const probes: ProbeResults = {
    ...defaultProbeResults,
    gpgAgentSocket: gpgSocket,
  };
  const { input } = makeInput({ profile, mountProbes, probes });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.some((a: string) => a.includes("S.gpg-agent")),
  ).toEqual(true);
  expect(plan.envVars.GPG_AGENT_INFO).toEqual(
    `${CONTAINER_HOME}/.gnupg/S.gpg-agent`,
  );
  expect(plan.dockerArgs.some((a: string) => a.includes("gpg.conf"))).toEqual(
    true,
  );
  expect(
    plan.dockerArgs.some((a: string) => a.includes("gpg-agent.conf")),
  ).toEqual(true);
  expect(
    plan.dockerArgs.some((a: string) => a.includes("pubring.kbx")),
  ).toEqual(true);
  expect(
    plan.dockerArgs.some((a: string) => a.includes("trustdb.gpg")),
  ).toEqual(true);
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
    nix: { enable: false, mountSocket: true, extraPackages: [] },
  });
  const { input, mountProbes } = makeInput({ profile });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.includes("/nix:/nix")).toEqual(false);
  expect("NIX_REMOTE" in plan.envVars).toEqual(false);
});

test("MountStage: nix enabled but mountSocket false skips socket", () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: false, extraPackages: [] },
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
    nix: { enable: true, mountSocket: true, extraPackages: [] },
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
    nix: { enable: true, mountSocket: true, extraPackages: [] },
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

test("MountStage: nix extra-packages set when nix enabled and host has nix", () => {
  const profile = makeProfile({
    nix: {
      enable: true,
      mountSocket: true,
      extraPackages: ["nixpkgs#gh", "nixpkgs#jq"],
    },
  });
  const probes: ProbeResults = { ...defaultProbeResults, hasHostNix: true };
  const { input, mountProbes } = makeInput({
    profile,
    probes,
    slices: { nix: { enabled: true } },
  });
  const plan = planMount(input, mountProbes);
  expect(plan.envVars.NIX_EXTRA_PACKAGES).toEqual("nixpkgs#gh\nnixpkgs#jq");
});

test("MountStage: nix conf outside /nix is mounted to temp path", () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true, extraPackages: [] },
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
    nix: { enable: true, mountSocket: true, extraPackages: [] },
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

test("MountStage: gcloud not mounted when disabled", () => {
  const profile = makeProfile({ gcloud: { mountConfig: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.some((a: string) => a.includes(".config/gcloud")),
  ).toEqual(false);
});

test("MountStage: gcloud mounted when enabled and exists", () => {
  const profile = makeProfile({ gcloud: { mountConfig: true } });
  const mountProbes = makeMountProbes({ gcloudConfigExists: true });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(
    plan.dockerArgs.some((a: string) => a.includes(".config/gcloud")),
  ).toEqual(true);
});

test("MountStage: aws not mounted when disabled", () => {
  const profile = makeProfile({ aws: { mountConfig: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.some((a: string) => a.includes(".aws"))).toEqual(
    false,
  );
});

test("MountStage: aws mounted when enabled and exists", () => {
  const profile = makeProfile({ aws: { mountConfig: true } });
  const mountProbes = makeMountProbes({ awsConfigExists: true });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs.some((a: string) => a.includes(".aws"))).toEqual(true);
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

test("MountStage: copilot agent sets agentCommand", () => {
  const copilotProbes: CopilotProbes = {
    copilotBinPath: "/usr/bin/copilot",
    copilotLegacyDirExists: false,
  };
  const profile = makeProfile({ agent: "copilot" });
  const mountProbes = makeMountProbes({ agentProbes: copilotProbes });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.containerPatch.command!.agentCommand).toEqual(["copilot"]);
});

test("MountStage: codex agent sets agentCommand", () => {
  const codexProbes: CodexProbes = {
    codexDirExists: false,
    codexBinPath: "/usr/bin/codex",
  };
  const profile = makeProfile({ agent: "codex" });
  const mountProbes = makeMountProbes({ agentProbes: codexProbes });
  const { input } = makeInput({ profile, mountProbes });
  const plan = planMount(input, mountProbes);
  expect(plan.containerPatch.command!.agentCommand).toEqual(["codex"]);
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
// .agent-sandbox.{yml,nix} RO bind mount (改ざん防止)
// ============================================================

test("MountStage: .agent-sandbox.yml inside mountSource is RO bind mounted", () => {
  const configPath = `${TEST_WORK_DIR}/.agent-sandbox.yml`;
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

test("MountStage: both .agent-sandbox.yml and .nix are RO bind mounted when both exist", () => {
  const ymlPath = `${TEST_WORK_DIR}/.agent-sandbox.yml`;
  const nixPath = `${TEST_WORK_DIR}/.agent-sandbox.nix`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ localConfigPaths: [ymlPath, nixPath] }),
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs).toContain(`${ymlPath}:${ymlPath}:ro`);
  expect(plan.dockerArgs).toContain(`${nixPath}:${nixPath}:ro`);
});

test("MountStage: config path outside mountSource is skipped", () => {
  // workspace = /workspace/project だが、config は /etc/other/.agent-sandbox.yml
  // (mountSource 外なのでコンテナからは見えない → RO mount する必要もない)
  const outsidePath = "/etc/other/.agent-sandbox.yml";
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ localConfigPaths: [outsidePath] }),
  });
  const plan = planMount(input, mountProbes);
  expect(plan.dockerArgs).not.toContain(`${outsidePath}:${outsidePath}:ro`);
});

test("MountStage: with gitWorktreeMainRoot, config within main root is RO mounted", () => {
  // worktree 内にいるが、config は本体リポジトリルート直下にある
  const mainRoot = "/repo";
  const configPath = `${mainRoot}/.agent-sandbox.yml`;
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
  const configPath = `${TEST_WORK_DIR}/.agent-sandbox.yml`;
  const { input, mountProbes } = makeInput({
    mountProbes: makeMountProbes({ localConfigPaths: [configPath] }),
  });
  const plan = planMount(input, mountProbes);
  const wsIdx = plan.dockerArgs.indexOf(`${TEST_WORK_DIR}:${TEST_WORK_DIR}`);
  const configIdx = plan.dockerArgs.indexOf(`${configPath}:${configPath}:ro`);
  expect(wsIdx).toBeGreaterThanOrEqual(0);
  expect(configIdx).toBeGreaterThan(wsIdx);
});

test("MountStage: structured workspace, nix, and dbus slices drive planning", () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true, extraPackages: [] },
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
        env: {
          static: { EXISTING_ENV: "1" },
          dynamicOps: [],
        },
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
      "curl -fsSL https://claude.ai/install.sh | bash && claude",
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

// ============================================================
// run() with MountSetupService fake
// ============================================================

test("MountStage run(): creates directories via MountSetupService and returns result", async () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true, extraPackages: [] },
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
  expect(createdPaths).toContain("/home/testuser/.cache/nas");
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
        source: "/home/testuser/.cache/nas",
        target: `${CONTAINER_HOME}/.cache/nas`,
      },
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
    extraRunArgs: [],
    command: {
      agentCommand: [
        "bash",
        "-c",
        "curl -fsSL https://claude.ai/install.sh | bash && claude",
      ],
      extraArgs: [],
    },
    labels: {},
  });
  expect(result.container!.env.static.NAS_USER).toEqual(TEST_USER);
  expect(result.container!.env.static.NIX_ENABLED).toEqual("true");
});

test("MountStage run(): no directories when nix disabled", async () => {
  const { sharedInput, slices, mountProbes } = makeInput();

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
  const mountProbes = makeMountProbes({
    gcloudConfigExists: true,
  });
  const profile = makeProfile({
    gcloud: { mountConfig: true },
  });
  const { sharedInput, slices } = makeInput({
    profile,
    mountProbes,
    slices: {
      container: {
        image: "slice-image",
        workDir: "/slice/workdir",
        mounts: [{ source: "/structured/src", target: "/structured/dst" }],
        env: {
          static: { STRUCTURED_ONLY: "1" },
          dynamicOps: [],
        },
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
    {
      source: `${TEST_HOME}/.config/gcloud`,
      target: `${CONTAINER_HOME}/.config/gcloud`,
    },
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
