/**
 * Container integration tests: Docker イメージと entrypoint の実起動
 *
 * ここで検証するのは nas CLI 全体ではなく、ビルド済みイメージ + entrypoint.sh の
 * 実動作。Docker コンテナを直接起動し、UID/GID マッピング、ワークスペース
 * マウント、git safe.directory、Nix 統合などを確認する。
 *
 * CLI 経路の E2E は tests/cli_e2e_test.ts に分離する。
 *
 * 前提条件: Docker デーモンが起動していること
 *
 * bind mount を伴うテスト:
 *   DinD 環境ではエージェントコンテナと DinD サイドカーの間で共有ボリューム
 *   (/tmp/nas-shared) を使い、DinD デーモンから bind mount 可能にする。
 *   NAS_DIND_SHARED_TMP 環境変数が設定されていない場合、ホスト Docker を前提に
 *   /tmp 直下を使用する。
 */

import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import { DEFAULT_NETWORK_CONFIG } from "../src/config/types.ts";
import { createContext } from "../src/pipeline/context.ts";
import { runPipeline } from "../src/pipeline/pipeline.ts";
import { DockerBuildStage } from "../src/stages/launch.ts";

const IMAGE_NAME = "nas-sandbox";

// DinD 共有 tmp が利用可能なら bind mount テストで使う。
// なければホスト Docker 前提で /tmp を使う。
const SHARED_TMP = Deno.env.get("NAS_DIND_SHARED_TMP");
const DOCKER_HOST = Deno.env.get("DOCKER_HOST");
const USING_DIND = SHARED_TMP !== undefined && DOCKER_HOST !== undefined;
const RUNNING_ON_HOST_DOCKER = !USING_DIND;

/**
 * テスト用一時ディレクトリを作成する。
 * DinD 環境では共有ボリューム配下、ホスト環境では /tmp 直下に作成。
 */
async function makeTempDir(prefix: string): Promise<string> {
  const base = SHARED_TMP ?? "/tmp";
  const name = `${prefix}${crypto.randomUUID().slice(0, 8)}`;
  const dir = `${base}/${name}`;
  await Deno.mkdir(dir, { recursive: true });
  if (SHARED_TMP) {
    // Deno.mkdir の mode では sticky bit が落ちるため、作成後に明示設定する。
    await Deno.chmod(dir, 0o1777);
  }
  return dir;
}

async function makeTreeWritableForDind(root: string): Promise<void> {
  if (!USING_DIND) return;

  for await (const entry of Deno.readDir(root)) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory) {
      await makeTreeWritableForDind(child);
      await Deno.chmod(child, 0o1777);
    } else if (entry.isFile) {
      const stat = await Deno.stat(child);
      const mode = stat.mode ?? 0;
      await Deno.chmod(child, (mode & 0o111) === 0 ? 0o666 : 0o777);
    }
  }

  await Deno.chmod(root, 0o1777);
}

// --- ヘルパー ---

