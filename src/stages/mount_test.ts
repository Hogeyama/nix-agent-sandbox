import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
/**
 * MountStage の純粋ロジックテスト (unit test)
 *
 * plan() は純粋関数なので、HostEnv / ProbeResults / MountProbes を
 * リテラルで組み立てて渡す。実行環境に依存しない。
 */

import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import {
  createMountStage,
  encodeDynamicEnvOps,
  serializeNixExtraPackages,
} from "./mount.ts";
import type { MountProbes, ResolvedEnvEntry } from "./mount_probes.ts";
import type { Config, Profile } from "../config/types.ts";
import type {
  HostEnv,
  PriorStageOutputs,
  ProbeResults,
  StageInput,
} from "../pipeline/types.ts";
import type { ClaudeProbes } from "../agents/claude.ts";
import type { CopilotProbes } from "../agents/copilot.ts";
import type { CodexProbes } from "../agents/codex.ts";

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
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: {
      ...baseNetwork,
      ...network,
      prompt: {
        ...baseNetwork.prompt,
        ...network?.prompt,
      },
    },
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
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
    x11SocketDirExists: false,
    xauthorityExists: false,
    xauthorityPath: `${TEST_HOME}/.Xauthority`,
    resolvedExtraMounts: [],
    resolvedEnvEntries: [],
    ...overrides,
  };
}

const baseConfig: Config = {
  default: "test",
  profiles: { test: makeProfile() },
  ui: DEFAULT_UI_CONFIG,
};

function makePrior(
  overrides: Partial<PriorStageOutputs> = {},
): PriorStageOutputs {
  return {
    dockerArgs: [],
    envVars: { NAS_LOG_LEVEL: "info" },
    workDir: TEST_WORK_DIR,
    nixEnabled: false,
    imageName: "nas-sandbox",
    agentCommand: [],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
    ...overrides,
  };
}

function makeInput(
  opts: {
    profile?: Profile;
    mountProbes?: MountProbes;
    hostEnv?: HostEnv;
    probes?: ProbeResults;
    prior?: Partial<PriorStageOutputs>;
  } = {},
): { input: StageInput; mountProbes: MountProbes } {
  const profile = opts.profile ?? makeProfile();
  const mountProbes = opts.mountProbes ?? makeMountProbes();
  return {
    input: {
      config: baseConfig,
      profile,
      profileName: "test",
      sessionId: "sess_test",
      host: opts.hostEnv ?? defaultHostEnv,
      probes: opts.probes ?? defaultProbeResults,
      prior: makePrior(opts.prior),
    },
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
  return {
    key,
    value,
    mode,
    separator: opts.separator,
    index: opts.index ?? 0,
    keySource: opts.keySource ?? "key",
  };
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["SIMPLE"]).toEqual("value");
  expect(plan.envVars["_UNDERSCORE_START"]).toEqual("value");
  expect(plan.envVars["WITH_123_NUMBERS"]).toEqual("value");
  expect(plan.envVars["A"]).toEqual("single-char");
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["URL"]).toEqual(
    "https://example.com/path?foo=bar&baz=qux",
  );
  expect(plan.envVars["JSON"]).toEqual('{"key": "value"}');
  expect(plan.envVars["SPACES"]).toEqual("hello world");
  expect(plan.envVars["EMPTY"]).toEqual("");
});

test("MountStage: invalid static env key (starts with number)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [envEntry("123BAD", "value")],
  });
  const { input } = makeInput({ mountProbes });
  expect(() => createMountStage(mountProbes).plan(input)).toThrow(
    "Invalid env var name",
  );
});

test("MountStage: invalid static env key (contains dash)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [envEntry("MY-VAR", "value")],
  });
  const { input } = makeInput({ mountProbes });
  expect(() => createMountStage(mountProbes).plan(input)).toThrow(
    "Invalid env var name",
  );
});

