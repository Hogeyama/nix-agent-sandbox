/**
 * E2E tests: MountStage のバリデーションとエッジケース
 *
 * MountStage の各種バリデーションロジック、エッジケース、環境変数処理を検証する。
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
  resolveMountProbes,
  serializeNixExtraPackages,
} from "./mount.ts";
import type { MountProbes } from "./mount.ts";
import type { Config, Profile } from "../config/types.ts";
import type { PriorStageOutputs, StageInput } from "../pipeline/types.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";

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

const baseConfig: Config = {
  default: "test",
  profiles: { test: makeProfile() },
  ui: DEFAULT_UI_CONFIG,
};

function getContainerHome(): string {
  const user = Deno.env.get("USER")?.trim();
  return `/home/${user || "nas"}`;
}

/** Build a StageInput + MountProbes for testing */
async function buildTestInput(
  profile: Profile,
  workDir: string,
  overrides?: {
    priorOverrides?: Partial<PriorStageOutputs>;
  },
): Promise<{ input: StageInput; mountProbes: MountProbes }> {
  const hostEnv = buildHostEnv();
  const probes = await resolveProbes(hostEnv);
  const mountProbes = await resolveMountProbes(
    hostEnv,
    profile,
    workDir,
    probes.gpgAgentSocket,
  );

  const prior: PriorStageOutputs = {
    dockerArgs: [],
    envVars: { NAS_LOG_LEVEL: "info" },
    workDir,
    nixEnabled: false,
    imageName: "nas-sandbox",
    agentCommand: [],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
    ...overrides?.priorOverrides,
  };

  const input: StageInput = {
    config: baseConfig,
    profile,
    profileName: "test",
    sessionId: "sess_test",
    host: hostEnv,
    probes,
    prior,
  };

  return { input, mountProbes };
}

// --- 環境変数バリデーション ---

