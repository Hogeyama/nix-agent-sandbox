/**
 * MountStage の純粋ロジックテスト (unit test)
 *
 * plan() は純粋関数なので、HostEnv / ProbeResults / MountProbes を
 * リテラルで組み立てて渡す。実行環境に依存しない。
 */

import { assertEquals, assertThrows } from "@std/assert";
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
  opts: { separator?: string; index?: number; keySource?: "key" | "key_cmd" } =
    {},
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

Deno.test("MountStage: valid env var names accepted", () => {
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
  assertEquals(plan.envVars["SIMPLE"], "value");
  assertEquals(plan.envVars["_UNDERSCORE_START"], "value");
  assertEquals(plan.envVars["WITH_123_NUMBERS"], "value");
  assertEquals(plan.envVars["A"], "single-char");
});

Deno.test("MountStage: static env var with special chars in value", () => {
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
  assertEquals(plan.envVars["URL"], "https://example.com/path?foo=bar&baz=qux");
  assertEquals(plan.envVars["JSON"], '{"key": "value"}');
  assertEquals(plan.envVars["SPACES"], "hello world");
  assertEquals(plan.envVars["EMPTY"], "");
});

Deno.test("MountStage: invalid static env key (starts with number)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [envEntry("123BAD", "value")],
  });
  const { input } = makeInput({ mountProbes });
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: invalid static env key (contains dash)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [envEntry("MY-VAR", "value")],
  });
  const { input } = makeInput({ mountProbes });
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: invalid static env key (contains dot)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [envEntry("MY.VAR", "value")],
  });
  const { input } = makeInput({ mountProbes });
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: invalid dynamic key (key_cmd source)", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("BAD KEY", "value", "set", { keySource: "key_cmd" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: multiple env vars including both static and dynamic", () => {
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
  assertEquals(plan.envVars["STATIC_A"], "a");
  assertEquals(plan.envVars["DYNAMIC_B"], "b");
  assertEquals(plan.envVars["STATIC_C"], "c");
  assertEquals(plan.envVars["DYNAMIC_D"], "d");
});

// ============================================================
// env prefix/suffix モード
// ============================================================

Deno.test("MountStage: prefix mode prepends to existing var", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("MY_PATH", "/usr/bin", "set", { index: 0 }),
      envEntry("MY_PATH", "/opt/bin", "prefix", { index: 1, separator: ":" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["MY_PATH"], "/opt/bin:/usr/bin");
});

Deno.test("MountStage: suffix mode appends to existing var", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("MY_PATH", "/usr/bin", "set", { index: 0 }),
      envEntry("MY_PATH", "/opt/lib", "suffix", { index: 1, separator: ":" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["MY_PATH"], "/usr/bin:/opt/lib");
});

Deno.test("MountStage: prefix on unset var generates NAS_ENV_OPS", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("NEW_VAR", "/opt/bin", "prefix", { index: 0, separator: ":" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["NEW_VAR"], undefined);
  assertEquals(
    plan.envVars["NAS_ENV_OPS"],
    "__nas_pfx 'NEW_VAR' '/opt/bin' ':'",
  );
});

Deno.test("MountStage: suffix on unset var generates NAS_ENV_OPS", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("NEW_VAR", "/opt/lib", "suffix", { index: 0, separator: ":" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["NEW_VAR"], undefined);
  assertEquals(
    plan.envVars["NAS_ENV_OPS"],
    "__nas_sfx 'NEW_VAR' '/opt/lib' ':'",
  );
});

Deno.test("MountStage: multiple prefix entries generate ordered NAS_ENV_OPS", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("MY_PATH", "/opt/a", "prefix", { index: 0, separator: ":" }),
      envEntry("MY_PATH", "/opt/b", "prefix", { index: 1, separator: ":" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["MY_PATH"], undefined);
  assertEquals(
    plan.envVars["NAS_ENV_OPS"],
    "__nas_pfx 'MY_PATH' '/opt/a' ':'\n__nas_pfx 'MY_PATH' '/opt/b' ':'",
  );
});