test("MountStage: invalid static env key (contains dot)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [envEntry("MY.VAR", "value")],
  });
  const { input } = makeInput({ mountProbes });
  expect(() => createMountStage(mountProbes).plan(input)).toThrow(
    "Invalid env var name",
  );
});

test("MountStage: invalid dynamic key (key_cmd source)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("BAD KEY", "value", "set", { keySource: "key_cmd" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  expect(() => createMountStage(mountProbes).plan(input)).toThrow(
    "Invalid env var name",
  );
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["STATIC_A"]).toEqual("a");
  expect(plan.envVars["DYNAMIC_B"]).toEqual("b");
  expect(plan.envVars["STATIC_C"]).toEqual("c");
  expect(plan.envVars["DYNAMIC_D"]).toEqual("d");
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["MY_PATH"]).toEqual("/opt/bin:/usr/bin");
});

test("MountStage: suffix mode appends to existing var", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("MY_PATH", "/usr/bin", "set", { index: 0 }),
      envEntry("MY_PATH", "/opt/lib", "suffix", { index: 1, separator: ":" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["MY_PATH"]).toEqual("/usr/bin:/opt/lib");
});

test("MountStage: prefix on unset var generates NAS_ENV_OPS", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("NEW_VAR", "/opt/bin", "prefix", { index: 0, separator: ":" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["NEW_VAR"]).toBeUndefined();
  expect(plan.envVars["NAS_ENV_OPS"]).toEqual(
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["NEW_VAR"]).toBeUndefined();
  expect(plan.envVars["NAS_ENV_OPS"]).toEqual(
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["MY_PATH"]).toBeUndefined();
  expect(plan.envVars["NAS_ENV_OPS"]).toEqual(
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["FLAGS"]).toEqual("-O2 -Wall");
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["MY_PATH"]).toEqual("/opt/dynamic:/usr/bin");
});

test("MountStage: set after prefix replaces entire value", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("MY_PATH", "/opt/bin", "prefix", { index: 0, separator: ":" }),
      envEntry("MY_PATH", "/only/this", "set", { index: 1 }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["MY_PATH"]).toEqual("/only/this");
  expect(plan.envVars["NAS_ENV_OPS"]).toBeUndefined();
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
  const plan = createMountStage(mountProbes).plan(input)!;
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
  const plan = createMountStage(mountProbes).plan(input)!;
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
  const plan = createMountStage(mountProbes).plan(input)!;
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(
    plan.dockerArgs.includes(`/dev/null:${TEST_WORK_DIR}/.env:ro`),
  ).toEqual(true);
});

test("MountStage: extra-mount to /nix conflicts", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/some/dir", dst: "/nix", mode: "ro" }],
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
  expect(() => createMountStage(mountProbes).plan(input)).toThrow(
    "conflicts with existing mount destination",
  );
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(
    plan.dockerArgs.some((a: string) => a.includes(":/var/run/docker.sock")),
  ).toEqual(true);
});

test("MountStage: extra-mount to workspace dir conflicts", () => {
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
  expect(() => createMountStage(mountProbes).plan(input)).toThrow(
    "conflicts with existing mount destination",
  );
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(
    plan.dockerArgs.includes(`/dev/null:${TEST_WORK_DIR}/.env:ro`),
  ).toEqual(true);
});

test("MountStage: extra-mount directory under workspace dir conflicts", () => {
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
  expect(() => createMountStage(mountProbes).plan(input)).toThrow(
    "conflicts with existing mount destination",
  );
});

test("MountStage: extra-mount duplicate dst conflicts", () => {
  const profile = makeProfile({
    extraMounts: [
      { src: "/a", dst: "/mnt/dup", mode: "ro" },
      { src: "/b", dst: "/mnt/dup", mode: "rw" },
    ],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [
      {
        normalizedSrc: "/a",
        srcExists: true,
        srcIsDirectory: true,
        mode: "ro",
        index: 0,
      },
      {
        normalizedSrc: "/b",
        srcExists: true,
        srcIsDirectory: true,
        mode: "rw",
        index: 1,
      },
    ],
  });
  const { input } = makeInput({ profile, mountProbes });
  expect(() => createMountStage(mountProbes).plan(input)).toThrow(
    "conflicts with existing mount destination",
  );
});

