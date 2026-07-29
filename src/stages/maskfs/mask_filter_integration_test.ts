import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMaskFilterBinPath } from "./mask_filter_path.ts";
import { encodeMaskSecrets } from "./secrets_frame.ts";

let binaryPath: string | null = null;
let tmpDir: string;

beforeAll(async () => {
  binaryPath = await resolveMaskFilterBinPath();
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

async function runSupervised(
  script: string,
  secrets: string[],
  opts?: { argv0?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!binaryPath) throw new Error("nas-mask-filter binary not found");
  const secretsFile = writeSecretsFile(secrets);
  const argv0Args = opts?.argv0 ? ["--argv0", opts.argv0] : [];
  const proc = Bun.spawn(
    [
      binaryPath,
      "--supervise",
      ...argv0Args,
      "--",
      realBashPath(),
      "-c",
      script,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NAS_MASK_SECRETS_FILE: secretsFile },
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
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

describe("nas-mask-filter binary", () => {
  test("masks single secret", async () => {
    if (!binaryPath) return; // skip if not built
    const result = await runFilter("password=hunter2 done", ["hunter2"]);
    expect(result).toBe("password=******* done");
  });

  test("masks multiple secrets", async () => {
    if (!binaryPath) return;
    const result = await runFilter("a=tok1 b=tok22 c=tok1", ["tok1", "tok22"]);
    expect(result).toBe("a=**** b=***** c=****");
  });

  test("passes through when no secrets match", async () => {
    if (!binaryPath) return;
    const result = await runFilter("nothing to mask here", ["nonexistent"]);
    expect(result).toBe("nothing to mask here");
  });

  test("handles empty input", async () => {
    if (!binaryPath) return;
    const result = await runFilter("", ["secret"]);
    expect(result).toBe("");
  });

  test("masks secret spanning large input", async () => {
    if (!binaryPath) return;
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
  test("masks stdout of the supervised child", async () => {
    if (!binaryPath) return;
    const r = await runSupervised("echo pw=hunter2", ["hunter2"]);
    expect(r.stdout).toBe("pw=*******\n");
    expect(r.exitCode).toBe(0);
  });

  test("masks stderr of the supervised child", async () => {
    if (!binaryPath) return;
    const r = await runSupervised("echo pw=hunter2 >&2", ["hunter2"]);
    expect(r.stderr).toBe("pw=*******\n");
    expect(r.stdout).toBe("");
  });

  test("propagates the child exit code", async () => {
    if (!binaryPath) return;
    const r = await runSupervised("exit 42", ["hunter2"]);
    expect(r.exitCode).toBe(42);
  });

  test("maps death by signal to 128+signo", async () => {
    if (!binaryPath) return;
    const r = await runSupervised("kill -TERM $$", ["hunter2"]);
    expect(r.exitCode).toBe(128 + 15);
  });

  test("--argv0 sets the child's argv[0]", async () => {
    if (!binaryPath) return;
    const r = await runSupervised('echo "argv0=$0"', ["hunter2"], {
      argv0: "-bash",
    });
    expect(r.stdout).toBe("argv0=-bash\n");
  });

  test("preserves output larger than the pipe buffer", async () => {
    if (!binaryPath) return;
    const r = await runSupervised(
      "for i in $(seq 5000); do echo line$i; done",
      ["hunter2"],
    );
    const lines = r.stdout.split("\n").filter(Boolean);
    expect(lines.length).toBe(5000);
    expect(lines[4999]).toBe("line5000");
    expect(r.exitCode).toBe(0);
  });

  // 本命の回帰テスト。プロセス置換方式では、フィルタが出力先パイプを握ったまま
  // bash より長く生き残るため、「子プロセスの終了」を完了シグナルにしている
  // 呼び出し元からは出力が確率的に丸ごと欠けていた。supervise モードでは
  // パイプを drain し切ってから exit するので、何度回しても欠落しない。
  test("never loses output across repeated short runs", async () => {
    if (!binaryPath) return;
    const mismatched: string[] = [];
    for (let i = 0; i < 50; i++) {
      const r = await runSupervised("echo hoge; echo 71", ["hunter2"]);
      if (r.stdout !== "hoge\n71\n") mismatched.push(JSON.stringify(r.stdout));
    }
    expect(mismatched).toEqual([]);
  });

  test("passes stdin through to the child", async () => {
    if (!binaryPath) return;
    const secretsFile = writeSecretsFile(["hunter2"]);
    const proc = Bun.spawn(
      [
        binaryPath,
        "--supervise",
        "--",
        realBashPath(),
        "-c",
        'read -r x; echo "got=$x"',
      ],
      {
        stdin: new TextEncoder().encode("from-stdin\n"),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NAS_MASK_SECRETS_FILE: secretsFile },
      },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("got=from-stdin\n");
  });

  // 子は呼び出し元から見て孫プロセスになるため、呼び出し元がスーパーバイザの
  // pid だけを kill しても子に届くよう転送する必要がある。転送後も drain を
  // 続けるので、シグナルハンドラが出した出力まで取りこぼさない。
  test("forwards SIGTERM to the child and still drains its output", async () => {
    if (!binaryPath) return;
    const secretsFile = writeSecretsFile(["hunter2"]);
    const readyFile = path.join(tmpDir, `sigterm-ready-${secretsFileSeq}`);
    const proc = Bun.spawn(
      [
        binaryPath,
        "--supervise",
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
        env: { ...process.env, NAS_MASK_SECRETS_FILE: secretsFile },
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
  }, 15000);

  // fd を引き継いだまま生き残るバックグラウンドプロセスがいても、EOF を
  // 無条件に待たずアイドルタイムアウトで抜けること (呼び出し元をハングさせない)。
  test("does not hang on a background process holding the pipe", async () => {
    if (!binaryPath) return;
    const started = Date.now();
    const r = await runSupervised("echo before; (sleep 30) & echo after", [
      "hunter2",
    ]);
    const elapsed = Date.now() - started;
    expect(r.stdout).toBe("before\nafter\n");
    expect(elapsed).toBeLessThan(5000);
  }, 15000);
});

describe("nas-mask-filter --serve", () => {
  test("masks a stream over the socket", async () => {
    if (!binaryPath) return;
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
  }, 15000);

  test("masks a secret straddling a socket chunk boundary", async () => {
    if (!binaryPath) return;
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
  }, 15000);

  test("keeps per-connection overlap state isolated", async () => {
    if (!binaryPath) return;
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
  }, 15000);

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
  test("keeps a silent live connection alive across poll timeouts", async () => {
    if (!binaryPath) return;
    const sockPath = shortSockPath("idle");
    const proc = startServe(writeSecretsFile(["hunter2"]), sockPath);
    try {
      expect(await waitForSocket(sockPath)).toBe(true);
      // POLL_TIMEOUT_MS = 1000ms。その 2 周期分より長く 1 バイトも書かない。
      expect(await maskOverSocket(sockPath, ["pw=hunter2 done"], 0, 2500)).toBe(
        "pw=******* done",
      );
    } finally {
      proc.kill();
      await proc.exited;
      fs.rmSync(sockPath, { force: true });
    }
    await expectServeSilent(proc);
  }, 20000);

  // 1 read チャンク (BUF_SIZE = 64KiB) を大きく超えるペイロードを流し、送信キューの
  // ドレイン経路 (短い write 後の前詰め圧縮と、吐き切った後の容量調整) を実際に
  // 通す。ここが壊れると出力はバイト単位で欠落・重複・順序入れ替わりを起こし、
  // シークレットが分断されてどちらの断片もマッチせず平文で出てしまう。
  test("streams a payload far larger than one read chunk intact", async () => {
    if (!binaryPath) return;
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
  }, 30000);
});