Deno.test("MountStage: suffix with empty separator concatenates directly", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("FLAGS", "-O2", "set", { index: 0 }),
      envEntry("FLAGS", " -Wall", "suffix", { index: 1, separator: "" }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["FLAGS"], "-O2 -Wall");
});

Deno.test("MountStage: prefix with dynamic val", () => {
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
  assertEquals(plan.envVars["MY_PATH"], "/opt/dynamic:/usr/bin");
});

Deno.test("MountStage: set after prefix replaces entire value", () => {
  const mountProbes = makeMountProbes({
    resolvedEnvEntries: [
      envEntry("MY_PATH", "/opt/bin", "prefix", { index: 0, separator: ":" }),
      envEntry("MY_PATH", "/only/this", "set", { index: 1 }),
    ],
  });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["MY_PATH"], "/only/this");
  assertEquals(plan.envVars["NAS_ENV_OPS"], undefined);
});

// ============================================================
// extra-mounts バリデーション
// ============================================================

Deno.test("MountStage: extra-mount with ~ src expansion (resolved by probe)", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "~", dst: "/mnt/home", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [{
      normalizedSrc: TEST_HOME,
      srcExists: true,
      srcIsDirectory: true,
      mode: "ro",
      index: 0,
    }],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.dockerArgs.includes(`${TEST_HOME}:/mnt/home:ro`), true);
});

Deno.test("MountStage: extra-mount dst ~ expands to container home", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/some/dir", dst: "~/mounted", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [{
      normalizedSrc: "/some/dir",
      srcExists: true,
      srcIsDirectory: true,
      mode: "ro",
      index: 0,
    }],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.includes(`/some/dir:${CONTAINER_HOME}/mounted:ro`),
    true,
  );
});

Deno.test("MountStage: extra-mount rw mode has no suffix", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/some/dir", dst: "/mnt/rw-test", mode: "rw" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [{
      normalizedSrc: "/some/dir",
      srcExists: true,
      srcIsDirectory: true,
      mode: "rw",
      index: 0,
    }],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.dockerArgs.includes("/some/dir:/mnt/rw-test"), true);
});

Deno.test("MountStage: extra-mount relative dst resolves from workDir", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/dev/null", dst: ".env", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [{
      normalizedSrc: "/dev/null",
      srcExists: true,
      srcIsDirectory: false,
      mode: "ro",
      index: 0,
    }],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.includes(`/dev/null:${TEST_WORK_DIR}/.env:ro`),
    true,
  );
});

Deno.test("MountStage: extra-mount to /nix conflicts", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/some/dir", dst: "/nix", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [{
      normalizedSrc: "/some/dir",
      srcExists: true,
      srcIsDirectory: true,
      mode: "ro",
      index: 0,
    }],
  });
  const { input } = makeInput({ profile, mountProbes });
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount to /var/run/docker.sock is allowed", () => {
  const profile = makeProfile({
    extraMounts: [{
      src: "/some/dir",
      dst: "/var/run/docker.sock",
      mode: "ro",
    }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [{
      normalizedSrc: "/some/dir",
      srcExists: true,
      srcIsDirectory: true,
      mode: "ro",
      index: 0,
    }],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes(":/var/run/docker.sock")),
    true,
  );
});

Deno.test("MountStage: extra-mount to workspace dir conflicts", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/tmp", dst: TEST_WORK_DIR, mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [{
      normalizedSrc: "/tmp",
      srcExists: true,
      srcIsDirectory: true,
      mode: "ro",
      index: 0,
    }],
  });
  const { input } = makeInput({ profile, mountProbes });
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount file under workspace dir is allowed", () => {
  const profile = makeProfile({
    extraMounts: [{
      src: "/dev/null",
      dst: `${TEST_WORK_DIR}/.env`,
      mode: "ro",
    }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [{
      normalizedSrc: "/dev/null",
      srcExists: true,
      srcIsDirectory: false,
      mode: "ro",
      index: 0,
    }],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.includes(`/dev/null:${TEST_WORK_DIR}/.env:ro`),
    true,
  );
});