test("MountStage: extra-mount under reserved /nix conflicts", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/dev/null", dst: "/nix/.env", mode: "ro" }],
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
  expect(() => createMountStage(mountProbes).plan(input)).toThrow(
    "conflicts with existing mount destination",
  );
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
  const plan = createMountStage(mountProbes).plan(input)!;
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.dockerArgs.includes("/dir1:/mnt/one:ro")).toEqual(true);
  expect(plan.dockerArgs.includes("/dir2:/mnt/two")).toEqual(true);
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(
    plan.dockerArgs.includes("/var/run/docker.sock:/var/run/docker.sock"),
  ).toEqual(false);
});

test("MountStage: docker socket not mounted when docker.enable is false", () => {
  const profile = makeProfile({ docker: { enable: false, shared: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = createMountStage(mountProbes).plan(input)!;
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
  const plan = createMountStage(mountProbes).plan(input)!;
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(
    plan.dockerArgs.some((a: string) => a.includes("S.gpg-agent")),
  ).toEqual(true);
  expect(plan.envVars["GPG_AGENT_INFO"]).toEqual(
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
  const plan = createMountStage(mountProbes).plan(input)!;

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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["NAS_USER"]).toEqual(TEST_USER);
  expect(plan.envVars["NAS_HOME"]).toEqual(CONTAINER_HOME);
});

test("MountStage: NAS_UID and NAS_GID are set when host provides them", () => {
  const { input, mountProbes } = makeInput();
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["NAS_UID"]).toEqual("1000");
  expect(plan.envVars["NAS_GID"]).toEqual("1000");
});

test("MountStage: NAS_UID and NAS_GID absent when uid/gid null", () => {
  const hostEnv: HostEnv = { ...defaultHostEnv, uid: null, gid: null };
  const { input, mountProbes } = makeInput({ hostEnv });
  const plan = createMountStage(mountProbes).plan(input)!;
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
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.dockerArgs.includes("/nix:/nix")).toEqual(false);
  expect("NIX_REMOTE" in plan.envVars).toEqual(false);
});

test("MountStage: nix enabled but mountSocket false skips socket", () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: false, extraPackages: [] },
  });
  const { input, mountProbes } = makeInput({
    profile,
    prior: { nixEnabled: true },
  });
  const plan = createMountStage(mountProbes).plan(input)!;
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
    prior: { nixEnabled: true },
  });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.dockerArgs.includes("/nix:/nix")).toEqual(true);
  expect(plan.envVars["NIX_REMOTE"]).toEqual("daemon");
  expect(plan.envVars["NIX_ENABLED"]).toEqual("true");
});

test("MountStage: nix enabled but host has no nix does not mount /nix", () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true, extraPackages: [] },
  });
  const probes: ProbeResults = { ...defaultProbeResults, hasHostNix: false };
  const { input, mountProbes } = makeInput({
    profile,
    probes,
    prior: { nixEnabled: true },
  });
  const plan = createMountStage(mountProbes).plan(input)!;
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
    prior: { nixEnabled: true },
  });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["NIX_EXTRA_PACKAGES"]).toEqual("nixpkgs#gh\nnixpkgs#jq");
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
    prior: { nixEnabled: true },
  });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["NIX_CONF_PATH"]).toEqual("/tmp/nas-host-nix.conf");
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
    prior: { nixEnabled: true },
  });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["NIX_CONF_PATH"]).toEqual("/nix/store/xxx/etc/nix.conf");
});

// ============================================================
// gcloud / AWS mount
// ============================================================