/** Docker が利用可能かチェック */
async function isDockerAvailable(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("docker", {
      args: ["info"],
      stdout: "null",
      stderr: "null",
    });
    const status = await cmd.output();
    return status.success;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();

/** Docker イメージをビルド（初回のみ） */
let imageBuilt = false;
async function ensureImage(): Promise<void> {
  if (imageBuilt) return;
  const profile = {
    agent: "claude" as const,
    agentArgs: [],
    nix: { enable: false as const, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    extraMounts: [],
    env: [],
  };
  const config = { default: "test", profiles: { test: profile } };
  const ctx = createContext(config, profile, "test", "/tmp");
  await runPipeline([new DockerBuildStage()], ctx);
  imageBuilt = true;
}

/**
 * テスト用 docker run。
 * entrypoint.sh を通して testCommand を実行し、出力をキャプチャする。
 */
async function dockerRun(
  testCommand: string[],
  options: {
    workDir?: string;
    envVars?: Record<string, string>;
    extraArgs?: string[];
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  await ensureImage();

  const uid = Deno.uid() ?? 1000;
  const gid = Deno.gid() ?? 1000;
  const user = Deno.env.get("USER")?.trim() || "nas";
  const workDir = options.workDir ?? "/tmp";

  const args: string[] = [
    "run",
    "--rm",
    "-e",
    `WORKSPACE=${workDir}`,
    "-e",
    `NAS_UID=${uid}`,
    "-e",
    `NAS_GID=${gid}`,
    "-e",
    `NAS_USER=${user}`,
    "-e",
    `NAS_HOME=/home/${user}`,
  ];

  for (const [key, value] of Object.entries(options.envVars ?? {})) {
    args.push("-e", `${key}=${value}`);
  }

  args.push("-v", `${workDir}:${workDir}`);
  args.push("-w", workDir);

  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }

  args.push(IMAGE_NAME);
  args.push(...testCommand);

  const cmd = new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

// ============================================================
// 基本テスト (bind mount 不要 — DinD/ホストどちらでも動く)
// ============================================================

Deno.test({
  name: "Integration: container runs command and exits 0",
  ignore: !dockerAvailable,
  async fn() {
    const result = await dockerRun(["echo", "hello from nas"]);
    assertEquals(result.code, 0);
    assertEquals(result.stdout.trim(), "hello from nas");
  },
});

Deno.test({
  name: "Integration: non-zero exit code is propagated",
  ignore: !dockerAvailable,
  async fn() {
    const result = await dockerRun(["bash", "-c", "exit 42"]);
    assertEquals(result.code, 42);
  },
});

Deno.test({
  name: "Integration: entrypoint drops to host UID/GID",
  ignore: !dockerAvailable,
  async fn() {
    const result = await dockerRun(["id"]);
    assertEquals(result.code, 0);

    const hostUid = Deno.uid();
    const hostGid = Deno.gid();
    if (hostUid !== null && hostGid !== null) {
      assertEquals(
        result.stdout.includes(`uid=${hostUid}`),
        true,
        `Expected uid=${hostUid} in: ${result.stdout}`,
      );
      assertEquals(
        result.stdout.includes(`gid=${hostGid}`),
        true,
        `Expected gid=${hostGid} in: ${result.stdout}`,
      );
    }
  },
});

Deno.test({
  name: "Integration: USER and HOME are set correctly",
  ignore: !dockerAvailable,
  async fn() {
    const result = await dockerRun(["bash", "-c", "echo $USER:$HOME"]);
    assertEquals(result.code, 0);

    const hostUser = Deno.env.get("USER")?.trim() || "nas";
    assertEquals(result.stdout.trim(), `${hostUser}:/home/${hostUser}`);
  },
});

Deno.test({
  name: "Integration: home directory exists and is owned by user",
  ignore: !dockerAvailable,
  async fn() {
    const result = await dockerRun([
      "bash",
      "-c",
      "stat -c '%U:%G' $HOME",
    ]);
    assertEquals(result.code, 0);

    const hostUser = Deno.env.get("USER")?.trim() || "nas";
    assertEquals(result.stdout.trim(), `${hostUser}:${hostUser}`);
  },
});

Deno.test({
  name: "Integration: custom env vars are passed to container",
  ignore: !dockerAvailable,
  async fn() {
    const result = await dockerRun(
      ["bash", "-c", "echo $MY_VAR:$OTHER_VAR"],
      { envVars: { MY_VAR: "hello", OTHER_VAR: "world" } },
    );
    assertEquals(result.code, 0);
    assertEquals(result.stdout.trim(), "hello:world");
  },
});

Deno.test({
  name: "Integration: env var with special characters",
  ignore: !dockerAvailable,
  async fn() {
    const result = await dockerRun(
      ["bash", "-c", "echo $SPECIAL_VAR"],
      { envVars: { SPECIAL_VAR: "https://example.com?foo=bar&baz=qux" } },
    );
    assertEquals(result.code, 0);
    assertEquals(
      result.stdout.trim(),
      "https://example.com?foo=bar&baz=qux",
    );
  },
});

Deno.test({
  name: "Integration: container has required tools installed",
  ignore: !dockerAvailable,
  async fn() {
    const tools = [
      "git",
      "curl",
      "bash",
      "python3",
      "node",
      "gh",
      "rg",
      "fd",
      "jq",
      "docker",
    ];
    for (const tool of tools) {
      const result = await dockerRun(["which", tool]);
      assertEquals(
        result.code,
        0,
        `Expected ${tool} to be available, stderr: ${result.stderr}`,
      );
    }
  },
});

// ============================================================
// bind mount テスト (共有 tmp 経由 — DinD/ホスト両対応)
// ============================================================

// DinD 環境で共有ボリュームがない場合はスキップ。
// ホスト Docker (DOCKER_HOST 未設定) の場合は /tmp が使えるので常に動く。
const canBindMount = dockerAvailable &&
  (SHARED_TMP !== undefined || !Deno.env.get("DOCKER_HOST"));

Deno.test({
  name: "Integration: workspace is mounted and files are accessible",
  ignore: !canBindMount,
  async fn() {
    const tmpDir = await makeTempDir("nas-e2e-ws-");
    try {
      await Deno.writeTextFile(
        path.join(tmpDir, "testfile.txt"),
        "e2e-test-content",
      );

      const result = await dockerRun(
        ["cat", path.join(tmpDir, "testfile.txt")],
        { workDir: tmpDir },
      );
      assertEquals(result.code, 0);
      assertEquals(result.stdout.trim(), "e2e-test-content");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Integration: working directory is set to workspace",
  ignore: !canBindMount,
  async fn() {
    const tmpDir = await makeTempDir("nas-e2e-pwd-");
    try {
      const result = await dockerRun(["pwd"], { workDir: tmpDir });
      assertEquals(result.code, 0);
      assertEquals(result.stdout.trim(), tmpDir);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Integration: files created in container are visible on host",
  ignore: !canBindMount,
  async fn() {
    const tmpDir = await makeTempDir("nas-e2e-write-");
    try {
      const result = await dockerRun(
        ["bash", "-c", "echo container-output > output.txt"],
        { workDir: tmpDir },
      );
      assertEquals(result.code, 0);

      const content = await Deno.readTextFile(
        path.join(tmpDir, "output.txt"),
      );
      assertEquals(content.trim(), "container-output");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Integration: file ownership in workspace matches host user",
  ignore: !canBindMount,
  async fn() {
    const tmpDir = await makeTempDir("nas-e2e-own-");
    try {
      const result = await dockerRun(
        ["bash", "-c", "touch newfile.txt && stat -c '%u:%g' newfile.txt"],
        { workDir: tmpDir },
      );
      assertEquals(result.code, 0);

      const hostUid = Deno.uid();
      const hostGid = Deno.gid();
      if (hostUid !== null && hostGid !== null) {
        assertEquals(result.stdout.trim(), `${hostUid}:${hostGid}`);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Integration: git safe.directory is configured for workspace",
  ignore: !canBindMount,
  async fn() {
    const tmpDir = await makeTempDir("nas-e2e-git-");
    try {
      for (
        const gitArgs of [
          ["init", tmpDir],
          ["-C", tmpDir, "config", "user.name", "test"],
          ["-C", tmpDir, "config", "user.email", "test@test.com"],
          ["-C", tmpDir, "config", "commit.gpgsign", "false"],
        ]
      ) {
        await new Deno.Command("git", {
          args: gitArgs,
          stdout: "null",
          stderr: "null",
        }).output();
      }
      await Deno.writeTextFile(path.join(tmpDir, "hello.txt"), "hello");
      await new Deno.Command("git", {
        args: ["-C", tmpDir, "add", "."],
        stdout: "null",
        stderr: "null",
      }).output();
      await new Deno.Command("git", {
        args: ["-C", tmpDir, "commit", "-m", "init"],
        stdout: "null",
        stderr: "null",
      }).output();

      const result = await dockerRun(
        ["git", "status", "--porcelain"],
        { workDir: tmpDir },
      );
      assertEquals(result.code, 0);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Integration [host-only]: git commit works inside container",
  // rootless DinD 経由の bind mount では git object/index の新規作成が
  // remapped UID + デフォルト権限に引っ張られ、host Docker と同じ挙動にならない。
  ignore: !canBindMount || !RUNNING_ON_HOST_DOCKER,
  async fn() {
    const tmpDir = await makeTempDir("nas-e2e-gitc-");
    try {
      for (
        const gitArgs of [
          ["init", tmpDir],
          ["-C", tmpDir, "config", "user.name", "test"],
          ["-C", tmpDir, "config", "user.email", "test@test.com"],
          ["-C", tmpDir, "config", "commit.gpgsign", "false"],
        ]
      ) {
        await new Deno.Command("git", {
          args: gitArgs,
          stdout: "null",
          stderr: "null",
        }).output();
      }
      await new Deno.Command("git", {
        args: ["-C", tmpDir, "commit", "--allow-empty", "-m", "init"],
        stdout: "null",
        stderr: "null",
      }).output();
      await makeTreeWritableForDind(tmpDir);

      const result = await dockerRun(
        [
          "bash",
          "-c",
          'echo hello > new.txt && git add new.txt && git commit -m "from container" && git log --oneline -1',
        ],
        { workDir: tmpDir },
      );
      assertEquals(result.code, 0);
      assertEquals(result.stdout.includes("from container"), true);

      // このコンテナからもコミットが見える
      const logCmd = await new Deno.Command("git", {
        args: ["-C", tmpDir, "log", "--oneline", "-1"],
        stdout: "piped",
        stderr: "null",
      }).output();
      const log = new TextDecoder().decode(logCmd.stdout).trim();
      assertEquals(log.includes("from container"), true);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Integration: extra mount (ro) is accessible in container",
  ignore: !canBindMount,
  async fn() {
    const mountSrc = await makeTempDir("nas-e2e-mnt-");
    const workDir = await makeTempDir("nas-e2e-ws-");
    try {
      await Deno.writeTextFile(
        path.join(mountSrc, "data.txt"),
        "mounted-content",
      );

      const result = await dockerRun(
        ["cat", "/mnt/test/data.txt"],
        {
          workDir,
          extraArgs: ["-v", `${mountSrc}:/mnt/test:ro`],
        },
      );
      assertEquals(result.code, 0);
      assertEquals(result.stdout.trim(), "mounted-content");
    } finally {
      await Deno.remove(mountSrc, { recursive: true });
      await Deno.remove(workDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Integration: extra mount (rw) allows writing from container",
  ignore: !canBindMount,
  async fn() {
    const mountSrc = await makeTempDir("nas-e2e-rw-");
    const workDir = await makeTempDir("nas-e2e-ws-");
    try {
      const result = await dockerRun(
        [
          "bash",
          "-c",
          "echo written > /mnt/rw/output.txt && cat /mnt/rw/output.txt",
        ],
        {
          workDir,
          extraArgs: ["-v", `${mountSrc}:/mnt/rw`],
        },
      );
      assertEquals(result.code, 0);
      assertEquals(result.stdout.trim(), "written");

      const content = await Deno.readTextFile(
        path.join(mountSrc, "output.txt"),
      );
      assertEquals(content.trim(), "written");
    } finally {
      await Deno.remove(mountSrc, { recursive: true });
      await Deno.remove(workDir, { recursive: true });
    }
  },
});

// ============================================================
// Nix 統合 (ホスト Docker + /nix が必要)
// ============================================================

const hasHostNix = await Deno.stat("/nix").then(() => true, () => false);
const canMountHostNix = hasHostNix && RUNNING_ON_HOST_DOCKER;

Deno.test({
  name:
    "Integration [host-only]: nix enabled - /nix is accessible and nix --version works",
  ignore: !canBindMount || !canMountHostNix,
  async fn() {
    const workDir = await makeTempDir("nas-e2e-nix-");
    try {
      let nixBinPath: string | null = null;
      for (
        const p of [
          "/nix/var/nix/profiles/default/bin/nix",
          "/run/current-system/sw/bin/nix",
        ]
      ) {
        try {
          const real = await Deno.realPath(p);
          if (real.startsWith("/nix/store/")) {
            nixBinPath = real;
            break;
          }
        } catch { /* ignore */ }
      }

      let nixConfPath: string | null = null;
      try {
        const cmd = new Deno.Command("readlink", {
          args: ["-f", "/etc/nix/nix.conf"],
          stdout: "piped",
          stderr: "null",
        });
        const out = await cmd.output();
        if (out.success) {
          nixConfPath = new TextDecoder().decode(out.stdout).trim();
        }
      } catch { /* ignore */ }

      const extraArgs = ["-v", "/nix:/nix"];
      const envVars: Record<string, string> = {
        NIX_REMOTE: "daemon",
        NIX_ENABLED: "true",
      };
      if (nixBinPath) envVars["NIX_BIN_PATH"] = nixBinPath;
      if (nixConfPath) {
        if (nixConfPath.startsWith("/nix/")) {
          envVars["NIX_CONF_PATH"] = nixConfPath;
        } else {
          extraArgs.push("-v", `${nixConfPath}:/tmp/nas-host-nix.conf:ro`);
          envVars["NIX_CONF_PATH"] = "/tmp/nas-host-nix.conf";
        }
      }

      const lsResult = await dockerRun(
        ["ls", "/nix"],
        { workDir, envVars, extraArgs },
      );
      assertEquals(lsResult.code, 0);
      assertEquals(lsResult.stdout.includes("store"), true);

      const nixResult = await dockerRun(
        ["nix", "--version"],
        { workDir, envVars, extraArgs },
      );
      assertEquals(nixResult.code, 0);
      assertEquals(nixResult.stdout.toLowerCase().includes("nix"), true);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Integration: nix disabled - /nix/store is not accessible",
  ignore: !dockerAvailable,
  async fn() {
    const result = await dockerRun([
      "bash",
      "-c",
      "test -d /nix/store && echo mounted || echo not-mounted",
    ]);
    assertEquals(result.code, 0);
    assertEquals(result.stdout.trim(), "not-mounted");
  },
});