Deno.test("MountStage: extra-mount directory under workspace dir conflicts", () => {
  const profile = makeProfile({
    extraMounts: [{
      src: "/tmp/some-dir",
      dst: `${TEST_WORK_DIR}/.config`,
      mode: "ro",
    }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [{
      normalizedSrc: "/tmp/some-dir",
      srcExists: true,
      srcIsDirectory: true,
      mode: "ro",
      index: 0,
    }],
  });
  const { input } = makeInput({ profile, mountProbes });
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount duplicate dst conflicts", () => {
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
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount under reserved /nix conflicts", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/dev/null", dst: "/nix/.env", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [{
      normalizedSrc: "/dev/null",
      srcExists: true,
      srcIsDirectory: false,
      mode: "ro",
      index: 0,
    }],
  });
  const { input } = makeInput({ profile, mountProbes });
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount nonexistent src is skipped", () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/nonexistent", dst: "/mnt/missing", mode: "ro" }],
  });
  const mountProbes = makeMountProbes({
    resolvedExtraMounts: [{
      normalizedSrc: "/nonexistent",
      srcExists: false,
      srcIsDirectory: false,
      mode: "ro",
      index: 0,
    }],
  });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes("/mnt/missing")),
    false,
  );
});

Deno.test("MountStage: multiple valid extra-mounts all mounted", () => {
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
  assertEquals(plan.dockerArgs.includes("/dir1:/mnt/one:ro"), true);
  assertEquals(plan.dockerArgs.includes("/dir2:/mnt/two"), true);
});

// ============================================================
// serializeNixExtraPackages
// ============================================================

Deno.test("serializeNixExtraPackages: single package", () => {
  assertEquals(serializeNixExtraPackages(["nixpkgs#gh"]), "nixpkgs#gh");
});

Deno.test("serializeNixExtraPackages: multiple packages", () => {
  assertEquals(
    serializeNixExtraPackages(["nixpkgs#gh", "nixpkgs#ripgrep", "nixpkgs#fd"]),
    "nixpkgs#gh\nnixpkgs#ripgrep\nnixpkgs#fd",
  );
});

Deno.test("serializeNixExtraPackages: trims whitespace", () => {
  assertEquals(
    serializeNixExtraPackages(["  nixpkgs#gh  ", " nixpkgs#fd "]),
    "nixpkgs#gh\nnixpkgs#fd",
  );
});

Deno.test("serializeNixExtraPackages: filters empty strings", () => {
  assertEquals(
    serializeNixExtraPackages(["nixpkgs#gh", "", "  ", "nixpkgs#fd"]),
    "nixpkgs#gh\nnixpkgs#fd",
  );
});

Deno.test("serializeNixExtraPackages: all empty returns null", () => {
  assertEquals(serializeNixExtraPackages([""]), null);
  assertEquals(serializeNixExtraPackages(["", "  ", "   "]), null);
  assertEquals(serializeNixExtraPackages([]), null);
});

// ============================================================
// docker (DinD rootless)
// ============================================================

