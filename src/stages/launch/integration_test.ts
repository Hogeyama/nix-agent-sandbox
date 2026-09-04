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

import { existsSync } from "node:fs";
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

// 本物の nas-mask-filter の代役。実バイナリに置き換えないのは、これらの Docker
// テストを Zig ビルド無しで走らせられるようにするためで、それがこのフィクスチャの
// 存在理由そのものなので保つ。
//
// 実装するのは 3 モード:
//   --serve <sock>  ホスト側ブローカー。1 接続 = 1 ストリームでマスクして返す。
//                   シークレットフレームを読むのは**このモードだけ**。
//   --supervise ... コンテナ側の中継クライアント。子を起動し、その stdout/stderr を
//                   socket 経由でマスクして書き戻す。フレームは読まない。
//   (引数なし)      素の stdin→stdout フィルタ。
//
// supervise モードでは子の出力を drain し切ってから子の終了ステータスで exit する
// ため、呼び出し元は「プロセスの終了 = 出力の完了」として扱える。
const MASK_FILTER_FIXTURE = `#!/usr/bin/env python3
import os
import socket
import struct
import subprocess
import sys
import threading

BUF_SIZE = 65536
# 出力抑止 (fail-closed) の終了コード。
EXIT_FAIL_CLOSED = 121


def load_secrets():
    with open(os.environ["NAS_MASK_SECRETS_FILE"], "rb") as f:
        frame = memoryview(f.read())
    count = struct.unpack_from("<I", frame, 0)[0]
    offset = 4
    secrets = []
    for _ in range(count):
        length = struct.unpack_from("<I", frame, offset)[0]
        offset += 4
        secret = bytes(frame[offset:offset + length])
        offset += length
        if secret:
            secrets.append(secret)
    return secrets


class MaskStream:
    """mask_stream.zig の MaskStream と同じ持ち越し規則を再現する。

    emit する分だけをマスクすると、保持中の overlap と新規バイトに跨る
    マッチが一度も見えない (overlap=6 で "pw=hunter2 done" を流すと
    "pw=hunter2 done" がそのまま出る)。overlap + 新規を連結した全体をマスクし、
    安全な前半だけを emit して、末尾は**原文のまま**確定マスク位置と一緒に
    次周回へ持ち越す。
    """

    def __init__(self, secrets):
        self.secrets = secrets
        longest = max((len(s) for s in secrets), default=0)
        self.overlap_size = longest - 1 if longest > 0 else 0
        self.pending = b""
        self.carried = b""

    def _marks(self, data):
        marks = bytearray(len(data))
        for secret in self.secrets:
            start = 0
            while True:
                i = data.find(secret, start)
                if i < 0:
                    break
                for k in range(i, i + len(secret)):
                    marks[k] = 1
                start = i + 1
        return marks

    def _apply(self, data, marks):
        out = bytearray(data)
        for i, m in enumerate(marks):
            if m:
                out[i] = 0x2A
        return bytes(out)

    def push(self, data):
        combined = self.pending + data
        marks = self._marks(combined)
        for i, m in enumerate(self.carried):
            if m:
                marks[i] = 1
        total = len(combined)
        safe_end = total - self.overlap_size if total > self.overlap_size else 0
        emitted = self._apply(combined[:safe_end], marks[:safe_end])
        self.pending = combined[safe_end:]
        self.carried = bytes(marks[safe_end:])
        return emitted

    def finish(self):
        if not self.pending:
            return b""
        marks = self._marks(self.pending)
        for i, m in enumerate(self.carried):
            if m:
                marks[i] = 1
        out = self._apply(self.pending, marks)
        self.pending = b""
        self.carried = b""
        return out


def serve_conn(conn, secrets):
    stream = MaskStream(secrets)
    try:
        while True:
            data = conn.recv(BUF_SIZE)
            if not data:
                break
            out = stream.push(data)
            if out:
                conn.sendall(out)
        # クライアントの half-close が EOF の合図。保持中の overlap を
        # フラッシュしてから close する。
        tail = stream.finish()
        if tail:
            conn.sendall(tail)
    except OSError:
        pass
    finally:
        conn.close()


def serve(sock_path):
    secrets = load_secrets()
    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(sock_path)
    listener.listen(64)
    while True:
        conn, _ = listener.accept()
        worker = threading.Thread(
            target=serve_conn, args=(conn, secrets), daemon=True
        )
        worker.start()


def pump_to_socket(src_fd, sock):
    try:
        while True:
            data = os.read(src_fd, BUF_SIZE)
            if not data:
                break
            sock.sendall(data)
    except OSError:
        pass
    finally:
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def pump_from_socket(sock, dst):
    try:
        while True:
            data = sock.recv(BUF_SIZE)
            if not data:
                break
            dst.write(data)
            dst.flush()
    except OSError:
        pass


def supervise(argv):
    argv0 = None
    sock_path = None
    while argv:
        if argv[0] == "--argv0":
            argv0 = argv[1]
            argv = argv[2:]
        elif argv[0] == "--socket":
            sock_path = argv[1]
            argv = argv[2:]
        elif argv[0] == "--":
            argv = argv[1:]
            break
        else:
            break

    # fail-closed: 2 本とも Popen の**前に**張る。ワーカースレッドの中で
    # 張ると、失敗してもそのスレッドが死ぬだけで child.wait() は 0 を返し、
    # 壊れた実装が「出力なしで成功」として通ってしまう。
    socks = []
    try:
        if not sock_path:
            raise OSError("no socket path")
        for _ in range(2):
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(sock_path)
            socks.append(s)
    except OSError:
        for s in socks:
            s.close()
        sys.exit(EXIT_FAIL_CLOSED)

    program = argv[0]
    # 入れ子抑止のマーカー。渡さないとラッパーのガードが働かず、入れ子の
    # 検証が何も見ていないことになる。
    env = dict(os.environ)
    env["NAS_MASK_SUPERVISED"] = "1"
    child = subprocess.Popen(
        [argv0 or program] + argv[1:],
        executable=program,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    threads = []
    for pipe, sock, dst in (
        (child.stdout, socks[0], sys.stdout.buffer),
        (child.stderr, socks[1], sys.stderr.buffer),
    ):
        threads.append(
            threading.Thread(target=pump_to_socket, args=(pipe.fileno(), sock))
        )
        threads.append(
            threading.Thread(target=pump_from_socket, args=(sock, dst))
        )
    for thread in threads:
        thread.start()
    status = child.wait()
    for thread in threads:
        thread.join()
    for s in socks:
        s.close()
    sys.exit(status if status >= 0 else 128 - status)


def filter_stdin():
    stream = MaskStream(load_secrets())
    while True:
        data = os.read(0, BUF_SIZE)
        if not data:
            break
        out = stream.push(data)
        if out:
            sys.stdout.buffer.write(out)
            sys.stdout.buffer.flush()
    tail = stream.finish()
    if tail:
        sys.stdout.buffer.write(tail)
    sys.stdout.buffer.flush()


args = sys.argv[1:]
if args and args[0] == "--serve":
    serve(args[1])
elif args and args[0] == "--supervise":
    supervise(args[1:])
else:
    filter_stdin()
`;

