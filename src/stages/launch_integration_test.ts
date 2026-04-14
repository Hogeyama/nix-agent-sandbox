import { expect, test } from "bun:test";

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

import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import { buildHostEnv, resolveProbes } from "../pipeline/host_env.ts";
import type { PriorStageOutputs } from "../pipeline/types.ts";
import { DockerServiceLive } from "../services/docker.ts";
import { DockerBuildServiceLive } from "../services/docker_build.ts";
import { FsServiceLive } from "../services/fs.ts";
import { createDockerBuildStage, resolveBuildProbes } from "./docker_build.ts";

const IMAGE_NAME = "nas-sandbox";

// DinD 共有 tmp が利用可能なら bind mount テストで使う。
// なければホスト Docker 前提で /tmp を使う。
const SHARED_TMP = process.env.NAS_DIND_SHARED_TMP;
const DOCKER_HOST = process.env.DOCKER_HOST;
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
  await mkdir(dir, { recursive: true });
  if (SHARED_TMP) {
    // Deno.mkdir の mode では sticky bit が落ちるため、作成後に明示設定する。
    await chmod(dir, 0o1777);
  }
  return dir;
}

async function makeTreeWritableForDind(root: string): Promise<void> {
  if (!USING_DIND) return;

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await makeTreeWritableForDind(child);
      await chmod(child, 0o1777);
    } else if (entry.isFile()) {
      const s = await stat(child);
      const mode = s.mode ?? 0;
      await chmod(child, (mode & 0o111) === 0 ? 0o666 : 0o777);
    }
  }

  await chmod(root, 0o1777);
}

// --- ヘルパー ---

