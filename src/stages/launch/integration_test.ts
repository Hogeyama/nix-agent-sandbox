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
import { shellEscape } from "../../dtach/client.ts";
import { DockerServiceLive } from "../../services/docker.ts";
import { FsServiceLive } from "../../services/fs.ts";
import { DockerBuildServiceLive } from "../../stages/docker_build.ts";
import { createDockerBuildStage, resolveBuildProbes } from "../docker_build.ts";
import { encodeMaskSecrets } from "../maskfs/secrets_frame.ts";

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

const MASK_FILTER_FIXTURE = `#!/usr/bin/env python3
import os
import struct
import sys
import tempfile

frame = memoryview(open(os.environ["NAS_MASK_SECRETS_FILE"], "rb").read())
count = struct.unpack_from("<I", frame, 0)[0]
offset = 4
secrets = []
for _ in range(count):
    length = struct.unpack_from("<I", frame, offset)[0]
    offset += 4
    secrets.append(bytes(frame[offset:offset + length]))
    offset += length

# This test fixture's payloads are newline-terminated, so line streaming avoids
# retaining output until the wrapped Bash process closes its pipe.
for data in sys.stdin.buffer:
    for secret in secrets:
        if secret:
            data = data.replace(secret, b"*" * len(secret))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

marker_dir = os.environ.get("NAS_MASK_FILTER_MARKER_DIR")
if marker_dir:
    marker = tempfile.NamedTemporaryFile(
        dir=marker_dir, prefix="filter-done-", delete=False
    )
    marker.close()
`;

