import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMaskFilterBinPath } from "./mask_filter_path.ts";
import { encodeMaskSecrets } from "./secrets_frame.ts";

/**
 * このスイートの前提判定は、欠けている前提を例外なく **skip として報告する**。
 * 前提が欠けたときに黙って return すると、そのテストが何も検証しなかった事実が
 * 出力から消え、suite は緑のままになる。バイナリ未ビルドなら 30 件近くが、
 * python3 や /proc が無ければ資源上限の唯一の証明が、そうやって静かに失われる。
 * 前提は describe の外 (トップレベル await) で解決し、各テストの `skipIf` に渡す。
 *
 * 前提は 3 つ:
 * - `binaryPath`: `cd src/mask-filter && zig build` の生成物。
 * - `hasPython3`: 「読まずに書き続ける」クライアント (STALLING_CLIENT_PY) は
 *   TypeScript では書けないので python3 で用意する。flake.nix の devShell で
 *   宣言してあるが、devShell の外で走らせる場合もあるので存在を確かめる。
 * - `hasProcStatus`: サーバの VmRSS を /proc から読むので Linux でしか動かない。
 */
const binaryPath = await resolveMaskFilterBinPath();
const hasPython3 = Bun.which("python3") !== null;
const hasProcStatus = fs.existsSync("/proc/self/status");

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-filter-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let secretsFileSeq = 0;

function writeSecretsFile(secrets: string[]): string {
  const frame = encodeMaskSecrets(secrets);
  const filePath = path.join(tmpDir, `secrets-${secretsFileSeq++}`);
  fs.writeFileSync(filePath, frame);
  return filePath;
}

/**
 * 本物の bash のパス。
 *
 * nas コンテナ内では /bin/bash は entrypoint が差し替えたマスクラッパー自身に
 * なっている。ラッパー経由で起動すると supervise モードの検証にラッパーの挙動が
 * 混ざるため、コンテナ内では bash.real を直接指す。
 */
function realBashPath(): string {
  const real = "/tmp/nas-bash-override/bash.real";
  return fs.existsSync(real) ? real : "/bin/bash";
}

/**
 * entrypoint.sh の MASK_WRAPPER ヒアドキュメントからラッパー本体を取り出して
 * 実行可能ファイルとして書き出す。
 *
 * 入れ子抑止の判定はラッパー側にあるので、bash.real を直接叩くテストでは
 * ラッパーごと素通りして何も検証できない。出荷されるスクリプトそのものを
 * 使うために、コピーではなく entrypoint から抽出する。
 */
function writeWrapperScript(): string {
  const entry = fs.readFileSync(
    path.join(import.meta.dir, "../../docker/embed/entrypoint.sh"),
    "utf8",
  );
  const m = entry.match(/<< 'MASK_WRAPPER'\n([\s\S]*?)\nMASK_WRAPPER\n/);
  if (!m) throw new Error("MASK_WRAPPER heredoc not found");
  const body = m[1].replaceAll(
    "/tmp/nas-bash-override/bash.real",
    realBashPath(),
  );
  const p = path.join(tmpDir, `wrapper-${secretsFileSeq++}.sh`);
  fs.writeFileSync(p, `${body}\n`, { mode: 0o755 });
  return p;
}

/**
 * process.env のコピーから NAS_MASK_SUPERVISED を取り除いたもの。
 *
 * このテストスイート自体が既に mask-filter 下のシェル (nas セッション) で
 * 走っていることがある。その場合 process.env に NAS_MASK_SUPERVISED=1 が
 * 乗っており、ラッパーの入れ子抑止テストがそれをそのまま継承すると、外側の
 * 呼び出しが「既に supervise 済み」と誤認して素通りし、マスクも supervisor
 * の層数も検証できなくなる。
 */
function envWithoutSupervisionMarker(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.NAS_MASK_SUPERVISED;
  return env;
}

async function runFilter(input: string, secrets: string[]): Promise<string> {
  if (!binaryPath) throw new Error("nas-mask-filter binary not found");
  const secretsFile = writeSecretsFile(secrets);
  const proc = Bun.spawn([binaryPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { NAS_MASK_SECRETS_FILE: secretsFile },
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`filter exited ${exitCode}: ${stderr}`);
  }
  return output;
}

function startServe(secretsFile: string, sockPath: string) {
  return Bun.spawn([binaryPath!, "--serve", sockPath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NAS_MASK_SECRETS_FILE: secretsFile },
  });
}

/**
 * serve モードの出力不変条件: ストリーム由来のバイトを自身の stdout/stderr に
 * 書いてはならない。
 *
 * ホスト側では ProcessService.spawn がこの 2 つを永続ログファイルに向けるため、
 * 「failed to mask chunk: <bytes>」のような診断を 1 つ足すだけで平文シークレットが
 * ディスクに残る。診断は定数文字列だけに限る必要があるので、両ストリームが空の
 * ままであることを毎回確認する。
 */
async function expectServeSilent(proc: ReturnType<typeof startServe>) {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
}

/**
 * デーモンがまだ生きているか。
 *
 * `exitCode` / `signalCode` は `await proc.exited` しなくても子の終了を反映
 * するので、シグナルによる死も検出できる。expectServeSilent は stdout/stderr が
 * 空であることしか見ておらず、途中で落ちたデーモン (どちらも空のまま) を
 * 素通りさせてしまうため、生存はこちらで別に確かめる必要がある。
 */
function serveAlive(proc: ReturnType<typeof startServe>): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

async function waitForSocket(sockPath: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(sockPath)) return true;
    await Bun.sleep(20);
  }
  return false;
}