test("MountStage: gcloud not mounted when disabled", () => {
  const profile = makeProfile({ gcloud: { mountConfig: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(
    plan.dockerArgs.some((a: string) => a.includes(".config/gcloud")),
  ).toEqual(false);
});

test("MountStage: gcloud mounted when enabled and exists", () => {
  const profile = makeProfile({ gcloud: { mountConfig: true } });
  const mountProbes = makeMountProbes({ gcloudConfigExists: true });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(
    plan.dockerArgs.some((a: string) => a.includes(".config/gcloud")),
  ).toEqual(true);
});

test("MountStage: aws not mounted when disabled", () => {
  const profile = makeProfile({ aws: { mountConfig: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.dockerArgs.some((a: string) => a.includes(".aws"))).toEqual(
    false,
  );
});

test("MountStage: aws mounted when enabled and exists", () => {
  const profile = makeProfile({ aws: { mountConfig: true } });
  const mountProbes = makeMountProbes({ awsConfigExists: true });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.dockerArgs.some((a: string) => a.includes(".aws"))).toEqual(true);
});

// ============================================================
// git config mount
// ============================================================

test("MountStage: git config mounted when exists", () => {
  const mountProbes = makeMountProbes({ gitConfigExists: true });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(
    plan.dockerArgs.some((a: string) => a.includes(".config/git")),
  ).toEqual(true);
});

test("MountStage: git config not mounted when absent", () => {
  const mountProbes = makeMountProbes({ gitConfigExists: false });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
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
  const plan = createMountStage(mountProbes).plan(input)!;
  const agentCommand = plan.outputOverrides.agentCommand as string[];
  expect(agentCommand.length > 0).toEqual(true);
  expect(
    plan.envVars["PATH"]?.includes(`${CONTAINER_HOME}/.local/bin`),
  ).toEqual(true);
});

test("MountStage: copilot agent sets agentCommand", () => {
  const copilotProbes: CopilotProbes = {
    copilotBinPath: "/usr/bin/copilot",
    copilotConfigDirExists: false,
    copilotStateDirExists: false,
    copilotLegacyDirExists: false,
    xdgConfigHome: null,
    xdgStateHome: null,
  };
  const profile = makeProfile({ agent: "copilot" });
  const mountProbes = makeMountProbes({ agentProbes: copilotProbes });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.outputOverrides.agentCommand).toEqual(["copilot"]);
});

test("MountStage: codex agent sets agentCommand", () => {
  const codexProbes: CodexProbes = {
    codexDirExists: false,
    codexBinPath: "/usr/bin/codex",
  };
  const profile = makeProfile({ agent: "codex" });
  const mountProbes = makeMountProbes({ agentProbes: codexProbes });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.outputOverrides.agentCommand).toEqual(["codex"]);
});

// ============================================================
// DBus proxy
// ============================================================

test("MountStage: dbus proxy mounts runtime dir", () => {
  const profile = makeProfile();
  const { input, mountProbes } = makeInput({
    profile,
    prior: {
      dbusProxyEnabled: true,
      dbusSessionRuntimeDir: "/tmp/nas-dbus-123",
    },
  });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.dockerArgs.includes(`/tmp/nas-dbus-123:/run/user/1000`)).toEqual(
    true,
  );
  expect(plan.envVars["XDG_RUNTIME_DIR"]).toEqual("/run/user/1000");
  expect(plan.envVars["DBUS_SESSION_BUS_ADDRESS"]).toEqual(
    "unix:path=/run/user/1000/bus",
  );
});

test("MountStage: dbus proxy requires uid", () => {
  const hostEnv: HostEnv = { ...defaultHostEnv, uid: null, gid: null };
  const { input, mountProbes } = makeInput({
    hostEnv,
    prior: { dbusProxyEnabled: true },
  });
  expect(() => createMountStage(mountProbes).plan(input)).toThrow(
    "dbus.session.enable requires a host UID",
  );
});

// ============================================================
// display (X11)
// ============================================================

test("MountStage: X11 forwarding when display enabled and socket exists", () => {
  const profile = makeProfile({
    display: { ...DEFAULT_DISPLAY_CONFIG, enable: true },
  });
  const hostEnv: HostEnv = {
    ...defaultHostEnv,
    env: new Map([["DISPLAY", ":0"]]),
  };
  const mountProbes = makeMountProbes({
    x11SocketDirExists: true,
    xauthorityExists: true,
    xauthorityPath: `${TEST_HOME}/.Xauthority`,
  });
  const { input } = makeInput({ profile, mountProbes, hostEnv });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(
    plan.dockerArgs.some((a: string) => a.includes("/tmp/.X11-unix")),
  ).toEqual(true);
  expect(plan.envVars["DISPLAY"]).toEqual(":0");
  expect(plan.envVars["XAUTHORITY"]).toEqual(`${CONTAINER_HOME}/.Xauthority`);
  expect(plan.dockerArgs.includes("--shm-size")).toEqual(true);
});

test("MountStage: X11 skipped when no DISPLAY", () => {
  const profile = makeProfile({
    display: { ...DEFAULT_DISPLAY_CONFIG, enable: true },
  });
  const { input, mountProbes } = makeInput({ profile });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(
    plan.dockerArgs.some((a: string) => a.includes("/tmp/.X11-unix")),
  ).toEqual(false);
});

// ============================================================
// tmux 検出
// ============================================================

test("MountStage: NAS_HOST_TMUX set when TMUX env exists", () => {
  const hostEnv: HostEnv = {
    ...defaultHostEnv,
    env: new Map([["TMUX", "/tmp/tmux-1000/default,12345,0"]]),
  };
  const { input, mountProbes } = makeInput({ hostEnv });
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.envVars["NAS_HOST_TMUX"]).toEqual("1");
});