/** Docker が利用可能かチェック */
async function isDockerAvailable(): Promise<boolean> {
  try {
    const exitCode = await Bun.spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

const dockerAvailable = await isDockerAvailable();

/** Docker イメージをビルド（初回のみ） */
let imageBuilt = false;
async function ensureImage(): Promise<void> {
  if (imageBuilt) return;
  const imageName = IMAGE_NAME;
  const buildProbes = await resolveBuildProbes(imageName);
  const stage = createDockerBuildStage(buildProbes);

  const profile = {
    agent: "claude" as const,
    agentArgs: [],
    nix: { enable: false as const, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
  };
  const config = {
    default: "test",
    profiles: { test: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  const hostEnv = buildHostEnv();
  const probes = await resolveProbes(hostEnv);
  const prior: PriorStageOutputs = {
    dockerArgs: [],
    envVars: {},
    workDir: "/tmp",
    nixEnabled: false,
    imageName,
    agentCommand: [],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
  };
  await Effect.runPromise(
    Effect.scoped(
      stage
        .run({
          config,
          profile,
          profileName: "test",
          sessionId: "sess_test",
          host: hostEnv,
          probes,
          prior,
        })
        .pipe(
          Effect.provide(
            DockerBuildServiceLive.pipe(
              Layer.provide(Layer.merge(FsServiceLive, DockerServiceLive)),
            ),
          ),
        ),
    ),
  );
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

  const uid = process.getuid!() ?? 1000;
  const gid = process.getgid!() ?? 1000;
  const user = process.env.USER?.trim() || "nas";
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

  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

// ============================================================
// 基本テスト (bind mount 不要 — DinD/ホストどちらでも動く)
// ============================================================

test.skipIf(!dockerAvailable)(
  "Integration: container runs command and exits 0",
  async () => {
    const result = await dockerRun(["echo", "hello from nas"]);
    expect(result.code).toEqual(0);
    expect(result.stdout.trim()).toEqual("hello from nas");
  },
);

test.skipIf(!dockerAvailable)(
  "Integration: non-zero exit code is propagated",
  async () => {
    const result = await dockerRun(["bash", "-c", "exit 42"]);
    expect(result.code).toEqual(42);
  },
);

test.skipIf(!dockerAvailable)(
  "Integration: entrypoint drops to host UID/GID",
  async () => {
    const result = await dockerRun(["id"]);
    expect(result.code).toEqual(0);

    const hostUid = process.getuid!();
    const hostGid = process.getgid!();
    if (hostUid !== null && hostGid !== null) {
      expect(result.stdout.includes(`uid=${hostUid}`)).toEqual(true);
      expect(result.stdout.includes(`gid=${hostGid}`)).toEqual(true);
    }
  },
);

test.skipIf(!dockerAvailable)(
  "Integration: USER and HOME are set correctly",
  async () => {
    const result = await dockerRun(["bash", "-c", "echo $USER:$HOME"]);
    expect(result.code).toEqual(0);

    const hostUser = process.env.USER?.trim() || "nas";
    expect(result.stdout.trim()).toEqual(`${hostUser}:/home/${hostUser}`);
  },
);

test.skipIf(!dockerAvailable)(
  "Integration: home directory exists and is owned by user",
  async () => {
    const result = await dockerRun(["bash", "-c", "stat -c '%U:%G' $HOME"]);
    expect(result.code).toEqual(0);

    const hostUser = process.env.USER?.trim() || "nas";
    expect(result.stdout.trim()).toEqual(`${hostUser}:${hostUser}`);
  },
);

test.skipIf(!dockerAvailable)(
  "Integration: custom env vars are passed to container",
  async () => {
    const result = await dockerRun(["bash", "-c", "echo $MY_VAR:$OTHER_VAR"], {
      envVars: { MY_VAR: "hello", OTHER_VAR: "world" },
    });
    expect(result.code).toEqual(0);
    expect(result.stdout.trim()).toEqual("hello:world");
  },
);

test.skipIf(!dockerAvailable)(
  "Integration: env var with special characters",
  async () => {
    const result = await dockerRun(["bash", "-c", "echo $SPECIAL_VAR"], {
      envVars: { SPECIAL_VAR: "https://example.com?foo=bar&baz=qux" },
    });
    expect(result.code).toEqual(0);
    expect(result.stdout.trim()).toEqual("https://example.com?foo=bar&baz=qux");
  },
);

test.skipIf(!dockerAvailable)(
  "Integration: container has required tools installed",
  async () => {
    const tools = [
      "git",
      "curl",
      "bash",
      "python3",
      "bun",
      "gh",
      "rg",
      "fd",
      "jq",
      "docker",
    ];
    for (const tool of tools) {
      const result = await dockerRun(["which", tool]);
      expect(result.code).toEqual(0);
    }
  },
  30_000,
);

// ============================================================
// bind mount テスト (共有 tmp 経由 — DinD/ホスト両対応)
// ============================================================

// DinD 環境で共有ボリュームがない場合はスキップ。
// ホスト Docker (DOCKER_HOST 未設定) の場合は /tmp が使えるので常に動く。
const canBindMount =
  dockerAvailable && (SHARED_TMP !== undefined || !process.env.DOCKER_HOST);

test.skipIf(!canBindMount)(
  "Integration: workspace is mounted and files are accessible",
  async () => {
    const tmpDir = await makeTempDir("nas-e2e-ws-");
    try {
      await writeFile(path.join(tmpDir, "testfile.txt"), "e2e-test-content");

      const result = await dockerRun(
        ["cat", path.join(tmpDir, "testfile.txt")],
        { workDir: tmpDir },
      );
      expect(result.code).toEqual(0);
      expect(result.stdout.trim()).toEqual("e2e-test-content");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount)(
  "Integration: working directory is set to workspace",
  async () => {
    const tmpDir = await makeTempDir("nas-e2e-pwd-");
    try {
      const result = await dockerRun(["pwd"], { workDir: tmpDir });
      expect(result.code).toEqual(0);
      expect(result.stdout.trim()).toEqual(tmpDir);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount)(
  "Integration: files created in container are visible on host",
  async () => {
    const tmpDir = await makeTempDir("nas-e2e-write-");
    try {
      const result = await dockerRun(
        ["bash", "-c", "echo container-output > output.txt"],
        { workDir: tmpDir },
      );
      expect(result.code).toEqual(0);

      const content = await readFile(path.join(tmpDir, "output.txt"), "utf8");
      expect(content.trim()).toEqual("container-output");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount)(
  "Integration: file ownership in workspace matches host user",
  async () => {
    const tmpDir = await makeTempDir("nas-e2e-own-");
    try {
      const result = await dockerRun(
        ["bash", "-c", "touch newfile.txt && stat -c '%u:%g' newfile.txt"],
        { workDir: tmpDir },
      );
      expect(result.code).toEqual(0);

      const hostUid = process.getuid!();
      const hostGid = process.getgid!();
      if (hostUid !== null && hostGid !== null) {
        expect(result.stdout.trim()).toEqual(`${hostUid}:${hostGid}`);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount)(
  "Integration: git safe.directory is configured for workspace",
  async () => {
    const tmpDir = await makeTempDir("nas-e2e-git-");
    try {
      for (const gitArgs of [
        ["init", tmpDir],
        ["-C", tmpDir, "config", "user.name", "test"],
        ["-C", tmpDir, "config", "user.email", "test@test.com"],
        ["-C", tmpDir, "config", "commit.gpgsign", "false"],
      ]) {
        await Bun.spawn(["git", ...gitArgs], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited;
      }
      await writeFile(path.join(tmpDir, "hello.txt"), "hello");
      await Bun.spawn(["git", "-C", tmpDir, "add", "."], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
      await Bun.spawn(["git", "-C", tmpDir, "commit", "-m", "init"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;

      const result = await dockerRun(["git", "status", "--porcelain"], {
        workDir: tmpDir,
      });
      expect(result.code).toEqual(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount)(
  "Integration: hostexec wrapper is activated for agent command, not entrypoint bootstrap",
  async () => {
    const wrapperDir = await makeTempDir("nas-e2e-hostexec-");
    const workDir = await makeTempDir("nas-e2e-hostexec-ws-");
    const containerWrapperDir = "/tmp/nas-hostexec-wrapper";
    try {
      await writeFile(
        path.join(wrapperDir, "git"),
        `#!/bin/sh
if [ "$1" = "config" ] && [ "$2" = "--system" ] && [ "$3" = "safe.directory" ]; then
  echo "entrypoint should bypass hostexec wrapper" >&2
  exit 88
fi
echo wrapped-git
`,
      );
      await chmod(path.join(wrapperDir, "git"), 0o755);

      const result = await dockerRun(["git"], {
        workDir,
        envVars: {
          NAS_HOSTEXEC_WRAPPER_DIR: containerWrapperDir,
        },
        extraArgs: ["-v", `${wrapperDir}:${containerWrapperDir}:ro`],
      });

      expect(result.code).toEqual(0);
      expect(result.stdout.trim()).toEqual("wrapped-git");
      expect(
        result.stderr.includes("entrypoint should bypass hostexec wrapper"),
      ).toEqual(false);
    } finally {
      await rm(wrapperDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount || !RUNNING_ON_HOST_DOCKER)(
  "Integration [host-only]: git commit works inside container",
  async () => {
    const tmpDir = await makeTempDir("nas-e2e-gitc-");
    try {
      for (const gitArgs of [
        ["init", tmpDir],
        ["-C", tmpDir, "config", "user.name", "test"],
        ["-C", tmpDir, "config", "user.email", "test@test.com"],
        ["-C", tmpDir, "config", "commit.gpgsign", "false"],
      ]) {
        await Bun.spawn(["git", ...gitArgs], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited;
      }
      await Bun.spawn(
        ["git", "-C", tmpDir, "commit", "--allow-empty", "-m", "init"],
        { stdout: "ignore", stderr: "ignore" },
      ).exited;
      await makeTreeWritableForDind(tmpDir);

      const result = await dockerRun(
        [
          "bash",
          "-c",
          'echo hello > new.txt && git add new.txt && git commit -m "from container" && git log --oneline -1',
        ],
        { workDir: tmpDir },
      );
      expect(result.code).toEqual(0);
      expect(result.stdout.includes("from container")).toEqual(true);

      // このコンテナからもコミットが見える
      const logCmd = Bun.spawn(
        ["git", "-C", tmpDir, "log", "--oneline", "-1"],
        { stdout: "pipe", stderr: "ignore" },
      );
      const log = (await new Response(logCmd.stdout).text()).trim();
      expect(log.includes("from container")).toEqual(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount)(
  "Integration: extra mount (ro) is accessible in container",
  async () => {
    const mountSrc = await makeTempDir("nas-e2e-mnt-");
    const workDir = await makeTempDir("nas-e2e-ws-");
    try {
      await writeFile(path.join(mountSrc, "data.txt"), "mounted-content");

      const result = await dockerRun(["cat", "/mnt/test/data.txt"], {
        workDir,
        extraArgs: ["-v", `${mountSrc}:/mnt/test:ro`],
      });
      expect(result.code).toEqual(0);
      expect(result.stdout.trim()).toEqual("mounted-content");
    } finally {
      await rm(mountSrc, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount)(
  "Integration: extra mount (rw) allows writing from container",
  async () => {
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
      expect(result.code).toEqual(0);
      expect(result.stdout.trim()).toEqual("written");

      const content = await readFile(path.join(mountSrc, "output.txt"), "utf8");
      expect(content.trim()).toEqual("written");
    } finally {
      await rm(mountSrc, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

// ============================================================
// Nix 統合 (ホスト Docker + /nix が必要)
// ============================================================

const hasHostNix = await stat("/nix").then(
  () => true,
  () => false,
);
const canMountHostNix = hasHostNix && RUNNING_ON_HOST_DOCKER;

test.skipIf(!canBindMount || !canMountHostNix)(
  "Integration [host-only]: nix enabled - /nix is accessible and nix --version works",
  async () => {
    const workDir = await makeTempDir("nas-e2e-nix-");
    try {
      let nixBinPath: string | null = null;
      for (const p of [
        "/nix/var/nix/profiles/default/bin/nix",
        "/run/current-system/sw/bin/nix",
      ]) {
        try {
          const real = await realpath(p);
          if (real.startsWith("/nix/store/")) {
            nixBinPath = real;
            break;
          }
        } catch {
          /* ignore */
        }
      }

      let nixConfPath: string | null = null;
      try {
        const proc = Bun.spawn(["readlink", "-f", "/etc/nix/nix.conf"], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const [exitCode, stdoutText] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
        ]);
        if (exitCode === 0) {
          nixConfPath = stdoutText.trim();
        }
      } catch {
        /* ignore */
      }

      const extraArgs = ["-v", "/nix:/nix"];
      const envVars: Record<string, string> = {
        NIX_REMOTE: "daemon",
        NIX_ENABLED: "true",
      };
      if (nixBinPath) envVars.NIX_BIN_PATH = nixBinPath;
      if (nixConfPath) {
        if (nixConfPath.startsWith("/nix/")) {
          envVars.NIX_CONF_PATH = nixConfPath;
        } else {
          extraArgs.push("-v", `${nixConfPath}:/tmp/nas-host-nix.conf:ro`);
          envVars.NIX_CONF_PATH = "/tmp/nas-host-nix.conf";
        }
      }

      const lsResult = await dockerRun(["ls", "/nix"], {
        workDir,
        envVars,
        extraArgs,
      });
      expect(lsResult.code).toEqual(0);
      expect(lsResult.stdout.includes("store")).toEqual(true);

      const nixResult = await dockerRun(["nix", "--version"], {
        workDir,
        envVars,
        extraArgs,
      });
      expect(nixResult.code).toEqual(0);
      expect(nixResult.stdout.toLowerCase().includes("nix")).toEqual(true);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!dockerAvailable)(
  "Integration: nix disabled - /nix/store is not accessible",
  async () => {
    const result = await dockerRun([
      "bash",
      "-c",
      "test -d /nix/store && echo mounted || echo not-mounted",
    ]);
    expect(result.code).toEqual(0);
    expect(result.stdout.trim()).toEqual("not-mounted");
  },
);