/** AF_UNIX パスは 107 バイトまで。テスト用 tmpdir は長すぎるので /tmp に置く。 */
function shortSockPath(tag: string): string {
  return `/tmp/nas-mf-${tag}-${process.pid}-${secretsFileSeq++}.sock`;
}

/**
 * supervise モードをホスト側ブローカー経由で走らせる。
 *
 * env に `NAS_MASK_SECRETS_FILE` を **意図的に渡さない**。supervise はもう
 * シークレットフレームを読まないので、渡さなくても masked な出力が返ること
 * 自体がコンテナ側からフレームが不要になった証明になる。
 *
 * `sockPath` を渡すと既存のデーモンを使い回す。渡さなければ 1 回ごとに
 * デーモンを起動・停止する。
 */
async function runSupervisedOverSocket(
  script: string,
  secrets: string[],
  opts?: { argv0?: string; stdin?: Uint8Array; sockPath?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const sockPath = opts?.sockPath ?? shortSockPath("sup");
  const server = opts?.sockPath
    ? null
    : startServe(writeSecretsFile(secrets), sockPath);
  try {
    if (server && !(await waitForSocket(sockPath))) {
      throw new Error("serve not ready");
    }
    const argv0Args = opts?.argv0 ? ["--argv0", opts.argv0] : [];
    const proc = Bun.spawn(
      [
        binaryPath!,
        "--supervise",
        ...argv0Args,
        "--socket",
        sockPath,
        "--",
        realBashPath(),
        "-c",
        script,
      ],
      {
        stdin: opts?.stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env }, // deliberately NO NAS_MASK_SECRETS_FILE
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, exitCode: await proc.exited };
  } finally {
    if (server) {
      server.kill();
      await server.exited;
      fs.rmSync(sockPath, { force: true });
    }
  }
}

/**
 * `writes` を (必要なら間隔を空けて) 送り、half-close してからサーバが
 * close するまで読み続ける。`openDelayMs` を渡すと、接続後 1 バイトも
 * 書かないまま黙っている時間を作れる。
 *
 * Bun 1.3.9 の node:net は `.end()` が half-close ではなく full close に
 * なるため、サーバが EOF 後にフラッシュした末尾を受け取れない。このプロトコルは
 * フラッシュ経路全体が half-close に紐づいているので、クライアントは
 * Bun.connect + shutdown() でなければならない。
 */
function maskOverSocket(
  sockPath: string,
  writes: string[],
  gapMs = 0,
  openDelayMs = 0,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    Bun.connect({
      unix: sockPath,
      socket: {
        async open(s) {
          if (openDelayMs) await Bun.sleep(openDelayMs);
          for (const w of writes) {
            s.write(Buffer.from(w));
            if (gapMs) await Bun.sleep(gapMs);
          }
          s.shutdown();
        },
        data(_s, d) {
          chunks.push(Buffer.from(d));
        },
        close() {
          resolve(Buffer.concat(chunks).toString());
        },
        error(_s, e) {
          reject(e);
        },
      },
    }).catch(reject);
  });
}

/**
 * バルク転送用のクライアント。`payload` を書き切って half-close し、サーバが
 * close するまで読み続けるのは maskOverSocket と同じだが、受信のたびに
 * 同期的に `readStallMs` だけ止まる「遅い読み手」を演じる点が違う。
 *
 * これがないとサーバの `write(2)` は毎回全量成功してしまい、送信キューの
 * ドレイン経路 — 短い write のあとの前詰め圧縮と、MAX_QUEUED_BYTES 付近まで
 * 育ったキューを吐き切ったときの容量調整 — が一度も実行されない。AF_UNIX の
 * 送受信バッファは既定でどちらも約 208KiB、マスクは長さを保存するので、
 * 読み手が遅れない限りサーバの出力は必ず一度の write に収まってしまう。
 *
 * Bun の `pause()` ではソケット自体は読み進められてしまい (コールバックが
 * 遅延するだけ) カーネルの受信バッファは埋まらない。実測でも短い write は
 * 発生しなかった。イベントループごと同期的に止めるのが唯一効く方法で、
 * こうすると圧縮経路が実際に走る (壊すとこのテストが落ちる)。
 */
function maskOverSocketSlowReader(
  sockPath: string,
  payload: string,
  readStallMs = 40,
): Promise<string> {
  const buf = Buffer.from(payload);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    Bun.connect({
      unix: sockPath,
      socket: {
        async open(s) {
          let off = 0;
          while (off < buf.length) {
            const n = s.write(buf.subarray(off));
            if (n > 0) off += n;
            else await Bun.sleep(1);
          }
          s.shutdown();
        },
        data(_s, d) {
          chunks.push(Buffer.from(d));
          const until = Date.now() + readStallMs;
          while (Date.now() < until) {
            // イベントループを止めるための同期ビジーウェイト。
          }
        },
        close() {
          resolve(Buffer.concat(chunks).toString());
        },
        error(_s, e) {
          reject(e);
        },
      },
    }).catch(reject);
  });
}

/**
 * 「書くだけで一切読まない」クライアント。TypeScript では書けないので Python で
 * 別プロセスとして用意する。
 *
 * node:net の `write()` の戻り値は使えない。サーバの状態と無関係に Node 自身の
 * highWaterMark (16KiB) を超えた時点で false になるので、上限あり・なしで
 * 同じ結果しか出ない。Bun の `pause()` もカーネルの受信バッファの排出を
 * 止めない (コールバックが遅延するだけ) ので、Bun のクライアントでは
 * そもそもサーバを詰まらせられない。
 *
 * 非ブロッキングにしてカーネルが受け取る限り書き続け、recv は決して呼ばない。
 * 進まなくなったら受理されたバイト数を出力して stdout を閉じ、あとは kill
 * されるまで接続を握ったまま黙る (接続を閉じるとサーバがキューを解放して
 * しまい、測りたい状態が消える)。
 */
