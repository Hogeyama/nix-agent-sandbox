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