/** 代役フィルタをフィクスチャディレクトリへ置き、ホスト側のパスを返す。 */
async function writeMaskFilterFixture(fixtureDir: string): Promise<string> {
  const filterPath = path.join(fixtureDir, "nas-mask-filter");
  await writeFile(filterPath, MASK_FILTER_FIXTURE);
  await chmod(filterPath, 0o755);
  return filterPath;
}

interface MaskBroker {
  /** コンテナへ ro でマウントするディレクトリ。socket 以外を置かない。 */
  readonly socketDir: string;
  /** ホストとコンテナで同じ絶対パス。 */
  readonly socketPath: string;
  readonly stop: () => Promise<void>;
}

/**
 * 代役フィルタの `--serve` デーモンをホスト側で起動する。
 *
 * 本番 (MaskFilterService) と同じ形にする:
 *   - シークレットフレームはホスト専用ディレクトリに置き、**マウントしない**。
 *     コンテナ側の supervise はフレームを読まないので、これで動くこと自体が
 *     コンテナからフレームが不要になった証明になる。
 *   - socket はフィクスチャのマウントとは別のディレクトリに置き、ro で渡す。
 *     ro でも connect(2) は成功し、socket の差し替えだけが封じられる。
 *   - ホストと同じ絶対パスへマウントするので、コンテナ側パスの変換は要らない。
 */
async function startMaskBroker(
  hostFilterPath: string,
  secrets: readonly string[],
): Promise<MaskBroker> {
  const frameDir = await makeTempDir("nas-e2e-mask-frame-");
  const socketDir = await makeTempDir("nas-e2e-mask-sock-");
  const socketPath = path.join(socketDir, "mask.sock");
  const framePath = path.join(frameDir, "secrets.frame");
  await writeFile(framePath, encodeMaskSecrets(secrets));

  const proc = Bun.spawn([hostFilterPath, "--serve", socketPath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NAS_MASK_SECRETS_FILE: framePath },
  });
  const stop = async (): Promise<void> => {
    proc.kill();
    await proc.exited;
    await rm(frameDir, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true });
  };

  const deadline = Date.now() + 5000;
  while (!existsSync(socketPath)) {
    if (proc.exitCode !== null || Date.now() >= deadline) {
      const stderr = await new Response(proc.stderr).text();
      await stop();
      throw new Error(`mask broker failed to start: ${stderr}`);
    }
    await Bun.sleep(20);
  }
  return { socketDir, socketPath, stop };
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