const STALLING_CLIENT_PY = `import os
import socket
import sys
import time

sock_path = sys.argv[1]
limit_bytes = int(sys.argv[2]) * 1024 * 1024
stall_timeout_s = 2.0

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sock_path)
s.setblocking(False)

chunk = b"x" * 65536
sent = 0
blocked_since = None
while sent < limit_bytes:
    try:
        n = s.send(chunk)
    except BlockingIOError:
        n = 0
    except OSError:
        break
    if n > 0:
        sent += n
        blocked_since = None
        continue
    now = time.monotonic()
    if blocked_since is None:
        blocked_since = now
    elif now - blocked_since >= stall_timeout_s:
        break
    time.sleep(0.01)

sys.stdout.write(str(sent) + "\\n")
sys.stdout.flush()
os.close(1)

while True:
    time.sleep(1)
`;

function writeStallingClient(): string {
  const p = path.join(tmpDir, "stalling_client.py");
  if (!fs.existsSync(p)) fs.writeFileSync(p, STALLING_CLIENT_PY);
  return p;
}

function serverRssKb(pid: number): number {
  const m = fs
    .readFileSync(`/proc/${pid}/status`, "utf8")
    .match(/^VmRSS:\s+(\d+) kB$/m);
  return m ? Number(m[1]) : 0;
}

describe("nas-mask-filter binary", () => {
  test.skipIf(!binaryPath)("masks single secret", async () => {
    const result = await runFilter("password=hunter2 done", ["hunter2"]);
    expect(result).toBe("password=******* done");
  });

  test.skipIf(!binaryPath)("masks multiple secrets", async () => {
    const result = await runFilter("a=tok1 b=tok22 c=tok1", ["tok1", "tok22"]);
    expect(result).toBe("a=**** b=***** c=****");
  });

  test.skipIf(!binaryPath)("passes through when no secrets match", async () => {
    const result = await runFilter("nothing to mask here", ["nonexistent"]);
    expect(result).toBe("nothing to mask here");
  });

  test.skipIf(!binaryPath)("handles empty input", async () => {
    const result = await runFilter("", ["secret"]);
    expect(result).toBe("");
  });

  test.skipIf(!binaryPath)("masks secret spanning large input", async () => {
    // Create input larger than BUF_SIZE (64KB) with secret near the boundary
    const padding = "x".repeat(65530);
    const input = `${padding}SECRET_VALUE${padding}`;
    const result = await runFilter(input, ["SECRET_VALUE"]);
    expect(result).not.toContain("SECRET_VALUE");
    expect(result).toContain("************");
    expect(result.length).toBe(input.length);
  });
});

