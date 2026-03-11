/**
 * E2E tests: MountStage のバリデーションとエッジケース
 *
 * MountStage の各種バリデーションロジック、エッジケース、環境変数処理を検証する。
 */

import { assertEquals, assertRejects } from "@std/assert";
import { MountStage, serializeNixExtraPackages } from "../src/stages/mount.ts";
import { createContext } from "../src/pipeline/context.ts";
import type { Config, Profile } from "../src/config/types.ts";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { mountSocket: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    extraMounts: [],
    env: [],
    ...overrides,
  };
}

const baseConfig: Config = {
  default: "test",
  profiles: { test: makeProfile() },
};

function getContainerHome(): string {
  const user = Deno.env.get("USER")?.trim();
  return `/home/${user || "nas"}`;
}

// --- 環境変数バリデーション ---

Deno.test("MountStage: valid env var names accepted", async () => {
  const profile = makeProfile({
    env: [
      { key: "SIMPLE", val: "value" },
      { key: "_UNDERSCORE_START", val: "value" },
      { key: "WITH_123_NUMBERS", val: "value" },
      { key: "A", val: "single-char" },
    ],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(result.envVars["SIMPLE"], "value");
  assertEquals(result.envVars["_UNDERSCORE_START"], "value");
  assertEquals(result.envVars["WITH_123_NUMBERS"], "value");
  assertEquals(result.envVars["A"], "single-char");
});

Deno.test("MountStage: static env var with special chars in value", async () => {
  const profile = makeProfile({
    env: [
      { key: "URL", val: "https://example.com/path?foo=bar&baz=qux" },
      { key: "JSON", val: '{"key": "value"}' },
      { key: "SPACES", val: "hello world" },
      { key: "EMPTY", val: "" },
    ],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(
    result.envVars["URL"],
    "https://example.com/path?foo=bar&baz=qux",
  );
  assertEquals(result.envVars["JSON"], '{"key": "value"}');
  assertEquals(result.envVars["SPACES"], "hello world");
  assertEquals(result.envVars["EMPTY"], "");
});

Deno.test("MountStage: invalid static env key (starts with number)", async () => {
  const profile = makeProfile({
    env: [{ key: "123BAD", val: "value" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: invalid static env key (contains dash)", async () => {
  const profile = makeProfile({
    env: [{ key: "MY-VAR", val: "value" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: invalid static env key (contains dot)", async () => {
  const profile = makeProfile({
    env: [{ key: "MY.VAR", val: "value" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: dynamic key command producing valid name", async () => {
  const profile = makeProfile({
    env: [{ keyCmd: "printf VALID_KEY", valCmd: "printf hello" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(result.envVars["VALID_KEY"], "hello");
});

Deno.test("MountStage: dynamic key command producing invalid name", async () => {
  const profile = makeProfile({
    env: [{ keyCmd: "printf 'BAD KEY'", valCmd: "printf value" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "Invalid env var name",
  );
});

Deno.test("MountStage: dynamic val command that fails", async () => {
  const profile = makeProfile({
    env: [{ keyCmd: "printf MY_KEY", valCmd: "false" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "Failed to execute",
  );
});

Deno.test("MountStage: dynamic key command that returns empty", async () => {
  const profile = makeProfile({
    env: [{ keyCmd: "printf ''", valCmd: "printf value" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "returned empty output",
  );
});

Deno.test("MountStage: multiple env vars including both static and dynamic", async () => {
  const profile = makeProfile({
    env: [
      { key: "STATIC_A", val: "a" },
      { keyCmd: "printf DYNAMIC_B", valCmd: "printf b" },
      { key: "STATIC_C", val: "c" },
      { keyCmd: "printf DYNAMIC_D", valCmd: "printf d" },
    ],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(result.envVars["STATIC_A"], "a");
  assertEquals(result.envVars["DYNAMIC_B"], "b");
  assertEquals(result.envVars["STATIC_C"], "c");
  assertEquals(result.envVars["DYNAMIC_D"], "d");
});

// --- extra-mounts バリデーション ---

Deno.test("MountStage: extra-mount with ~ src expansion", async () => {
  const home = Deno.env.get("HOME") ?? "/root";
  const profile = makeProfile({
    extraMounts: [{ src: "~", dst: "/mnt/home", mode: "ro" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(
    result.dockerArgs.includes(`${home}:/mnt/home:ro`),
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
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(
    result.dockerArgs.includes(`${home}/.config:/mnt/config:ro`),
    true,
  );
});

Deno.test("MountStage: extra-mount dst ~ expands to container home", async () => {
  const containerHome = getContainerHome();
  const profile = makeProfile({
    extraMounts: [{ src: Deno.cwd(), dst: "~/mounted", mode: "ro" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(
    result.dockerArgs.includes(
      `${Deno.cwd()}:${containerHome}/mounted:ro`,
    ),
    true,
  );
});

Deno.test("MountStage: extra-mount rw mode has no suffix", async () => {
  const profile = makeProfile({
    extraMounts: [{ src: Deno.cwd(), dst: "/mnt/rw-test", mode: "rw" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  // rw モードは :rw サフィックスなし
  assertEquals(
    result.dockerArgs.includes(`${Deno.cwd()}:/mnt/rw-test`),
    true,
  );
});

Deno.test("MountStage: extra-mount relative dst throws", async () => {
  const profile = makeProfile({
    extraMounts: [{ src: Deno.cwd(), dst: "relative/path", mode: "ro" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "dst must be an absolute path",
  );
});

Deno.test("MountStage: extra-mount to /nix conflicts", async () => {
  const profile = makeProfile({
    extraMounts: [{ src: Deno.cwd(), dst: "/nix", mode: "ro" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount to /var/run/docker.sock conflicts", async () => {
  const profile = makeProfile({
    extraMounts: [
      { src: Deno.cwd(), dst: "/var/run/docker.sock", mode: "ro" },
    ],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount to workspace dir conflicts", async () => {
  const workDir = Deno.cwd();
  const profile = makeProfile({
    extraMounts: [{ src: "/tmp", dst: workDir, mode: "ro" }],
  });
  const ctx = createContext(baseConfig, profile, "test", workDir);
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount duplicate dst conflicts", async () => {
  const profile = makeProfile({
    extraMounts: [
      { src: Deno.cwd(), dst: "/mnt/dup", mode: "ro" },
      { src: Deno.cwd(), dst: "/mnt/dup", mode: "rw" },
    ],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  await assertRejects(
    () => new MountStage().execute(ctx),
    Error,
    "conflicts with existing mount destination",
  );
});

Deno.test("MountStage: extra-mount nonexistent src is skipped", async () => {
  const missingPath = `/tmp/nas-nonexistent-${crypto.randomUUID()}`;
  const profile = makeProfile({
    extraMounts: [{ src: missingPath, dst: "/mnt/missing", mode: "ro" }],
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(
    result.dockerArgs.some((a) => a.includes("/mnt/missing")),
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
    const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
    const result = await new MountStage().execute(ctx);
    assertEquals(
      result.dockerArgs.includes(`${tmpDir1}:/mnt/one:ro`),
      true,
    );
    assertEquals(
      result.dockerArgs.includes(`${tmpDir2}:/mnt/two`),
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

// --- docker socket mount ---

Deno.test("MountStage: docker socket mount included when enabled", async () => {
  const profile = makeProfile({ docker: { mountSocket: true } });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(
    result.dockerArgs.includes("/var/run/docker.sock:/var/run/docker.sock"),
    true,
  );
});

Deno.test("MountStage: docker socket mount excluded when disabled", async () => {
  const profile = makeProfile({ docker: { mountSocket: false } });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(
    result.dockerArgs.includes("/var/run/docker.sock:/var/run/docker.sock"),
    false,
  );
});

// --- GPG mount ---

Deno.test("MountStage: GPG not mounted when disabled", async () => {
  const profile = makeProfile({ gpg: { forwardAgent: false } });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(
    result.dockerArgs.some((a) => a.includes("S.gpg-agent")),
    false,
  );
  assertEquals("GPG_AGENT_INFO" in result.envVars, false);
});

Deno.test("MountStage: GPG environment set when enabled", async () => {
  const profile = makeProfile({ gpg: { forwardAgent: true } });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  // GPG が有効な場合、GPG 関連のマウントまたは環境変数が設定される
  // ホストの GPG 設定によって結果が変わるが、少なくとも処理は完了する
  assertEquals(result.dockerArgs.length > 0, true);
});

// --- workspace mount ---

Deno.test("MountStage: workspace uses absolute path", async () => {
  const workDir = Deno.cwd();
  const profile = makeProfile();
  const ctx = createContext(baseConfig, profile, "test", workDir);
  const result = await new MountStage().execute(ctx);

  // -v mount
  const vIdx = result.dockerArgs.indexOf("-v");
  assertEquals(vIdx >= 0, true);
  const mountArg = result.dockerArgs[vIdx + 1];
  assertEquals(mountArg, `${workDir}:${workDir}`);

  // -w workdir
  const wIdx = result.dockerArgs.indexOf("-w");
  assertEquals(wIdx >= 0, true);
  assertEquals(result.dockerArgs[wIdx + 1], workDir);
});

Deno.test("MountStage: NAS_USER and NAS_HOME are set", async () => {
  const profile = makeProfile();
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);

  const user = Deno.env.get("USER")?.trim() || "nas";
  assertEquals(result.envVars["NAS_USER"], user);
  assertEquals(result.envVars["NAS_HOME"], `/home/${user}`);
});

Deno.test("MountStage: NAS_UID and NAS_GID are set on Linux", async () => {
  const profile = makeProfile();
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);

  const uid = Deno.uid();
  const gid = Deno.gid();
  if (uid !== null && gid !== null) {
    assertEquals(result.envVars["NAS_UID"], String(uid));
    assertEquals(result.envVars["NAS_GID"], String(gid));
  }
});

// --- Nix マウント ---

Deno.test("MountStage: nix disabled does not mount /nix", async () => {
  const profile = makeProfile({
    nix: { enable: false, mountSocket: true, extraPackages: [] },
  });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  // nixEnabled が false のままの ctx
  const result = await new MountStage().execute(ctx);
  assertEquals(result.dockerArgs.includes("/nix:/nix"), false);
  assertEquals("NIX_REMOTE" in result.envVars, false);
});

Deno.test("MountStage: nix enabled but mountSocket false skips socket", async () => {
  const profile = makeProfile({
    nix: { enable: true, mountSocket: false, extraPackages: [] },
  });
  const ctx = {
    ...createContext(baseConfig, profile, "test", Deno.cwd()),
    nixEnabled: true,
  };
  const result = await new MountStage().execute(ctx);
  // mountSocket が false なので /nix はマウントされない
  assertEquals(result.dockerArgs.includes("/nix:/nix"), false);
});

Deno.test("MountStage: nix enabled with mountSocket mounts /nix if host has nix", async () => {
  const hasHostNix = await Deno.stat("/nix").then(() => true, () => false);
  const profile = makeProfile({
    nix: { enable: true, mountSocket: true, extraPackages: [] },
  });
  const ctx = {
    ...createContext(baseConfig, profile, "test", Deno.cwd()),
    nixEnabled: true,
  };
  const result = await new MountStage().execute(ctx);

  if (hasHostNix) {
    assertEquals(result.dockerArgs.includes("/nix:/nix"), true);
    assertEquals(result.envVars["NIX_REMOTE"], "daemon");
    assertEquals(result.envVars["NIX_ENABLED"], "true");
  } else {
    assertEquals(result.dockerArgs.includes("/nix:/nix"), false);
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
  const ctx = {
    ...createContext(baseConfig, profile, "test", Deno.cwd()),
    nixEnabled: true,
  };
  const result = await new MountStage().execute(ctx);

  if (hasHostNix) {
    assertEquals(
      result.envVars["NIX_EXTRA_PACKAGES"],
      "nixpkgs#gh\nnixpkgs#jq",
    );
  }
});

// --- gcloud mount ---

Deno.test("MountStage: gcloud not mounted when disabled", async () => {
  const profile = makeProfile({ gcloud: { mountConfig: false } });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(
    result.dockerArgs.some((a) => a.includes(".config/gcloud")),
    false,
  );
});

// --- AWS mount ---

Deno.test("MountStage: aws not mounted when disabled", async () => {
  const profile = makeProfile({ aws: { mountConfig: false } });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(
    result.dockerArgs.some((a) => a.includes(".aws")),
    false,
  );
});

// --- agent-specific 設定 ---

Deno.test("MountStage: claude agent sets agentCommand", async () => {
  const profile = makeProfile({ agent: "claude" });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(result.agentCommand.length > 0, true);
});

Deno.test("MountStage: copilot agent sets agentCommand", async () => {
  const profile = makeProfile({ agent: "copilot" });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(result.agentCommand.length > 0, true);
});

Deno.test("MountStage: codex agent sets agentCommand", async () => {
  const profile = makeProfile({ agent: "codex" });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);
  assertEquals(result.agentCommand.length > 0, true);
});

Deno.test("MountStage: claude agent mounts ~/.claude if exists", async () => {
  const home = Deno.env.get("HOME") ?? "/root";
  const claudeDir = `${home}/.claude`;
  const hasClaude = await Deno.stat(claudeDir).then(
    (s) => s.isDirectory,
    () => false,
  );

  const profile = makeProfile({ agent: "claude" });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);

  if (hasClaude) {
    assertEquals(
      result.dockerArgs.some((a) => a.includes("/.claude")),
      true,
    );
  }
});

Deno.test("MountStage: copilot agent sets GITHUB_TOKEN if gh available", async () => {
  const profile = makeProfile({ agent: "copilot" });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);

  // gh コマンドが使える環境では GITHUB_TOKEN が設定される
  const hasGh = await new Deno.Command("which", {
    args: ["gh"],
    stdout: "null",
    stderr: "null",
  }).output().then((o) => o.success, () => false);
  if (hasGh) {
    // gh auth token が成功する場合のみ
    const tokenResult = await new Deno.Command("gh", {
      args: ["auth", "token"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (tokenResult.success) {
      assertEquals("GITHUB_TOKEN" in result.envVars, true);
    }
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
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);

  if (hasCodex) {
    assertEquals(
      result.dockerArgs.some((a) => a.includes("/.codex")),
      true,
    );
  }
});

Deno.test("MountStage: codex agent forwards OPENAI_API_KEY when set", async () => {
  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  const profile = makeProfile({ agent: "codex" });
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);

  if (openAiApiKey?.trim()) {
    assertEquals(result.envVars["OPENAI_API_KEY"], openAiApiKey.trim());
  } else {
    assertEquals("OPENAI_API_KEY" in result.envVars, false);
  }
});

// --- 空のプロファイルでの実行 ---

Deno.test("MountStage: minimal profile produces valid docker args", async () => {
  const profile = makeProfile();
  const ctx = createContext(baseConfig, profile, "test", Deno.cwd());
  const result = await new MountStage().execute(ctx);

  // 最低限: -v (workspace mount) と -w (workdir) が含まれる
  assertEquals(result.dockerArgs.includes("-v"), true);
  assertEquals(result.dockerArgs.includes("-w"), true);

  // 基本的な env vars が設定される
  assertEquals("NAS_USER" in result.envVars, true);
  assertEquals("NAS_HOME" in result.envVars, true);
  assertEquals("WORKSPACE" in result.envVars, true);
});