async function writeMaskFilterFixture(
  fixtureDir: string,
  secrets: readonly string[],
): Promise<{ filterPath: string; secretsPath: string }> {
  const filterPath = path.join(fixtureDir, "nas-mask-filter");
  const secretsPath = path.join(fixtureDir, "secrets.frame");
  await writeFile(filterPath, MASK_FILTER_FIXTURE);
  await chmod(filterPath, 0o755);
  await writeFile(secretsPath, encodeMaskSecrets(secrets));
  return { filterPath, secretsPath };
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

async function resolvePtyScriptPath(): Promise<string | null> {
  const scriptPath = Bun.which("script");
  if (!scriptPath) return null;

  try {
    const proc = Bun.spawn(
      [scriptPath, "-qefc", "printf nas-script-probe; exit 37", "/dev/null"],
      {
        env: { ...process.env, SHELL: "/bin/sh" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const [code, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    return code === 37 && stdout === "nas-script-probe" ? scriptPath : null;
  } catch {
    return null;
  }
}

const [dockerAvailable, ptyScriptPath] = await Promise.all([
  isDockerAvailable(),
  resolvePtyScriptPath(),
]);

/** Docker イメージをビルド（初回のみ） */
let imageBuilt = false;
async function ensureImage(): Promise<void> {
  if (imageBuilt) return;
  const imageName = IMAGE_NAME;
  const buildProbes = await resolveBuildProbes(imageName);
  const stage = createDockerBuildStage(buildProbes);
  await Effect.runPromise(
    Effect.scoped(
      stage
        .run({ workspace: { workDir: "/tmp", imageName } })
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
    tty?: boolean;
    stdin?: string;
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

  if (options.tty) {
    args.push("-i", "-t");
  }

  args.push("-v", `${workDir}:${workDir}`);
  args.push("-w", workDir);

  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }

  args.push(IMAGE_NAME);
  args.push(...testCommand);

  const dockerCommand = ["docker", ...args];
  let hostCommand = dockerCommand;
  if (options.tty) {
    if (!ptyScriptPath) {
      throw new Error("compatible script command unavailable");
    }
    hostCommand = [
      ptyScriptPath,
      "-qefc",
      shellEscape(dockerCommand),
      "/dev/null",
    ];
  }
  const proc = Bun.spawn(hostCommand, {
    ...(options.tty ? { env: { ...process.env, SHELL: "/bin/sh" } } : {}),
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
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
  "Integration: absolute /bin/bash remains the system executable when mask filter is disabled",
  async () => {
    const workDir = await makeTempDir("nas-e2e-bash-disabled-ws-");
    try {
      const result = await dockerRun(
        ["/bin/sh", "-c", "od -An -t x1 -N 4 /bin/bash"],
        { workDir },
      );

      expect(result.code).toEqual(0);
      expect(result.stdout.trim().replace(/\s+/g, " ")).toEqual("7f 45 4c 46");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount)(
  "Integration: mask filter preserves an existing non-executable bash.real",
  async () => {
    const fixtureDir = await makeTempDir("nas-e2e-bash-real-");
    const workDir = await makeTempDir("nas-e2e-bash-real-ws-");
    const realBashPath = path.join(fixtureDir, "bash.real");
    const containerRealBashPath = "/tmp/nas-bash-override/bash.real";
    const sentinel = "preserve-existing-bash-real";

    try {
      await writeMaskFilterFixture(fixtureDir, ["unused-secret"]);
      await writeFile(realBashPath, sentinel, { mode: 0o644 });

      const result = await dockerRun(
        ["/bin/sh", "-c", 'cat "$1"', "sh", containerRealBashPath],
        {
          workDir,
          envVars: {
            NAS_MASK_FILTER: "/tmp/nas-bash-override/nas-mask-filter",
            NAS_MASK_SECRETS_FILE: "/tmp/nas-bash-override/secrets.frame",
          },
          extraArgs: ["-v", `${fixtureDir}:/tmp/nas-bash-override`],
        },
      );

      expect(result.code).toEqual(0);
      expect(result.stdout).toEqual(sentinel);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount)(
  "Integration: absolute /bin/bash masks command, login, and script invocations",
  async () => {
    const fixtureDir = await makeTempDir("nas-e2e-mask-filter-");
    const workDir = await makeTempDir("nas-e2e-mask-filter-ws-");
    const containerFixtureDir = "/tmp/nas-mask-filter-test";
    const containerScriptPath = `${containerFixtureDir}/mask-script.sh`;
    const markerDir = path.join(workDir, "mask-filter-markers");
    const secret = "my-secret-password";
    const masked = "*".repeat(secret.length);
    const runChildAndWaitForFilters = `
"$@"
child_status=$?
attempt=0
while [ "$(find "$NAS_MASK_FILTER_MARKER_DIR" -mindepth 1 -maxdepth 1 -type f | wc -l)" -lt 2 ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    echo "mask filters did not drain before timeout" >&2
    exit 124
  fi
  sleep 0.05
done
exit "$child_status"
`;

    try {
      await writeMaskFilterFixture(fixtureDir, [secret]);
      await writeFile(
        path.join(fixtureDir, "mask-script.sh"),
        `printf 'mode=script shell=%s stdout=${secret}\\n' "$0"
printf 'mode=script stderr=${secret}\\n' >&2
`,
      );

      const invocations = [
        {
          mode: "command",
          command: [
            "/bin/bash",
            "-c",
            `printf 'mode=command shell=%s stdout=${secret}\\n' "$0"; printf 'mode=command stderr=${secret}\\n' >&2`,
          ],
          expectedArgv0: "/bin/bash",
        },
        {
          mode: "login",
          command: [
            "/bin/bash",
            "-lc",
            `printf 'mode=login shell=%s stdout=${secret}\\n' "$0"; printf 'mode=login stderr=${secret}\\n' >&2`,
          ],
          expectedArgv0: "/bin/bash",
        },
        {
          mode: "script",
          command: ["/bin/bash", containerScriptPath],
          expectedArgv0: containerScriptPath,
        },
      ];

      for (const invocation of invocations) {
        await rm(markerDir, { recursive: true, force: true });
        await mkdir(markerDir);

        const result = await dockerRun(
          [
            "/bin/sh",
            "-c",
            runChildAndWaitForFilters,
            "mask-filter-parent",
            ...invocation.command,
          ],
          {
            workDir,
            envVars: {
              NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
              NAS_MASK_SECRETS_FILE: `${containerFixtureDir}/secrets.frame`,
              NAS_MASK_FILTER_MARKER_DIR: markerDir,
            },
            extraArgs: ["-v", `${fixtureDir}:${containerFixtureDir}:ro`],
          },
        );

        expect(await readdir(markerDir)).toHaveLength(2);
        expect(result.code).toEqual(0);
        expect(result.stdout).toContain(
          `mode=${invocation.mode} shell=${invocation.expectedArgv0} stdout=${masked}`,
        );
        expect(result.stderr).toContain(
          `mode=${invocation.mode} stderr=${masked}`,
        );
        expect(result.stdout).not.toContain(secret);
        expect(result.stderr).not.toContain(secret);
      }
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount)(
  "Integration: absolute /bin/bash preserves output when the secrets frame is missing",
  async () => {
    const fixtureDir = await makeTempDir("nas-e2e-mask-fallback-");
    const workDir = await makeTempDir("nas-e2e-mask-fallback-ws-");
    const containerFixtureDir = "/tmp/nas-mask-fallback-test";
    try {
      const { secretsPath } = await writeMaskFilterFixture(fixtureDir, []);
      await rm(secretsPath);

      const result = await dockerRun(
        [
          "/bin/bash",
          "-c",
          "printf 'fallback-stdout\\n'; printf 'fallback-stderr\\n' >&2",
        ],
        {
          workDir,
          envVars: {
            NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
            NAS_MASK_SECRETS_FILE: `${containerFixtureDir}/missing.frame`,
          },
          extraArgs: ["-v", `${fixtureDir}:${containerFixtureDir}:ro`],
        },
      );

      expect(result.code).toEqual(0);
      expect(result.stdout).toContain("fallback-stdout");
      expect(result.stderr).toContain("fallback-stderr");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount || !ptyScriptPath)(
  "Integration: entrypoint Bash bypass preserves TTY during shell re-entry",
  async () => {
    const fixtureDir = await makeTempDir("nas-e2e-shell-reentry-");
    const workDir = await makeTempDir("nas-e2e-shell-reentry-ws-");
    const containerFixtureDir = "/tmp/nas-shell-reentry-test";
    const secret = "shell-reentry-secret";

    try {
      await writeMaskFilterFixture(fixtureDir, [secret]);

      const result = await dockerRun(
        ["/bin/bash", "/entrypoint.sh", "--shell"],
        {
          workDir,
          envVars: {
            NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
            NAS_MASK_SECRETS_FILE: `${containerFixtureDir}/secrets.frame`,
          },
          extraArgs: [
            "--entrypoint",
            "",
            "-v",
            `${fixtureDir}:${containerFixtureDir}:ro`,
          ],
          tty: true,
          stdin:
            "tty0=0; tty1=0; tty2=0\n" +
            "if [[ -t 0 ]]; then tty0=1; fi\n" +
            "if [[ -t 1 ]]; then tty1=1; fi\n" +
            "if [[ -t 2 ]]; then tty2=1; fi\n" +
            `printf 'reentry=${secret} tty=%s%s%s\\n' ` +
            '"$tty0" "$tty1" "$tty2"\nexit\n',
        },
      );

      expect(result.code).toEqual(0);
      expect(result.stdout).toContain(`reentry=${secret} tty=111`);
      expect(result.stdout).not.toContain("reentry=********************");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount || !ptyScriptPath)(
  "Integration: cached Nix launch preserves agent TTY outside filter pipes",
  async () => {
    const fixtureDir = await makeTempDir("nas-e2e-nix-launch-");
    const workDir = await makeTempDir("nas-e2e-nix-launch-ws-");
    const containerFixtureDir = "/tmp/nas-nix-launch-test";
    const cacheDir = path.join(fixtureDir, "cache", "nas", "nix-dev-env");
    const flake = "{ outputs = { self }: {}; }\n";
    const flakeHash = new Bun.CryptoHasher("sha256")
      .update(flake)
      .digest("hex");
    const secret = "nix-launch-secret";

    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(path.join(workDir, "flake.nix"), flake);
      await writeFile(
        path.join(cacheDir, `${flakeHash}.env`),
        "export NAS_NIX_CACHE_MARKER=hit\n",
      );
      await writeMaskFilterFixture(fixtureDir, [secret]);

      const command =
        "tty1=0; tty2=0; " +
        "if [ -t 1 ]; then tty1=1; fi; " +
        "if [ -t 2 ]; then tty2=1; fi; " +
        `printf 'cache=%s secret=${secret} tty=%s%s\\n' ` +
        '"$NAS_NIX_CACHE_MARKER" ' +
        '"$tty1" "$tty2"';
      const result = await dockerRun(["/bin/sh", "-c", command], {
        workDir,
        envVars: {
          NIX_ENABLED: "true",
          XDG_CACHE_HOME: `${containerFixtureDir}/cache`,
          NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
          NAS_MASK_SECRETS_FILE: `${containerFixtureDir}/secrets.frame`,
        },
        extraArgs: ["-v", `${fixtureDir}:${containerFixtureDir}:ro`],
        tty: true,
      });

      expect(result.code).toEqual(0);
      expect(result.stdout).toContain(`cache=hit secret=${secret} tty=11`);
      expect(result.stdout).not.toContain("secret=*****************");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

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