Deno.test("MountStage: docker socket not mounted even when docker.enable is true", () => {
  const profile = makeProfile({ docker: { enable: true, shared: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.includes("/var/run/docker.sock:/var/run/docker.sock"),
    false,
  );
});

Deno.test("MountStage: docker socket not mounted when docker.enable is false", () => {
  const profile = makeProfile({ docker: { enable: false, shared: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.includes("/var/run/docker.sock:/var/run/docker.sock"),
    false,
  );
});

// ============================================================
// GPG mount
// ============================================================

Deno.test("MountStage: GPG not mounted when disabled", () => {
  const profile = makeProfile({ gpg: { forwardAgent: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes("S.gpg-agent")),
    false,
  );
  assertEquals("GPG_AGENT_INFO" in plan.envVars, false);
});

Deno.test("MountStage: GPG socket mounted when enabled and socket exists", () => {
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
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes("S.gpg-agent")),
    true,
  );
  assertEquals(
    plan.envVars["GPG_AGENT_INFO"],
    `${CONTAINER_HOME}/.gnupg/S.gpg-agent`,
  );
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes("gpg.conf")),
    true,
  );
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes("gpg-agent.conf")),
    true,
  );
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes("pubring.kbx")),
    true,
  );
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes("trustdb.gpg")),
    true,
  );
});

// ============================================================
// workspace mount
// ============================================================

Deno.test("MountStage: workspace uses absolute path", () => {
  const { input, mountProbes } = makeInput();
  const plan = createMountStage(mountProbes).plan(input)!;

  const vIdx = plan.dockerArgs.indexOf("-v");
  assertEquals(vIdx >= 0, true);
  assertEquals(plan.dockerArgs[vIdx + 1], `${TEST_WORK_DIR}:${TEST_WORK_DIR}`);

  const wIdx = plan.dockerArgs.indexOf("-w");
  assertEquals(wIdx >= 0, true);
  assertEquals(plan.dockerArgs[wIdx + 1], TEST_WORK_DIR);
});

Deno.test("MountStage: NAS_USER and NAS_HOME are set", () => {
  const { input, mountProbes } = makeInput();
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["NAS_USER"], TEST_USER);
  assertEquals(plan.envVars["NAS_HOME"], CONTAINER_HOME);
});

Deno.test("MountStage: NAS_UID and NAS_GID are set when host provides them", () => {
  const { input, mountProbes } = makeInput();
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["NAS_UID"], "1000");
  assertEquals(plan.envVars["NAS_GID"], "1000");
});

Deno.test("MountStage: NAS_UID and NAS_GID absent when uid/gid null", () => {
  const hostEnv: HostEnv = { ...defaultHostEnv, uid: null, gid: null };
  const { input, mountProbes } = makeInput({ hostEnv });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals("NAS_UID" in plan.envVars, false);
  assertEquals("NAS_GID" in plan.envVars, false);
});

// ============================================================
// Nix マウント
// ============================================================

Deno.test("MountStage: nix disabled does not mount /nix", () => {
  const profile = makeProfile({
    nix: { enable: false, mountSocket: true, extraPackages: [] },
  });
  const { input, mountProbes } = makeInput({ profile });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.dockerArgs.includes("/nix:/nix"), false);
  assertEquals("NIX_REMOTE" in plan.envVars, false);
});

Deno.test("MountStage: nix enabled but mountSocket false skips socket", () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: false, extraPackages: [] },
  });
  const { input, mountProbes } = makeInput({
    profile,
    prior: { nixEnabled: true },
  });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.dockerArgs.includes("/nix:/nix"), false);
});

Deno.test("MountStage: nix enabled with mountSocket mounts /nix when host has nix", () => {
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
  assertEquals(plan.dockerArgs.includes("/nix:/nix"), true);
  assertEquals(plan.envVars["NIX_REMOTE"], "daemon");
  assertEquals(plan.envVars["NIX_ENABLED"], "true");
});

Deno.test("MountStage: nix enabled but host has no nix does not mount /nix", () => {
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
  assertEquals(plan.dockerArgs.includes("/nix:/nix"), false);
});

Deno.test("MountStage: nix extra-packages set when nix enabled and host has nix", () => {
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
  assertEquals(plan.envVars["NIX_EXTRA_PACKAGES"], "nixpkgs#gh\nnixpkgs#jq");
});

Deno.test("MountStage: nix conf outside /nix is mounted to temp path", () => {
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
  assertEquals(plan.envVars["NIX_CONF_PATH"], "/tmp/nas-host-nix.conf");
  assertEquals(
    plan.dockerArgs.some((a: string) =>
      a.includes("/etc/static/nix.conf:/tmp/nas-host-nix.conf:ro")
    ),
    true,
  );
});