describe("nas-mask-filter --supervise", () => {
  test.skipIf(!binaryPath)(
    "masks supervised output through the socket",
    async () => {
      const r = await runSupervisedOverSocket("echo pw=hunter2", ["hunter2"]);
      expect(r.stdout).toBe("pw=*******\n");
      expect(r.exitCode).toBe(0);
    },
  );

  test.skipIf(!binaryPath)("masks stderr of the supervised child", async () => {
    const r = await runSupervisedOverSocket("echo pw=hunter2 >&2", ["hunter2"]);
    expect(r.stderr).toBe("pw=*******\n");
    expect(r.stdout).toBe("");
  });

  test.skipIf(!binaryPath)("propagates the child exit code", async () => {
    const r = await runSupervisedOverSocket("exit 42", ["hunter2"]);
    expect(r.exitCode).toBe(42);
  });

  test.skipIf(!binaryPath)("maps death by signal to 128+signo", async () => {
    const r = await runSupervisedOverSocket("kill -TERM $$", ["hunter2"]);
    expect(r.exitCode).toBe(128 + 15);
  });

  test.skipIf(!binaryPath)("--argv0 sets the child's argv[0]", async () => {
    const r = await runSupervisedOverSocket('echo "argv0=$0"', ["hunter2"], {
      argv0: "-bash",
    });
    expect(r.stdout).toBe("argv0=-bash\n");
  });

  test.skipIf(!binaryPath)(
    "preserves output larger than the pipe buffer",
    async () => {
      const r = await runSupervisedOverSocket(
        "for i in $(seq 5000); do echo line$i; done",
        ["hunter2"],
      );
      const lines = r.stdout.split("\n").filter(Boolean);
      expect(lines.length).toBe(5000);
      expect(lines[4999]).toBe("line5000");
      expect(r.exitCode).toBe(0);
    },
  );

  // constraint 2 の回帰テスト。キューが残っているうちに half-close すると、
  // その後の write が EPIPE になって全出力が捨てられ、子が 0 で終わっていても
  // 121 になる。パイプが EOF になった時点でまだ数 MB がキューと socket の
  // 往復に残っている量を流して、末尾まで欠けないことを見る。
  test.skipIf(!binaryPath)(
    "preserves multi-megabyte output through the socket",
    async () => {
      const r = await runSupervisedOverSocket(
        "for i in $(seq 200000); do echo line$i; done",
        ["hunter2"],
      );
      const lines = r.stdout.split("\n").filter(Boolean);
      expect(lines.length).toBe(200000);
      expect(lines[199999]).toBe("line200000");
      expect(r.exitCode).toBe(0);
    },
    60000,
  );

  // 上の「量を流すだけ」のテストでは constraint 2 の失敗経路に**届かない**。
  // 読み手が遅れていなければ 1 周回ごとに送信キューを丸ごと吐き切れてしまい、
  // パイプが EOF になった瞬間のキューは常に空なので、「キューが残っていても
  // half-close する」壊し方を入れても素通りする (実測: 壊した実装でも 20 万行が
  // 揃った)。
  //
  // 呼び出し元が遅いと連鎖が詰まる: 出力先 fd への write が止まり、サーバの
  // 送信キューが上限に達してこちらの socket が詰まり、こちらの送信キューに
  // 数百 KB が残ったままパイプが EOF に達する。この状態で half-close すると
  // 以降の write が EPIPE になり、残りが丸ごと消える。上と同じ壊し方を入れた
  // 実測では 200000 行中 188295 行しか届かず、しかも exit は 0 だった
  // (= 呼び出し元は欠落に気付けない)。だから遅い読み手が要る。
  test.skipIf(!binaryPath)(
    "preserves the tail when the caller reads slowly",
    async () => {
      const sockPath = shortSockPath("slow");
      const server = startServe(writeSecretsFile(["hunter2"]), sockPath);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);
        const proc = Bun.spawn(
          [
            binaryPath!,
            "--supervise",
            "--socket",
            sockPath,
            "--",
            realBashPath(),
            "-c",
            "for i in $(seq 200000); do echo line$i pw=hunter2; done",
          ],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env },
          },
        );

        // 受信のたびに同期的に止まる「遅い読み手」。Bun のイベントループごと
        // 止めないとカーネルのパイプバッファが埋まらず、詰まりが再現しない。
        const reader = proc.stdout.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          const until = Date.now() + 15;
          while (Date.now() < until) {
            // 同期ビジーウェイト。
          }
        }

        const lines = Buffer.concat(chunks)
          .toString()
          .split("\n")
          .filter(Boolean);
        expect(await proc.exited).toBe(0);
        expect(lines.length).toBe(200000);
        expect(lines[199999]).toBe("line200000 pw=*******");
      } finally {
        server.kill();
        await server.exited;
        fs.rmSync(sockPath, { force: true });
      }
    },
    60000,
  );

  // 本命の回帰テスト。プロセス置換方式では、フィルタが出力先パイプを握ったまま
  // bash より長く生き残るため、「子プロセスの終了」を完了シグナルにしている
  // 呼び出し元からは出力が確率的に丸ごと欠けていた。supervise モードでは
  // パイプを drain し切ってから exit するので、何度回しても欠落しない。
  //
  // デーモンは 1 本だけ起動して使い回す。呼び出しごとに起動すると、この 1 つの
  // テストで 50 回の spawn/kill を回すことになる。
  test.skipIf(!binaryPath)(
    "never loses output across repeated short runs",
    async () => {
      const sockPath = shortSockPath("repeat");
      const server = startServe(writeSecretsFile(["hunter2"]), sockPath);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);
        const mismatched: string[] = [];
        for (let i = 0; i < 50; i++) {
          const r = await runSupervisedOverSocket("echo hoge; echo 71", [], {
            sockPath,
          });
          if (r.stdout !== "hoge\n71\n")
            mismatched.push(JSON.stringify(r.stdout));
        }
        expect(mismatched).toEqual([]);
        expect(serveAlive(server)).toBe(true);
      } finally {
        server.kill();
        await server.exited;
        fs.rmSync(sockPath, { force: true });
      }
      await expectServeSilent(server);
    },
    60000,
  );

  test.skipIf(!binaryPath)("passes stdin through to the child", async () => {
    const r = await runSupervisedOverSocket(
      'read -r x; echo "got=$x"',
      ["hunter2"],
      { stdin: new TextEncoder().encode("from-stdin\n") },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("got=from-stdin\n");
  });

  // 子は呼び出し元から見て孫プロセスになるため、呼び出し元がスーパーバイザの
  // pid だけを kill しても子に届くよう転送する必要がある。転送後も drain を
  // 続けるので、シグナルハンドラが出した出力まで取りこぼさない。
  test.skipIf(!binaryPath)(
    "forwards SIGTERM to the child and still drains its output",
    async () => {
      const sockPath = shortSockPath("sigterm");
      const server = startServe(writeSecretsFile(["hunter2"]), sockPath);
      const readyFile = path.join(tmpDir, `sigterm-ready-${secretsFileSeq}`);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);
        const proc = Bun.spawn(
          [
            binaryPath!,
            "--supervise",
            "--socket",
            sockPath,
            "--",
            realBashPath(),
            "-c",
            // bash はフォアグラウンドのコマンドが終わるまで trap を保留するため、
            // 長い sleep 一発ではなく短い sleep のループで待つ。
            `trap 'echo got-term; exit 7' TERM; : > "${readyFile}"; while :; do sleep 0.05; done`,
          ],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env },
          },
        );

        // trap 設置前に kill するとテストが不安定になるので、準備完了を待つ。
        for (let i = 0; i < 200 && !fs.existsSync(readyFile); i++) {
          await Bun.sleep(25);
        }
        expect(fs.existsSync(readyFile)).toBe(true);
        proc.kill("SIGTERM");

        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        expect(stdout).toBe("got-term\n");
        expect(exitCode).toBe(7);
      } finally {
        server.kill();
        await server.exited;
        fs.rmSync(sockPath, { force: true });
      }
    },
    15000,
  );

  // fd を引き継いだまま生き残るバックグラウンドプロセスがいても、EOF を
  // 無条件に待たずアイドルタイムアウトで抜けること (呼び出し元をハングさせない)。
  // 終了判定の phase 2 がこれのために存在する。
  test.skipIf(!binaryPath)(
    "does not hang on a background process holding the pipe",
    async () => {
      const started = Date.now();
      const r = await runSupervisedOverSocket(
        "echo before; (sleep 30) & echo after",
        ["hunter2"],
      );
      const elapsed = Date.now() - started;
      expect(r.stdout).toBe("before\nafter\n");
      expect(elapsed).toBeLessThan(5000);
    },
    15000,
  );

  // 到達できないブローカーで子を起動してはならない。起動してしまうと、
  // マスクできない出力を持ったプロセスが動き出す。
  test.skipIf(!binaryPath)(
    "fails closed when the broker is absent",
    async () => {
      const proc = Bun.spawn(
        [
          binaryPath!,
          "--supervise",
          "--socket",
          "/tmp/nas-mf-absent.sock",
          "--",
          realBashPath(),
          "-c",
          "echo pw=hunter2",
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        },
      );
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(121);
      expect(stdout).toBe("");
    },
  );

  // 途中切断は再試行しない。UDS は在庫中のデータを落とさないので、途中で
  // 切れたということはピアが死んだということであり、繋ぎ直す先が無い。
  // 新しい接続は overlap 状態が空から始まるので、継ぎ目を跨ぐシークレットを
  // 取りこぼしうるという理由もある。
  test.skipIf(!binaryPath)(
    "fails closed when the broker dies mid-run",
    async () => {
      const sockPath = shortSockPath("mid");
      const server = startServe(writeSecretsFile(["hunter2"]), sockPath);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);
        const proc = Bun.spawn(
          [
            binaryPath!,
            "--supervise",
            "--socket",
            sockPath,
            "--",
            realBashPath(),
            "-c",
            "sleep 0.5; echo pw=hunter2",
          ],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env },
          },
        );
        await Bun.sleep(150);
        server.kill();
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(121);
        expect(stdout).not.toContain("hunter2");
      } finally {
        server.kill();
        await server.exited;
        fs.rmSync(sockPath, { force: true });
      }
    },
    15000,
  );

  // サーバは MAX_CONNECTIONS を超えた接続を accept して即 close する
  // (poll から外すだけだと kernel が backlog へ接続を完了させてしまい、
  // クライアントが応答も拒否も得られないまま待たされるため)。したがって
  // 上限超過のリレーが観測するのは「接続はできたが即座にきれいな EOF」で、
  // これを「ストリーム完了」と取り違えると 1 バイトも中継しないまま exit 0 に
  // なる。half-close 前の EOF は切り捨てとして 121 にしなければならない。
  //
  // 実サーバで 512 本積むのは遅いので、同じ挙動 (accept して即 close) の
  // listener を立てて経路だけを再現する。
  test.skipIf(!binaryPath)(
    "fails closed when the broker closes the connection immediately",
    async () => {
      const sockPath = shortSockPath("overcap");
      const server = Bun.listen({
        unix: sockPath,
        socket: {
          open(s) {
            s.end();
          },
          data() {},
          close() {},
          error() {},
        },
      });
      try {
        const proc = Bun.spawn(
          [
            binaryPath!,
            "--supervise",
            "--socket",
            sockPath,
            "--",
            realBashPath(),
            "-c",
            "echo pw=hunter2",
          ],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env },
          },
        );
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(121);
        expect(stdout).toBe("");
      } finally {
        server.stop(true);
        fs.rmSync(sockPath, { force: true });
      }
    },
    15000,
  );

  // コンテナ内の bash はすべてラッパーなので、supervise 下で起動した bash も
  // またラッパーになる。抑止しないと ./configure や make の各レシピ行、再帰
  // make、npm/cargo のビルドスクリプトのたびに層が積み上がり、接続数は生存
  // bash プロセス数に比例して増える。
  //
  // 検証はマスク結果ではなくマーカーを見る。マスクは冪等 (* はシークレット
  // ではない) なので、層が 1 つでも 2 つでも stdout は同一になり、出力を見ても
  // 回帰を検出できない。
  test.skipIf(!binaryPath)(
    "supervises exactly one layer when wrappers nest",
    async () => {
      const sockPath = shortSockPath("nest");
      const server = startServe(writeSecretsFile(["hunter2"]), sockPath);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);
        const wrapper = writeWrapperScript();
        const proc = Bun.spawn(
          [
            wrapper,
            "-c",
            `${wrapper} -c 'echo inner=[\${NAS_MASK_SUPERVISED:-unset}] pw=hunter2'`,
          ],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...envWithoutSupervisionMarker(),
              NAS_MASK_FILTER: binaryPath!,
              NAS_MASK_SOCKET: sockPath,
            },
          },
        );
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        // マーカーは外側の層が supervise したことを、マスクは内側のシェルの
        // 出力がその層を通ったことを示す。
        expect(stdout).toBe("inner=[1] pw=*******\n");
      } finally {
        server.kill();
        await server.exited;
        fs.rmSync(sockPath, { force: true });
      }
    },
    15000,
  );

  // 上のテストはマーカーだけを見るので、**ラッパー側**のガードを外しても通る:
  // 内側の supervisor も同じマーカーを子へ渡すため、出力は層が 1 つのときと
  // 完全に同じになる (実測でも素通りした)。契約のうちシェル側の半分を守るには、
  // 層の数そのものを数えるしかない。
  //
  // 数え方は「この socket パスを引数に持つ supervisor プロセス」。socket パスは
  // テストごとに一意なので、開発機やコンテナで別に走っている supervisor が
  // 混ざらない。数える主体は内側のシェル自身で、対象は自分の祖先だから
  // 生存が保証されており、ハンドシェイクも待ち合わせも要らない。
  //
  // grep は使わない。開発環境の grep が ugrep のことがあり、-z の意味が
  // GNU grep と違う。bash の組み込みだけで済ませれば fork も起きない。
  const COUNT_LAYERS_SCRIPT = `n=0
for f in /proc/[0-9]*/cmdline; do
  sup=0
  sock=0
  while IFS= read -r -d '' a; do
    [ "$a" = "--supervise" ] && sup=1
    [ "$a" = "$NAS_MASK_SOCKET" ] && sock=1
  done < "$f" 2>/dev/null || true
  [ "$sup" = 1 ] && [ "$sock" = 1 ] && n=$((n + 1))
done
echo "layers=$n"
`;

  test.skipIf(!binaryPath)(
    "does not stack a second supervisor on the nested wrapper",
    async () => {
      const sockPath = shortSockPath("layers");
      const server = startServe(writeSecretsFile(["hunter2"]), sockPath);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);
        const wrapper = writeWrapperScript();
        // 数えるスクリプトは**ラッパー経由で**起動する。bash.real を直接叩くと
        // ガードごと素通りして何も検証しないことになる。
        const script = path.join(tmpDir, `layers-${secretsFileSeq++}.sh`);
        fs.writeFileSync(script, COUNT_LAYERS_SCRIPT);
        const proc = Bun.spawn([wrapper, "-c", `${wrapper} ${script}`], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...envWithoutSupervisionMarker(),
            NAS_MASK_FILTER: binaryPath!,
            NAS_MASK_SOCKET: sockPath,
          },
        });
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        expect(stdout).toBe("layers=1\n");
      } finally {
        server.kill();
        await server.exited;
        fs.rmSync(sockPath, { force: true });
      }
    },
    15000,
  );

  // `cmd | head` は読み手が先に去るごく普通のパイプラインで、出力先 fd への
  // write が EPIPE になる。これはマスクの失敗ではない (出力先へ流すのは
  // サーバが返したマスク済みバイトだけで、抑止すべき未マスク出力は残っていない)
  // ので、診断も 121 も出してはならない。終了ステータスはスーパーバイザが
  // いないときと同じ — 子が SIGPIPE で死ねば 141 — でなければならない。
  test.skipIf(!binaryPath)(
    "exits cleanly when the caller stops reading (cmd | head)",
    async () => {
      const sockPath = shortSockPath("epipe");
      const server = startServe(writeSecretsFile(["hunter2"]), sockPath);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);
        const bash = realBashPath();
        // スーパーバイザの終了コードは stderr へ出す (パイプの先ではないので
        // head には食われない)。PIPESTATUS を使わないのは、その綴りが
        // TypeScript のテンプレートリテラルと衝突して lint に引っかかるため。
        const script =
          `{ "${binaryPath}" --supervise --socket "${sockPath}" -- ` +
          `"${bash}" -c 'seq 200000'; echo "supervisor=$?" >&2; } | head -2`;
        const proc = Bun.spawn([bash, "-c", script], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect(await proc.exited).toBe(0);
        expect(stdout).toBe("1\n2\n");
        // 「出力抑止」の診断が出ないこと、121 にならないこと。
        expect(stderr).not.toContain("output suppressed");
        expect(stderr).not.toContain("supervisor=121");
        // 子が SIGPIPE で死ぬので、スーパーバイザなしの `seq | head` と同じ 141。
        expect(stderr).toContain("supervisor=141");
        expect(serveAlive(server)).toBe(true);
      } finally {
        server.kill();
        await server.exited;
        fs.rmSync(sockPath, { force: true });
      }
    },
    30000,
  );

  // 出力先が閉じたストリームのパイプを読み捨てするだけだと、終わらない子
  // (`yes`) を抱えたままスーパーバイザが永遠に回り、呼び出し元がハングする。
  // 読み出し端を閉じて子に通常どおり SIGPIPE を見せる必要がある。
  test.skipIf(!binaryPath)(
    "does not hang when an unbounded child outlives the reader",
    async () => {
      const sockPath = shortSockPath("yeshead");
      const server = startServe(writeSecretsFile(["hunter2"]), sockPath);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);
        const bash = realBashPath();
        const proc = Bun.spawn(
          [
            bash,
            "-c",
            `"${binaryPath}" --supervise --socket "${sockPath}" -- ` +
              `"${bash}" -c 'yes' | head -2`,
          ],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        );
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        expect(stdout).toBe("y\ny\n");
      } finally {
        server.kill();
        await server.exited;
        fs.rmSync(sockPath, { force: true });
      }
    },
    30000,
  );

  // ラッパーは本物の /bin/bash の inode を置き換えて設置されるので、環境を
  // 落として起動された bash (env -i、env_reset 付きの sudo、su -) もここを通る。
  // ブローカーの居場所が分からない以上マスクは保証できないので素の bash へ
  // フォールバックしてはならないが、そのまま exec すると空文字列を実行しようと
  // して "exec: : not found" の 127 になり、運用者にはマスクの話だと分からない。
  // このラッパー自身が /bin/bash の inode を占めているため、ここで診断を出すと
  // 呼び出し元 (無関係なプログラム) の stderr に nas 由来のテキストが紛れ込む。
  // fail-closed のまま何も出力せず、予約コード 121 だけで原因が伝わることを見る。
  //
  // `skipIf(!binaryPath)` を付けない。検証対象はラッパースクリプト側のガード
  // だけで、nas-mask-filter のバイナリを起動しないため (env を落としたラッパーは
  // バイナリに辿り着く前に 121 で降りる)。
  test("fails closed with no output when the broker env is stripped", async () => {
    const wrapper = writeWrapperScript();
    const proc = Bun.spawn([wrapper, "-c", "echo hi"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {}, // env -i 相当
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).toBe(121);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  }, 15000);

  // socket fd が子へ漏れると単なる情報漏れでは済まず、注入オラクルになる:
  // ストリーム途中に 1 バイト差し込むとサーバ側のマッチが崩れて原文が返るため、
  // 差し込んだ値を知っていれば原文を復元できる。
  //
  // 「0/1/2 だけ」を主張することはできない (ls 自身がディレクトリ fd を握る)
  // ので、不変条件を直接見る。
  test.skipIf(!binaryPath)(
    "does not leak socket fds into the supervised child",
    async () => {
      const r = await runSupervisedOverSocket("ls -l /proc/self/fd", [
        "hunter2",
      ]);
      expect(r.stdout).not.toContain("socket:");
      expect(r.exitCode).toBe(0);
    },
  );
});
describe("nas-mask-filter --serve", () => {
  test.skipIf(!binaryPath)(
    "masks a stream over the socket",
    async () => {
      const sockPath = shortSockPath("basic");
      const proc = startServe(writeSecretsFile(["hunter2"]), sockPath);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);
        expect(await maskOverSocket(sockPath, ["pw=hunter2 done"])).toBe(
          "pw=******* done",
        );
      } finally {
        proc.kill();
        await proc.exited;
        fs.rmSync(sockPath, { force: true });
      }
      await expectServeSilent(proc);
    },
    15000,
  );

  test.skipIf(!binaryPath)(
    "masks a secret straddling a socket chunk boundary",
    async () => {
      const sockPath = shortSockPath("seam");
      const proc = startServe(writeSecretsFile(["SECRETVALUE"]), sockPath);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);
        // 間隔を空けることで、サーバに 2 つの半片を別々に処理させる。
        expect(
          await maskOverSocket(sockPath, ["head SECRE", "TVALUE tail"], 50),
        ).toBe("head *********** tail");
      } finally {
        proc.kill();
        await proc.exited;
        fs.rmSync(sockPath, { force: true });
      }
      await expectServeSilent(proc);
    },
    15000,
  );

  test.skipIf(!binaryPath)(
    "keeps per-connection overlap state isolated",
    async () => {
      const sockPath = shortSockPath("iso");
      const proc = startServe(writeSecretsFile(["hunter2"]), sockPath);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);
        const [a, b] = await Promise.all([
          maskOverSocket(sockPath, ["aaa hun", "ter2 aaa"], 30),
          maskOverSocket(sockPath, ["bbb hun", "ter2 bbb"], 30),
        ]);
        expect(a).toBe("aaa ******* aaa");
        expect(b).toBe("bbb ******* bbb");
      } finally {
        proc.kill();
        await proc.exited;
        fs.rmSync(sockPath, { force: true });
      }
      await expectServeSilent(proc);
    },
    15000,
  );

  // アイドル接続のタイムアウト刈り取りは意図的に持たない。死んだピアは fd が
  // 閉じて read が 0 を返す通常の EOF 経路で回収されるので、刈り取りが発火しうる
  // のは「生きているが黙っているだけ」の接続 (supervise 下の `sleep 900`、
  // stderr に何も書かない長時間ビルド) だけであり、これを閉じるとスーパーバイザが
  // fail-closed の 121 を返して成功するはずのコマンドが失敗する。
  // このテストが実際に保証するのは「無音のまま poll タイムアウトを何周かしても
  // 接続が落ちない」ことまでで、閾値つきの刈り取りが再導入された場合に捕まえら
  // れるのは閾値が沈黙時間 (2.5s) より短いときだけである。削除した実装の
  // IDLE_REAP_MS は 10 分だったので、あれをそのまま戻しただけではここは通って
  // しまう。10 分待つテストは現実的でないため、そこは割り切ってこの範囲を守る。
  test.skipIf(!binaryPath)(
    "keeps a silent live connection alive across poll timeouts",
    async () => {
      const sockPath = shortSockPath("idle");
      const proc = startServe(writeSecretsFile(["hunter2"]), sockPath);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);
        // POLL_TIMEOUT_MS = 1000ms。その 2 周期分より長く 1 バイトも書かない。
        expect(
          await maskOverSocket(sockPath, ["pw=hunter2 done"], 0, 2500),
        ).toBe("pw=******* done");
      } finally {
        proc.kill();
        await proc.exited;
        fs.rmSync(sockPath, { force: true });
      }
      await expectServeSilent(proc);
    },
    20000,
  );

  // 1 read チャンク (BUF_SIZE = 64KiB) を大きく超えるペイロードを流し、送信キューの
  // ドレイン経路 (短い write 後の前詰め圧縮と、吐き切った後の容量調整) を実際に
  // 通す。ここが壊れると出力はバイト単位で欠落・重複・順序入れ替わりを起こし、
  // シークレットが分断されてどちらの断片もマッチせず平文で出てしまう。
  test.skipIf(!binaryPath)(
    "streams a payload far larger than one read chunk intact",
    async () => {
      const sockPath = shortSockPath("bulk");
      const proc = startServe(writeSecretsFile(["hunter2"]), sockPath);
      try {
        expect(await waitForSocket(sockPath)).toBe(true);

        const lines: string[] = [];
        for (let i = 0; i < 64000; i++)
          lines.push(`line${i} pw=hunter2 end${i}\n`);
        const input = lines.join("");
        // BUF_SIZE = 64KiB。その 16 倍以上を 1 接続で流す。
        expect(input.length).toBeGreaterThan(16 * 64 * 1024);
        const expected = input.replaceAll("hunter2", "*******");

        const got = await maskOverSocketSlowReader(sockPath, input);

        // MiB 級の文字列を toBe に投げると失敗時に巨大な diff が出るので、
        // 最初に食い違ったオフセットだけを比較対象にする。-1 は完全一致。
        const divergesAt = (a: string, b: string): number => {
          const n = Math.min(a.length, b.length);
          for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
          return a.length === b.length ? -1 : n;
        };
        expect(got.length).toBe(expected.length);
        expect(divergesAt(got, expected)).toBe(-1);
        expect(got.includes("hunter2")).toBe(false);
      } finally {
        proc.kill();
        await proc.exited;
        fs.rmSync(sockPath, { force: true });
      }
      await expectServeSilent(proc);
    },
    30000,
  );

  // socket はエージェントの UID から到達可能で、サーバはコンテナの cgroup の
  // **外** (ホスト) で動く。したがって「読まずに書き続ける」クライアント 1 本で
  // ホストのメモリを好きなだけ食えてはならない。MAX_QUEUED_BYTES を超えた接続は
  // READ の poll を外すので、背圧は socket バッファ経由でクライアントへ伝わり、
  // サーバのメモリは上限付近で頭打ちになる。
  //
  // 検証対象はサーバの VmRSS の**増分**である点が重要。クライアント側の
  // `write()` の戻り値では上限あり・なしを区別できない (STALLING_CLIENT_PY の
  // コメント参照)。
  //
  // 前提が欠けたときは黙って return せず skip として報告する。このテストは
  // メモリ上限の唯一の証明なので、消えたことが出力に出ないと誰も気付けない。
  test.skipIf(!binaryPath || !hasProcStatus || !hasPython3)(
    "bounds server memory when a client stops reading",
    async () => {
      const sockPath = shortSockPath("bp");
      const proc = startServe(writeSecretsFile(["hunter2"]), sockPath);
      let stall: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
      try {
        expect(await waitForSocket(sockPath)).toBe(true);

        // 接続を張る前の RSS。上限の効き目は「接続によって増えた分」にしか
        // 現れないので、絶対値ではなくこの値からの増分を見る (下のコメント)。
        await Bun.sleep(200);
        const baselineRssKb = serverRssKb(proc.pid);
        expect(baselineRssKb).toBeGreaterThan(0);

        stall = Bun.spawn(["python3", writeStallingClient(), sockPath, "64"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        // 進まなくなった (= 背圧がかかった) 時点で stdout が閉じる。
        const accepted = Number(await new Response(stall.stdout).text());
        expect(accepted).toBeGreaterThan(0);

        await Bun.sleep(300);

        // **絶対 RSS ではなく増分を見る**のが要点。絶対値のうち約 3.7MB は接続と
        // 無関係な固定オーバーヘッドで、上限由来の信号は残り 0.47MB しかない。
        // そこに絶対値の閾値を置くと上限の撤去しか検出できない。
        //
        // 閾値は「MAX_QUEUED_BYTES を 2 倍に緩めたら落ちる」ように選ぶ。実測は
        // 上限にほぼ比例し (増分 ≒ MAX_QUEUED_BYTES + 約 212kB)、同じホストで
        // 何度測っても 1kB もぶれない (出荷ビルドで 3 回、いずれも同値):
        //
        //   MAX_QUEUED_BYTES | 増分     | 受理     | 接続前 RSS
        //   256KiB (出荷)    |   468kB  |  583KiB  | 3,696kB
        //   512KiB (2 倍)    |   724kB  |  839KiB  | 3,696kB
        //   1MiB   (4 倍)    | 1,236kB  | 1,351KiB | 3,700kB
        //   1280KiB (5 倍)   | 1,492kB  | 1,607KiB | 3,700kB
        //   4MiB   (16 倍)   | 4,308kB  | 4,423KiB | 3,740kB
        //
        // kernel の socket バッファは VmRSS に入らないので、この増分はホストの
        // 速度にもバッファ設定にも依存しない。よって閾値は「実測 468kB の上」
        // かつ「2 倍緩和の 724kB の下」に置けばよく、640kB とする: 実測比 1.37 倍
        // (余裕 172kB) で、2 倍緩和からは 84kB 下。増分 ≒ 上限 + 212kB なので、
        // MAX_QUEUED_BYTES が約 424KiB (約 1.7 倍) を超えた時点で落ちる。
        //
        // 緩い閾値では駄目な理由: 増分 1,536kB / 受理 2MiB だと 5 倍緩和
        // (1280KiB) まで両方素通りする。1MiB へ緩めるだけでホストの最悪値は
        // 336MiB から約 900MiB へ悪化するので、そこは捕まえられねばならない。
        const rssGrowthKb = serverRssKb(proc.pid) - baselineRssKb;
        expect(rssGrowthKb).toBeLessThan(640);
        // 受理量は上限のほかに 1 チャンク分のオーバーシュートと kernel の
        // socket バッファを含むので、増分より余裕を取る。実測 583KiB に対し
        // 896KiB なら、2 倍緩和時の 839KiB を捕まえつつホスト差を吸収できる。
        expect(accepted).toBeLessThan(896 * 1024);

        stall.kill();
        await stall.exited;
        stall = null;

        // 詰まった接続を抱えたままでも他の接続は普通に処理できる。
        expect(await maskOverSocket(sockPath, ["pw=hunter2"])).toBe(
          "pw=*******",
        );
      } finally {
        if (stall) {
          stall.kill();
          await stall.exited;
        }
        proc.kill();
        await proc.exited;
        fs.rmSync(sockPath, { force: true });
      }
      await expectServeSilent(proc);
    },
    60000,
  );
});

// バイナリが無いときだけ走るテスト。skip 件数だけでは「何が欠けていてどう直すか」
// が出力に出ないので、理由と復旧手順をテスト名で告げる pass を 1 件残す。
test.skipIf(binaryPath !== null)(
  "nas-mask-filter tests skipped (binary not built: cd src/mask-filter && zig build)",
  () => {
    expect(binaryPath).toBeNull();
  },
);