test("MountStage: NAS_HOST_TMUX not set when TMUX absent", () => {
  const { input, mountProbes } = makeInput();
  const plan = createMountStage(mountProbes).plan(input)!;
  expect("NAS_HOST_TMUX" in plan.envVars).toEqual(false);
});

// ============================================================
// mountDir
// ============================================================

test("MountStage: mountDir overrides workspace mount source", () => {
  const { input, mountProbes } = makeInput({
    prior: { mountDir: "/alt/mount/source" },
  });
  const plan = createMountStage(mountProbes).plan(input)!;
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
// minimal profile
// ============================================================

test("MountStage: minimal profile produces valid docker args", () => {
  const { input, mountProbes } = makeInput();
  const plan = createMountStage(mountProbes).plan(input)!;
  expect(plan.dockerArgs.includes("-v")).toEqual(true);
  expect(plan.dockerArgs.includes("-w")).toEqual(true);
  expect("NAS_USER" in plan.envVars).toEqual(true);
  expect("NAS_HOME" in plan.envVars).toEqual(true);
  expect("WORKSPACE" in plan.envVars).toEqual(true);
});

// ============================================================
// encodeDynamicEnvOps (exported helper)
// ============================================================

test("encodeDynamicEnvOps: single prefix op", () => {
  expect(
    encodeDynamicEnvOps([
      {
        mode: "prefix",
        key: "PATH",
        value: "/opt/bin",
        separator: ":",
      },
    ]),
  ).toEqual("__nas_pfx 'PATH' '/opt/bin' ':'");
});

test("encodeDynamicEnvOps: single suffix op", () => {
  expect(
    encodeDynamicEnvOps([
      {
        mode: "suffix",
        key: "PATH",
        value: "/opt/lib",
        separator: ":",
      },
    ]),
  ).toEqual("__nas_sfx 'PATH' '/opt/lib' ':'");
});

test("encodeDynamicEnvOps: value with single quotes escaped", () => {
  expect(
    encodeDynamicEnvOps([
      {
        mode: "prefix",
        key: "MSG",
        value: "it's",
        separator: " ",
      },
    ]),
  ).toEqual("__nas_pfx 'MSG' 'it'\\''s' ' '");
});