Deno.test("MountStage: nix conf under /nix uses original path", () => {
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
  assertEquals(plan.envVars["NIX_CONF_PATH"], "/nix/store/xxx/etc/nix.conf");
});

// ============================================================
// gcloud / AWS mount
// ============================================================

Deno.test("MountStage: gcloud not mounted when disabled", () => {
  const profile = makeProfile({ gcloud: { mountConfig: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes(".config/gcloud")),
    false,
  );
});

Deno.test("MountStage: gcloud mounted when enabled and exists", () => {
  const profile = makeProfile({ gcloud: { mountConfig: true } });
  const mountProbes = makeMountProbes({ gcloudConfigExists: true });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes(".config/gcloud")),
    true,
  );
});

Deno.test("MountStage: aws not mounted when disabled", () => {
  const profile = makeProfile({ aws: { mountConfig: false } });
  const { input, mountProbes } = makeInput({ profile });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes(".aws")),
    false,
  );
});

Deno.test("MountStage: aws mounted when enabled and exists", () => {
  const profile = makeProfile({ aws: { mountConfig: true } });
  const mountProbes = makeMountProbes({ awsConfigExists: true });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes(".aws")),
    true,
  );
});

// ============================================================
// git config mount
// ============================================================

Deno.test("MountStage: git config mounted when exists", () => {
  const mountProbes = makeMountProbes({ gitConfigExists: true });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes(".config/git")),
    true,
  );
});

Deno.test("MountStage: git config not mounted when absent", () => {
  const mountProbes = makeMountProbes({ gitConfigExists: false });
  const { input } = makeInput({ mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes(".config/git")),
    false,
  );
});

// ============================================================
// agent dispatch
// ============================================================

Deno.test("MountStage: claude agent sets agentCommand and PATH", () => {
  const profile = makeProfile({ agent: "claude" });
  const mountProbes = makeMountProbes({ agentProbes: defaultClaudeProbes });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  const agentCommand = plan.outputOverrides.agentCommand as string[];
  assertEquals(agentCommand.length > 0, true);
  assertEquals(
    plan.envVars["PATH"]?.includes(`${CONTAINER_HOME}/.local/bin`),
    true,
  );
});

Deno.test("MountStage: copilot agent sets agentCommand", () => {
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
  assertEquals(plan.outputOverrides.agentCommand, ["copilot"]);
});

Deno.test("MountStage: codex agent sets agentCommand", () => {
  const codexProbes: CodexProbes = {
    codexDirExists: false,
    codexBinPath: "/usr/bin/codex",
  };
  const profile = makeProfile({ agent: "codex" });
  const mountProbes = makeMountProbes({ agentProbes: codexProbes });
  const { input } = makeInput({ profile, mountProbes });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.outputOverrides.agentCommand, ["codex"]);
});

// ============================================================
// DBus proxy
// ============================================================

Deno.test("MountStage: dbus proxy mounts runtime dir", () => {
  const profile = makeProfile();
  const { input, mountProbes } = makeInput({
    profile,
    prior: {
      dbusProxyEnabled: true,
      dbusSessionRuntimeDir: "/tmp/nas-dbus-123",
    },
  });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.includes(`/tmp/nas-dbus-123:/run/user/1000`),
    true,
  );
  assertEquals(plan.envVars["XDG_RUNTIME_DIR"], "/run/user/1000");
  assertEquals(
    plan.envVars["DBUS_SESSION_BUS_ADDRESS"],
    "unix:path=/run/user/1000/bus",
  );
});

Deno.test("MountStage: dbus proxy requires uid", () => {
  const hostEnv: HostEnv = { ...defaultHostEnv, uid: null, gid: null };
  const { input, mountProbes } = makeInput({
    hostEnv,
    prior: { dbusProxyEnabled: true },
  });
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "dbus.session.enable requires a host UID",
  );
});