/**
 * Every test below runs the built image, and building it needs the network:
 * the Dockerfile's `apt-get install` has to reach the archive. Inside a nas
 * sandbox the daemon is the DinD sidecar, whose build containers have no
 * route out -- the base image pull still succeeds, because dockerd itself is
 * proxied, but the install step cannot resolve a single package. Without this
 * predicate every test here fails on its five-second timeout while a doomed
 * build runs, which says nothing about the entrypoint they mean to check.
 */
const imageBuildable = RUNNING_ON_HOST_DOCKER;
const canRunImage = dockerAvailable && imageBuildable;

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

test.skipIf(!canRunImage)(
  "Integration: container runs command and exits 0",
  async () => {
    const result = await dockerRun(["echo", "hello from nas"]);
    expect(result.code).toEqual(0);
    expect(result.stdout.trim()).toEqual("hello from nas");
  },
);

test.skipIf(!canRunImage)(
  "Integration: non-zero exit code is propagated",
  async () => {
    const result = await dockerRun(["bash", "-c", "exit 42"]);
    expect(result.code).toEqual(42);
  },
);

test.skipIf(!canRunImage)(
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

test.skipIf(!canRunImage)(
  "Integration: USER and HOME are set correctly",
  async () => {
    const result = await dockerRun(["bash", "-c", "echo $USER:$HOME"]);
    expect(result.code).toEqual(0);

    const hostUser = process.env.USER?.trim() || "nas";
    expect(result.stdout.trim()).toEqual(`${hostUser}:/home/${hostUser}`);
  },
);

test.skipIf(!canRunImage)(
  "Integration: home directory exists and is owned by user",
  async () => {
    const result = await dockerRun(["bash", "-c", "stat -c '%U:%G' $HOME"]);
    expect(result.code).toEqual(0);

    const hostUser = process.env.USER?.trim() || "nas";
    expect(result.stdout.trim()).toEqual(`${hostUser}:${hostUser}`);
  },
);

test.skipIf(!canRunImage)(
  "Integration: custom env vars are passed to container",
  async () => {
    const result = await dockerRun(["bash", "-c", "echo $MY_VAR:$OTHER_VAR"], {
      envVars: { MY_VAR: "hello", OTHER_VAR: "world" },
    });
    expect(result.code).toEqual(0);
    expect(result.stdout.trim()).toEqual("hello:world");
  },
);

test.skipIf(!canRunImage)(
  "Integration: env var with special characters",
  async () => {
    const result = await dockerRun(["bash", "-c", "echo $SPECIAL_VAR"], {
      envVars: { SPECIAL_VAR: "https://example.com?foo=bar&baz=qux" },
    });
    expect(result.code).toEqual(0);
    expect(result.stdout.trim()).toEqual("https://example.com?foo=bar&baz=qux");
  },
);

// ============================================================
// bind mount テスト (共有 tmp 経由 — DinD/ホスト両対応)
// ============================================================

// DinD 環境で共有ボリュームがない場合はスキップ。
// ホスト Docker (DOCKER_HOST 未設定) の場合は /tmp が使えるので常に動く。
const canBindMount =
  canRunImage && (SHARED_TMP !== undefined || !process.env.DOCKER_HOST);

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
    let broker: MaskBroker | null = null;

    try {
      const filterPath = await writeMaskFilterFixture(fixtureDir);
      await writeFile(realBashPath, sentinel, { mode: 0o644 });
      // NAS_MASK_SOCKET が無いとラッパー自体が設置されず、bash.real に
      // 触れる経路ごと消えるので、このテストは何も検証しなくなる。
      broker = await startMaskBroker(filterPath, ["unused-secret"]);

      const result = await dockerRun(
        ["/bin/sh", "-c", 'cat "$1"', "sh", containerRealBashPath],
        {
          workDir,
          envVars: {
            NAS_MASK_FILTER: "/tmp/nas-bash-override/nas-mask-filter",
            NAS_MASK_SOCKET: broker.socketPath,
          },
          extraArgs: [
            "-v",
            `${fixtureDir}:/tmp/nas-bash-override`,
            "-v",
            `${broker.socketDir}:${broker.socketDir}:ro`,
          ],
        },
      );

      expect(result.code).toEqual(0);
      expect(result.stdout).toEqual(sentinel);
    } finally {
      await broker?.stop();
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
    const secret = "my-secret-password";
    const masked = "*".repeat(secret.length);
    let broker: MaskBroker | null = null;

    try {
      const filterPath = await writeMaskFilterFixture(fixtureDir);
      broker = await startMaskBroker(filterPath, [secret]);
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
        // supervise モードのフィルタは出力を drain し切ってから exit するので、
        // 呼び出し元は子プロセスの終了をそのまま待てばよい (以前はフィルタの
        // 取りこぼしを避けるため、マーカーファイルを待つ細工が必要だった)。
        const result = await dockerRun(invocation.command, {
          workDir,
          envVars: {
            NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
            NAS_MASK_SOCKET: broker.socketPath,
          },
          extraArgs: [
            "-v",
            `${fixtureDir}:${containerFixtureDir}:ro`,
            "-v",
            `${broker.socketDir}:${broker.socketDir}:ro`,
          ],
        });

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
      await broker?.stop();
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!canBindMount)(
  "Integration: captured mask paths survive an agent child with stripped public variables",
  async () => {
    const fixtureDir = await makeTempDir("nas-e2e-mask-stripped-");
    const workDir = await makeTempDir("nas-e2e-mask-stripped-ws-");
    const containerFixtureDir = "/tmp/nas-mask-stripped-test";
    const secret = "codex-stripped-env-secret";
    const masked = "*".repeat(secret.length);
    let broker: MaskBroker | null = null;

    try {
      const filterPath = await writeMaskFilterFixture(fixtureDir);
      broker = await startMaskBroker(filterPath, [secret]);
      const result = await dockerRun(
        [
          "/usr/bin/env",
          "-u",
          "NAS_MASK_FILTER",
          "-u",
          "NAS_MASK_SOCKET",
          "/bin/bash",
          "-c",
          `printf 'codex=${secret}\\n'`,
        ],
        {
          workDir,
          envVars: {
            NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
            NAS_MASK_SOCKET: broker.socketPath,
          },
          extraArgs: [
            "-v",
            `${fixtureDir}:${containerFixtureDir}:ro`,
            "-v",
            `${broker.socketDir}:${broker.socketDir}:ro`,
          ],
        },
      );
      expect(result.code).toEqual(0);
      expect(result.stdout).toContain(`codex=${masked}`);
      expect(result.stdout).not.toContain(secret);
    } finally {
      await broker?.stop();
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

// ブローカーへ届かないときに素通しする経路は存在しない。マスクされたか
// 確信できないバイトは 1 バイトも出さず、121 (出力抑止) で落ちる。
test.skipIf(!canBindMount)(
  "Integration: absolute /bin/bash fails closed when the broker is unreachable",
  async () => {
    const fixtureDir = await makeTempDir("nas-e2e-mask-deadsock-");
    const workDir = await makeTempDir("nas-e2e-mask-deadsock-ws-");
    // デーモンを起動しないので socket ファイルは存在しない (= デーモンが
    // 死んだ後と同じ状態)。設定だけは本番と同じ形で与える。
    const socketDir = await makeTempDir("nas-e2e-mask-deadsock-sock-");
    const containerFixtureDir = "/tmp/nas-mask-deadsock-test";
    try {
      await writeMaskFilterFixture(fixtureDir);

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
            NAS_MASK_SOCKET: `${socketDir}/mask.sock`,
          },
          extraArgs: [
            "-v",
            `${fixtureDir}:${containerFixtureDir}:ro`,
            "-v",
            `${socketDir}:${socketDir}:ro`,
          ],
        },
      );

      expect(result.code).toEqual(121);
      expect(result.stdout).not.toContain("fallback-stdout");
      expect(result.stderr).not.toContain("fallback-stderr");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(socketDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

// NAS_MASK_SOCKET が無いのはバイパスではなく「機能が無効」の状態。ラッパーは
// そもそも設置されず、/bin/bash は本物のままで出力も素のまま流れる。
test.skipIf(!canBindMount)(
  "Integration: the bash wrapper is not installed without NAS_MASK_SOCKET",
  async () => {
    const fixtureDir = await makeTempDir("nas-e2e-mask-nosock-");
    const workDir = await makeTempDir("nas-e2e-mask-nosock-ws-");
    const containerFixtureDir = "/tmp/nas-mask-nosock-test";
    try {
      await writeMaskFilterFixture(fixtureDir);

      const result = await dockerRun(
        [
          "/bin/sh",
          "-c",
          "od -An -t x1 -N 4 /bin/bash; printf 'plain-stdout\\n'",
        ],
        {
          workDir,
          envVars: {
            NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
          },
          extraArgs: ["-v", `${fixtureDir}:${containerFixtureDir}:ro`],
        },
      );

      expect(result.code).toEqual(0);
      // ラッパーは `#!/tmp/nas-bash-override/bash.real` で始まるスクリプトなので、
      // ELF マジックが残っていれば差し替えは起きていない。
      expect(result.stdout.replace(/\s+/g, " ")).toContain("7f 45 4c 46");
      expect(result.stdout).toContain("plain-stdout");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

// コンテナ内の bash はすべてラッパーなので、supervise 下で起動した bash も
// またラッパーになる。抑止しないと ./configure や make のレシピ行のたびに層が
// 積み上がる。判定はマーカーで行う: マスクは冪等 (* はシークレットではない)
// なので、層が 1 つでも 2 つでも出力は同一になり、出力からは回帰を検出できない。
// 層の数そのものを数える検証は src/stages/maskfs/mask_filter_integration_test.ts
// にある。ここで確かめるのは、マーカーが実コンテナの起動経路
// (entrypoint → setpriv → ラッパー → supervisor → 子) を通って届くこと。
test.skipIf(!canBindMount)(
  "Integration: the supervised marker reaches a nested bash wrapper",
  async () => {
    const fixtureDir = await makeTempDir("nas-e2e-mask-nested-");
    const workDir = await makeTempDir("nas-e2e-mask-nested-ws-");
    const containerFixtureDir = "/tmp/nas-mask-nested-test";
    const secret = "nested-supervise-secret";
    const masked = "*".repeat(secret.length);
    let broker: MaskBroker | null = null;

    try {
      const filterPath = await writeMaskFilterFixture(fixtureDir);
      broker = await startMaskBroker(filterPath, [secret]);

      const result = await dockerRun(
        [
          "/bin/bash",
          "-c",
          `/bin/bash -c 'printf "inner=[%s] pw=${secret}\\n" "$NAS_MASK_SUPERVISED"'`,
        ],
        {
          workDir,
          envVars: {
            NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
            NAS_MASK_SOCKET: broker.socketPath,
          },
          extraArgs: [
            "-v",
            `${fixtureDir}:${containerFixtureDir}:ro`,
            "-v",
            `${broker.socketDir}:${broker.socketDir}:ro`,
          ],
        },
      );

      expect(result.code).toEqual(0);
      expect(result.stdout).toContain(`inner=[1] pw=${masked}`);
      expect(result.stdout).not.toContain(secret);
    } finally {
      await broker?.stop();
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
    let broker: MaskBroker | null = null;

    try {
      const filterPath = await writeMaskFilterFixture(fixtureDir);
      // ブローカーを立てないとラッパーが設置されず、バイパス経路を通ったのか
      // そもそもマスクが無効だったのかを区別できない。
      broker = await startMaskBroker(filterPath, [secret]);

      const result = await dockerRun(
        ["/bin/bash", "/entrypoint.sh", "--shell"],
        {
          workDir,
          envVars: {
            NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
            NAS_MASK_SOCKET: broker.socketPath,
          },
          extraArgs: [
            "--entrypoint",
            "",
            "-v",
            `${fixtureDir}:${containerFixtureDir}:ro`,
            "-v",
            `${broker.socketDir}:${broker.socketDir}:ro`,
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
      await broker?.stop();
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
    let broker: MaskBroker | null = null;

    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(path.join(workDir, "flake.nix"), flake);
      await writeFile(
        path.join(cacheDir, `${flakeHash}.env`),
        "export NAS_NIX_CACHE_MARKER=hit\n",
      );
      const filterPath = await writeMaskFilterFixture(fixtureDir);
      // ブローカーを立てないとラッパーが設置されず、agent が supervisor の
      // パイプの外に出ていることを何も確かめていないことになる。
      broker = await startMaskBroker(filterPath, [secret]);

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
          NAS_MASK_SOCKET: broker.socketPath,
        },
        extraArgs: [
          "-v",
          `${fixtureDir}:${containerFixtureDir}:ro`,
          "-v",
          `${broker.socketDir}:${broker.socketDir}:ro`,
        ],
        tty: true,
      });

      expect(result.code).toEqual(0);
      expect(result.stdout).toContain(`cache=hit secret=${secret} tty=11`);
      expect(result.stdout).not.toContain("secret=*****************");
    } finally {
      await broker?.stop();
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

test.skipIf(!canRunImage)(
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