Deno.test("MountStage: valid env var names accepted", async () => {
  const profile = makeProfile({
    env: [
      { key: "SIMPLE", val: "value", mode: "set" as const },
      { key: "_UNDERSCORE_START", val: "value", mode: "set" as const },
      { key: "WITH_123_NUMBERS", val: "value", mode: "set" as const },
      { key: "A", val: "single-char", mode: "set" as const },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["SIMPLE"], "value");
  assertEquals(plan.envVars["_UNDERSCORE_START"], "value");
  assertEquals(plan.envVars["WITH_123_NUMBERS"], "value");
  assertEquals(plan.envVars["A"], "single-char");
});

Deno.test("MountStage: static env var with special chars in value", async () => {
  const profile = makeProfile({
    env: [
      {
        key: "URL",
        val: "https://example.com/path?foo=bar&baz=qux",
        mode: "set" as const,
      },
      { key: "JSON", val: '{"key": "value"}', mode: "set" as const },
      { key: "SPACES", val: "hello world", mode: "set" as const },
      { key: "EMPTY", val: "", mode: "set" as const },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.envVars["URL"],
    "https://example.com/path?foo=bar&baz=qux",
  );
  assertEquals(plan.envVars["JSON"], '{"key": "value"}');
  assertEquals(plan.envVars["SPACES"], "hello world");
  assertEquals(plan.envVars["EMPTY"], "");
});

Deno.test("MountStage: invalid static env key (starts with number)", async () => {
  const profile = makeProfile({
    env: [{ key: "123BAD", val: "value", mode: "set" as const }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: invalid static env key (contains dash)", async () => {
  const profile = makeProfile({
    env: [{ key: "MY-VAR", val: "value", mode: "set" as const }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: invalid static env key (contains dot)", async () => {
  const profile = makeProfile({
    env: [{ key: "MY.VAR", val: "value", mode: "set" as const }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: dynamic key command producing valid name", async () => {
  const profile = makeProfile({
    env: [{
      keyCmd: "printf VALID_KEY",
      valCmd: "printf hello",
      mode: "set" as const,
    }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["VALID_KEY"], "hello");
});

Deno.test("MountStage: dynamic key command producing invalid name", async () => {
  const profile = makeProfile({
    env: [{
      keyCmd: "printf 'BAD KEY'",
      valCmd: "printf value",
      mode: "set" as const,
    }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: dynamic val command that fails", async () => {
  const profile = makeProfile({
    env: [{ keyCmd: "printf MY_KEY", valCmd: "false", mode: "set" as const }],
  });
  // val_cmd failure happens in resolveMountProbes, not plan()
  try {
    await buildTestInput(profile, Deno.cwd());
    throw new Error("Expected resolveMountProbes to throw");
  } catch (e) {
    assertEquals((e as Error).message.includes("Failed to execute"), true);
  }
});

Deno.test("MountStage: dynamic key command that returns empty", async () => {
  const profile = makeProfile({
    env: [{
      keyCmd: "printf ''",
      valCmd: "printf value",
      mode: "set" as const,
    }],
  });
  // Empty key_cmd output is caught during resolveMountProbes
  try {
    await buildTestInput(profile, Deno.cwd());
    throw new Error("Expected resolveMountProbes to throw");
  } catch (e) {
    assertEquals((e as Error).message.includes("returned empty output"), true);
  }
});

Deno.test("MountStage: multiple env vars including both static and dynamic", async () => {
  const profile = makeProfile({
    env: [
      { key: "STATIC_A", val: "a", mode: "set" as const },
      { keyCmd: "printf DYNAMIC_B", valCmd: "printf b", mode: "set" as const },
      { key: "STATIC_C", val: "c", mode: "set" as const },
      { keyCmd: "printf DYNAMIC_D", valCmd: "printf d", mode: "set" as const },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["STATIC_A"], "a");
  assertEquals(plan.envVars["DYNAMIC_B"], "b");
  assertEquals(plan.envVars["STATIC_C"], "c");
  assertEquals(plan.envVars["DYNAMIC_D"], "d");
});

// --- env prefix/suffix モード ---

Deno.test("MountStage: prefix mode prepends to existing var", async () => {
  const profile = makeProfile({
    env: [
      { key: "MY_PATH", val: "/usr/bin", mode: "set" as const },
      {
        key: "MY_PATH",
        val: "/opt/bin",
        mode: "prefix" as const,
        separator: ":",
      },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["MY_PATH"], "/opt/bin:/usr/bin");
});

Deno.test("MountStage: suffix mode appends to existing var", async () => {
  const profile = makeProfile({
    env: [
      { key: "MY_PATH", val: "/usr/bin", mode: "set" as const },
      {
        key: "MY_PATH",
        val: "/opt/lib",
        mode: "suffix" as const,
        separator: ":",
      },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["MY_PATH"], "/usr/bin:/opt/lib");
});

Deno.test("MountStage: prefix on unset var generates NAS_ENV_OPS", async () => {
  const profile = makeProfile({
    env: [
      {
        key: "NEW_VAR",
        val: "/opt/bin",
        mode: "prefix" as const,
        separator: ":",
      },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["NEW_VAR"], undefined);
  assertEquals(
    plan.envVars["NAS_ENV_OPS"],
    "__nas_pfx 'NEW_VAR' '/opt/bin' ':'",
  );
});

Deno.test("MountStage: suffix on unset var generates NAS_ENV_OPS", async () => {
  const profile = makeProfile({
    env: [
      {
        key: "NEW_VAR",
        val: "/opt/lib",
        mode: "suffix" as const,
        separator: ":",
      },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["NEW_VAR"], undefined);
  assertEquals(
    plan.envVars["NAS_ENV_OPS"],
    "__nas_sfx 'NEW_VAR' '/opt/lib' ':'",
  );
});

Deno.test("MountStage: multiple prefix entries generate ordered NAS_ENV_OPS", async () => {
  const profile = makeProfile({
    env: [
      {
        key: "MY_PATH",
        val: "/opt/a",
        mode: "prefix" as const,
        separator: ":",
      },
      {
        key: "MY_PATH",
        val: "/opt/b",
        mode: "prefix" as const,
        separator: ":",
      },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["MY_PATH"], undefined);
  assertEquals(
    plan.envVars["NAS_ENV_OPS"],
    "__nas_pfx 'MY_PATH' '/opt/a' ':'\n__nas_pfx 'MY_PATH' '/opt/b' ':'",
  );
});

Deno.test("MountStage: prefix with empty separator concatenates directly", async () => {
  const profile = makeProfile({
    env: [
      { key: "FLAGS", val: "-O2", mode: "set" as const },
      {
        key: "FLAGS",
        val: " -Wall",
        mode: "suffix" as const,
        separator: "",
      },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["FLAGS"], "-O2 -Wall");
});

Deno.test("MountStage: prefix with val_cmd", async () => {
  const profile = makeProfile({
    env: [
      { key: "MY_PATH", val: "/usr/bin", mode: "set" as const },
      {
        key: "MY_PATH",
        valCmd: "printf /opt/dynamic",
        mode: "prefix" as const,
        separator: ":",
      },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["MY_PATH"], "/opt/dynamic:/usr/bin");
});

Deno.test("MountStage: set after prefix replaces entire value", async () => {
  const profile = makeProfile({
    env: [
      {
        key: "MY_PATH",
        val: "/opt/bin",
        mode: "prefix" as const,
        separator: ":",
      },
      { key: "MY_PATH", val: "/only/this", mode: "set" as const },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.envVars["MY_PATH"], "/only/this");
  assertEquals(plan.envVars["NAS_ENV_OPS"], undefined);
});

// --- extra-mounts バリデーション ---

Deno.test("MountStage: extra-mount with ~ src expansion", async () => {
  const home = Deno.env.get("HOME") ?? "/root";
  const profile = makeProfile({
    extraMounts: [{ src: "~", dst: "/mnt/home", mode: "ro" }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.includes(`${home}:/mnt/home:ro`),
    true,
  );
});

Deno.test("MountStage: extra-mount with ~/subdir src expansion", async () => {
  const home = Deno.env.get("HOME") ?? "/root";
  // ~/.config は大体のシステムで存在するはず
  const srcDir = `${home}/.config`;
  const hasDir = await Deno.stat(srcDir).then(() => true, () => false);
  if (!hasDir) return; // skip if not present

  const profile = makeProfile({
    extraMounts: [{ src: "~/.config", dst: "/mnt/config", mode: "ro" }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.includes(`${home}/.config:/mnt/config:ro`),
    true,
  );
});

Deno.test("MountStage: extra-mount dst ~ expands to container home", async () => {
  const containerHome = getContainerHome();
  const profile = makeProfile({
    extraMounts: [{ src: Deno.cwd(), dst: "~/mounted", mode: "ro" }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.includes(
      `${Deno.cwd()}:${containerHome}/mounted:ro`,
    ),
    true,
  );
});

Deno.test("MountStage: extra-mount rw mode has no suffix", async () => {
  const profile = makeProfile({
    extraMounts: [{ src: Deno.cwd(), dst: "/mnt/rw-test", mode: "rw" }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  // rw モードは :rw サフィックスなし
  assertEquals(
    plan.dockerArgs.includes(`${Deno.cwd()}:/mnt/rw-test`),
    true,
  );
});

Deno.test("MountStage: extra-mount relative dst resolves from workDir", async () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/dev/null", dst: ".env", mode: "ro" }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.includes(`/dev/null:${Deno.cwd()}/.env:ro`),
    true,
  );
});

Deno.test("MountStage: extra-mount relative src resolves from workDir", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-relative-src-" });
  const srcDir = "mount-src";
  try {
    await Deno.mkdir(`${tmpDir}/${srcDir}`);
    const profile = makeProfile({
      extraMounts: [{ src: srcDir, dst: "/tmp/mount-src", mode: "ro" }],
    });
    const { input, mountProbes } = await buildTestInput(profile, tmpDir);
    const plan = createMountStage(mountProbes).plan(input)!;
    assertEquals(
      plan.dockerArgs.includes(`${tmpDir}/${srcDir}:/tmp/mount-src:ro`),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("MountStage: extra-mount to /nix conflicts", async () => {
  const profile = makeProfile({
    extraMounts: [{ src: Deno.cwd(), dst: "/nix", mode: "ro" }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount to /var/run/docker.sock is allowed (DinD migration)", async () => {
  const profile = makeProfile({
    extraMounts: [
      { src: Deno.cwd(), dst: "/var/run/docker.sock", mode: "ro" },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  // DinD 移行後: /var/run/docker.sock は予約パスではなくなったため許可される
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes(":/var/run/docker.sock")),
    true,
  );
});

Deno.test("MountStage: extra-mount to workspace dir conflicts", async () => {
  const workDir = Deno.cwd();
  const profile = makeProfile({
    extraMounts: [{ src: "/tmp", dst: workDir, mode: "ro" }],
  });
  const { input, mountProbes } = await buildTestInput(profile, workDir);
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount file under workspace dir is allowed", async () => {
  const workDir = Deno.cwd();
  const profile = makeProfile({
    extraMounts: [{ src: "/dev/null", dst: `${workDir}/.env`, mode: "ro" }],
  });
  const { input, mountProbes } = await buildTestInput(profile, workDir);
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.includes(`/dev/null:${workDir}/.env:ro`),
    true,
  );
});

Deno.test("MountStage: extra-mount directory under workspace dir still conflicts with nested file mount", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "nas-nested-dir-" });
  const workDir = Deno.cwd();
  try {
    const profile = makeProfile({
      extraMounts: [{ src: tmpDir, dst: `${workDir}/.config`, mode: "ro" }],
    });
    const { input, mountProbes } = await buildTestInput(profile, workDir);
    assertThrows(
      () => createMountStage(mountProbes).plan(input),
      Error,
      "conflicts with existing mount destination",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("MountStage: extra-mount duplicate dst conflicts", async () => {
  const profile = makeProfile({
    extraMounts: [
      { src: Deno.cwd(), dst: "/mnt/dup", mode: "ro" },
      { src: Deno.cwd(), dst: "/mnt/dup", mode: "rw" },
    ],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount under reserved /nix conflicts", async () => {
  const profile = makeProfile({
    extraMounts: [{ src: "/dev/null", dst: "/nix/.env", mode: "ro" }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  assertThrows(
    () => createMountStage(mountProbes).plan(input),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount nonexistent src is skipped", async () => {
  const missingPath = `/tmp/nas-nonexistent-${crypto.randomUUID()}`;
  const profile = makeProfile({
    extraMounts: [{ src: missingPath, dst: "/mnt/missing", mode: "ro" }],
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes("/mnt/missing")),
    false,
  );
});

Deno.test("MountStage: multiple valid extra-mounts all mounted", async () => {
  const tmpDir1 = await Deno.makeTempDir({ prefix: "nas-em1-" });
  const tmpDir2 = await Deno.makeTempDir({ prefix: "nas-em2-" });
  try {
    const profile = makeProfile({
      extraMounts: [
        { src: tmpDir1, dst: "/mnt/one", mode: "ro" },
        { src: tmpDir2, dst: "/mnt/two", mode: "rw" },
      ],
    });
    const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
    const plan = createMountStage(mountProbes).plan(input)!;
    assertEquals(
      plan.dockerArgs.includes(`${tmpDir1}:/mnt/one:ro`),
      true,
    );
    assertEquals(
      plan.dockerArgs.includes(`${tmpDir2}:/mnt/two`),
      true,
    );
  } finally {
    await Deno.remove(tmpDir1, { recursive: true });
    await Deno.remove(tmpDir2, { recursive: true });
  }
});

// --- serializeNixExtraPackages ---

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

// --- docker (DinD rootless, MountStage no longer mounts socket) ---

Deno.test("MountStage: docker socket not mounted even when docker.enable is true", async () => {
  const profile = makeProfile({ docker: { enable: true, shared: false } });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  // DinD 移行後: MountStage は docker.sock をマウントしない (DindStage が担当)
  assertEquals(
    plan.dockerArgs.includes("/var/run/docker.sock:/var/run/docker.sock"),
    false,
  );
});

Deno.test("MountStage: docker socket not mounted when docker.enable is false", async () => {
  const profile = makeProfile({ docker: { enable: false, shared: false } });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.includes("/var/run/docker.sock:/var/run/docker.sock"),
    false,
  );
});

// --- GPG mount ---

Deno.test("MountStage: GPG not mounted when disabled", async () => {
  const profile = makeProfile({ gpg: { forwardAgent: false } });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes("S.gpg-agent")),
    false,
  );
  assertEquals("GPG_AGENT_INFO" in plan.envVars, false);
});

Deno.test("MountStage: GPG environment set when enabled", async () => {
  const profile = makeProfile({ gpg: { forwardAgent: true } });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  // GPG が有効な場合、GPG 関連のマウントまたは環境変数が設定される
  // ホストの GPG 設定によって結果が変わるが、少なくとも処理は完了する
  assertEquals(plan.dockerArgs.length > 0, true);
});

// --- workspace mount ---

Deno.test("MountStage: workspace uses absolute path", async () => {
  const workDir = Deno.cwd();
  const profile = makeProfile();
  const { input, mountProbes } = await buildTestInput(profile, workDir);
  const plan = createMountStage(mountProbes).plan(input)!;

  // -v mount
  const vIdx = plan.dockerArgs.indexOf("-v");
  assertEquals(vIdx >= 0, true);
  const mountArg = plan.dockerArgs[vIdx + 1];
  assertEquals(mountArg, `${workDir}:${workDir}`);

  // -w workdir
  const wIdx = plan.dockerArgs.indexOf("-w");
  assertEquals(wIdx >= 0, true);
  assertEquals(plan.dockerArgs[wIdx + 1], workDir);
});

Deno.test("MountStage: NAS_USER and NAS_HOME are set", async () => {
  const profile = makeProfile();
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;

  const user = Deno.env.get("USER")?.trim() || "nas";
  assertEquals(plan.envVars["NAS_USER"], user);
  assertEquals(plan.envVars["NAS_HOME"], `/home/${user}`);
});

Deno.test("MountStage: NAS_UID and NAS_GID are set on Linux", async () => {
  const profile = makeProfile();
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;

  const uid = Deno.uid();
  const gid = Deno.gid();
  if (uid !== null && gid !== null) {
    assertEquals(plan.envVars["NAS_UID"], String(uid));
    assertEquals(plan.envVars["NAS_GID"], String(gid));
  }
});

// --- Nix マウント ---

Deno.test("MountStage: nix disabled does not mount /nix", async () => {
  const profile = makeProfile({
    nix: { enable: false, mountSocket: true, extraPackages: [] },
  });
  // nixEnabled が false のままの prior
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(plan.dockerArgs.includes("/nix:/nix"), false);
  assertEquals("NIX_REMOTE" in plan.envVars, false);
});

Deno.test("MountStage: nix enabled but mountSocket false skips socket", async () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: false, extraPackages: [] },
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd(), {
    priorOverrides: { nixEnabled: true },
  });
  const plan = createMountStage(mountProbes).plan(input)!;
  // mountSocket が false なので /nix はマウントされない
  assertEquals(plan.dockerArgs.includes("/nix:/nix"), false);
});

Deno.test("MountStage: nix enabled with mountSocket mounts /nix if host has nix", async () => {
  const hasHostNix = await Deno.stat("/nix").then(() => true, () => false);
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true, extraPackages: [] },
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd(), {
    priorOverrides: { nixEnabled: true },
  });
  const plan = createMountStage(mountProbes).plan(input)!;

  if (hasHostNix) {
    assertEquals(plan.dockerArgs.includes("/nix:/nix"), true);
    assertEquals(plan.envVars["NIX_REMOTE"], "daemon");
    assertEquals(plan.envVars["NIX_ENABLED"], "true");
  } else {
    assertEquals(plan.dockerArgs.includes("/nix:/nix"), false);
  }
});

Deno.test("MountStage: nix extra-packages set when nix enabled and host has nix", async () => {
  const hasHostNix = await Deno.stat("/nix").then(() => true, () => false);
  const profile = makeProfile({
    nix: {
      enable: true,
      mountSocket: true,
      extraPackages: ["nixpkgs#gh", "nixpkgs#jq"],
    },
  });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd(), {
    priorOverrides: { nixEnabled: true },
  });
  const plan = createMountStage(mountProbes).plan(input)!;

  if (hasHostNix) {
    assertEquals(
      plan.envVars["NIX_EXTRA_PACKAGES"],
      "nixpkgs#gh\nnixpkgs#jq",
    );
  }
});

// --- gcloud mount ---

Deno.test("MountStage: gcloud not mounted when disabled", async () => {
  const profile = makeProfile({ gcloud: { mountConfig: false } });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes(".config/gcloud")),
    false,
  );
});

// --- AWS mount ---

Deno.test("MountStage: aws not mounted when disabled", async () => {
  const profile = makeProfile({ aws: { mountConfig: false } });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  assertEquals(
    plan.dockerArgs.some((a: string) => a.includes(".aws")),
    false,
  );
});

// --- agent-specific 設定 ---

Deno.test("MountStage: claude agent sets agentCommand", async () => {
  const profile = makeProfile({ agent: "claude" });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  const agentCommand = plan.outputOverrides.agentCommand as string[];
  assertEquals(agentCommand.length > 0, true);
});

Deno.test("MountStage: copilot agent sets agentCommand", async () => {
  const profile = makeProfile({ agent: "copilot" });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  const agentCommand = plan.outputOverrides.agentCommand as string[];
  assertEquals(agentCommand.length > 0, true);
});

Deno.test("MountStage: codex agent sets agentCommand", async () => {
  const profile = makeProfile({ agent: "codex" });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;
  const agentCommand = plan.outputOverrides.agentCommand as string[];
  assertEquals(agentCommand.length > 0, true);
});

Deno.test("MountStage: claude agent mounts ~/.claude if exists", async () => {
  const home = Deno.env.get("HOME") ?? "/root";
  const claudeDir = `${home}/.claude`;
  const hasClaude = await Deno.stat(claudeDir).then(
    (s) => s.isDirectory,
    () => false,
  );

  const profile = makeProfile({ agent: "claude" });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;

  if (hasClaude) {
    assertEquals(
      plan.dockerArgs.some((a: string) => a.includes("/.claude")),
      true,
    );
  }
});

Deno.test("MountStage: claude agent uses ~/.local/bin in container", async () => {
  const containerHome = getContainerHome();
  const profile = makeProfile({ agent: "claude" });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;

  assertEquals(
    plan.envVars["PATH"]?.startsWith(`${containerHome}/.local/bin:`),
    true,
  );

  const agentCommand = plan.outputOverrides.agentCommand as string[];
  if (agentCommand[0] === "claude") {
    assertEquals(
      plan.dockerArgs.some((a: string) =>
        a.includes(`${containerHome}/.local/bin/claude:ro`)
      ),
      true,
    );
  }
});

Deno.test("MountStage: codex agent mounts ~/.codex if exists", async () => {
  const home = Deno.env.get("HOME") ?? "/root";
  const codexDir = `${home}/.codex`;
  const hasCodex = await Deno.stat(codexDir).then(
    (s) => s.isDirectory,
    () => false,
  );

  const profile = makeProfile({ agent: "codex" });
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;

  if (hasCodex) {
    assertEquals(
      plan.dockerArgs.some((a: string) => a.includes("/.codex")),
      true,
    );
  }
});

// --- 空のプロファイルでの実行 ---

Deno.test("MountStage: minimal profile produces valid docker args", async () => {
  const profile = makeProfile();
  const { input, mountProbes } = await buildTestInput(profile, Deno.cwd());
  const plan = createMountStage(mountProbes).plan(input)!;

  // 最低限: -v (workspace mount) と -w (workdir) が含まれる
  assertEquals(plan.dockerArgs.includes("-v"), true);
  assertEquals(plan.dockerArgs.includes("-w"), true);

  // 基本的な env vars が設定される
  assertEquals("NAS_USER" in plan.envVars, true);
  assertEquals("NAS_HOME" in plan.envVars, true);
  assertEquals("WORKSPACE" in plan.envVars, true);
});