// ============================================================
// display (X11)
// ============================================================

Deno.test("MountStage: X11 forwarding when display enabled and socket exists", () => {
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
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes("/tmp/.X11-unix")),
    true,
  );
  assertEquals(plan.envVars["DISPLAY"], ":0");
  assertEquals(plan.envVars["XAUTHORITY"], `${CONTAINER_HOME}/.Xauthority`);
  assertEquals(plan.dockerArgs.includes("--shm-size"), true);
});

Deno.test("MountStage: X11 skipped when no DISPLAY", () => {
  const profile = makeProfile({
    display: { ...DEFAULT_DISPLAY_CONFIG, enable: true },
  });
  const { input, mountProbes } = makeInput({ profile });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes("/tmp/.X11-unix")),
    false,
  );
});

// ============================================================
// tmux 検出
// ============================================================

Deno.test("MountStage: NAS_HOST_TMUX set when TMUX env exists", () => {
  const hostEnv: HostEnv = {
    ...defaultHostEnv,
    env: new Map([["TMUX", "/tmp/tmux-1000/default,12345,0"]]),
  };
  const { input, mountProbes } = makeInput({ hostEnv });
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["NAS_HOST_TMUX"], "1");
});

Deno.test("MountStage: NAS_HOST_TMUX not set when TMUX absent", () => {
  const { input, mountProbes } = makeInput();
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals("NAS_HOST_TMUX" in plan.envVars, false);
});

// ============================================================
// mountDir
// ============================================================

Deno.test("MountStage: mountDir overrides workspace mount source", () => {
  const { input, mountProbes } = makeInput({
    prior: { mountDir: "/alt/mount/source" },
  });
  const plan = createMountStage(mountProbes).plan(input)!;
  const vIdx = plan.dockerArgs.indexOf("-v");
  // mountDir は -v のソース側だけ変える。dst は workDir のまま
  // ただし path.resolve で mountDir 自体が dst にもなる
  assertEquals(
    plan.dockerArgs[vIdx + 1],
    "/alt/mount/source:/alt/mount/source",
  );
  // -w は workDir
  const wIdx = plan.dockerArgs.indexOf("-w");
  assertEquals(plan.dockerArgs[wIdx + 1], TEST_WORK_DIR);
});

// ============================================================
// minimal profile
// ============================================================

Deno.test("MountStage: minimal profile produces valid docker args", () => {
  const { input, mountProbes } = makeInput();
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.dockerArgs.includes("-v"), true);
  assertEquals(plan.dockerArgs.includes("-w"), true);
  assertEquals("NAS_USER" in plan.envVars, true);
  assertEquals("NAS_HOME" in plan.envVars, true);
  assertEquals("WORKSPACE" in plan.envVars, true);
});

// ============================================================
// encodeDynamicEnvOps (exported helper)
// ============================================================

Deno.test("encodeDynamicEnvOps: single prefix op", () => {
  assertEquals(
    encodeDynamicEnvOps([{
      mode: "prefix",
      key: "PATH",
      value: "/opt/bin",
      separator: ":",
    }]),
    "__nas_pfx 'PATH' '/opt/bin' ':'",
  );
});

Deno.test("encodeDynamicEnvOps: single suffix op", () => {
  assertEquals(
    encodeDynamicEnvOps([{
      mode: "suffix",
      key: "PATH",
      value: "/opt/lib",
      separator: ":",
    }]),
    "__nas_sfx 'PATH' '/opt/lib' ':'",
  );
});

Deno.test("encodeDynamicEnvOps: value with single quotes escaped", () => {
  assertEquals(
    encodeDynamicEnvOps([{
      mode: "prefix",
      key: "MSG",
      value: "it's",
      separator: " ",
    }]),
    "__nas_pfx 'MSG' 'it'\\''s' ' '",
  );
});
