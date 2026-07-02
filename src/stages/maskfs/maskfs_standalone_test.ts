import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveMaskFsBinPath } from "./maskfs_path.ts";

const SECRET = "standalone-test-secret"; // 22 bytes
const MASKED = "*".repeat(22);

const SCRIPT_PATH = path.resolve(import.meta.dirname, "../../maskfs/maskfs");

async function fuseUsable(): Promise<boolean> {
  try {
    await stat("/dev/fuse");
  } catch {
    return false;
  }
  if (!Bun.which("fusermount3")) return false;
  if ((await resolveMaskFsBinPath()) === null) return false;
  try {
    await stat(SCRIPT_PATH);
  } catch {
    return false;
  }
  return true;
}

const usable = await fuseUsable();

describe.skipIf(!usable)("maskfs standalone CLI (real FUSE)", () => {
  let root: string;
  let src: string;
  let mnt: string;
  let binDir: string;
  let secretsFile: string;
  let daemon: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "maskfs-standalone-"));
    src = path.join(root, "src");
    mnt = path.join(root, "mnt");
    binDir = path.join(root, "bin");
    secretsFile = path.join(root, "secrets.txt");

    await mkdir(src, { recursive: true });
    await mkdir(binDir, { recursive: true });

    await writeFile(path.join(src, "secret.env"), `API_KEY=${SECRET}\n`);
    await writeFile(path.join(src, "plain.txt"), "no secrets here\n");
    await mkdir(path.join(src, "sub"), { recursive: true });
    await writeFile(path.join(src, "sub", "nested.txt"), `token=${SECRET};\n`);

    await writeFile(secretsFile, `${SECRET}\n\n`);

    const binaryPath = (await resolveMaskFsBinPath()) as string;
    await symlink(SCRIPT_PATH, path.join(binDir, "maskfs"));
    await symlink(binaryPath, path.join(binDir, "nas-maskfs"));

    daemon = Bun.spawn(
      [
        path.join(binDir, "maskfs"),
        src,
        mnt,
        "--secrets-file",
        secretsFile,
        "--write-policy",
        "readonly",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const rootDev = (await stat(root)).dev;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        if ((await stat(mnt)).dev !== rootDev) return;
      } catch {
        // mnt may not exist yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("maskfs standalone mount did not become ready");
  });

  afterAll(async () => {
    if (daemon) {
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
    // fusermount3 as fallback in case cleanup didn't run
    await Bun.spawn(["fusermount3", "-u", mnt], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    await rm(root, { recursive: true, force: true });
  });

  test("read masks the secret", async () => {
    const content = await readFile(path.join(mnt, "secret.env"), "utf8");
    expect(content).toEqual(`API_KEY=${MASKED}\n`);
    expect(content).not.toContain(SECRET);
  });

  test("file size is unchanged", async () => {
    const [real, masked] = await Promise.all([
      stat(path.join(src, "secret.env")),
      stat(path.join(mnt, "secret.env")),
    ]);
    expect(masked.size).toEqual(real.size);
  });

  test("nested dirs are traversed and masked", async () => {
    const content = await readFile(path.join(mnt, "sub", "nested.txt"), "utf8");
    expect(content).toEqual(`token=${MASKED};\n`);
  });

  test("non-secret file reads through untouched", async () => {
    const content = await readFile(path.join(mnt, "plain.txt"), "utf8");
    expect(content).toEqual("no secrets here\n");
  });

  test("readonly policy denies write to secret-containing file", async () => {
    await expect(
      appendFile(path.join(mnt, "secret.env"), "x"),
    ).rejects.toThrow();
  });

  test("Ctrl-C (SIGTERM) triggers clean unmount", async () => {
    const mnt2 = path.join(root, "mnt2");

    const d = Bun.spawn(
      [path.join(binDir, "maskfs"), src, mnt2, "--secrets-file", secretsFile],
      { stdout: "pipe", stderr: "pipe" },
    );

    const rootDev = (await stat(root)).dev;
    const deadline = Date.now() + 10_000;
    let mounted = false;
    while (Date.now() < deadline) {
      try {
        if ((await stat(mnt2)).dev !== rootDev) {
          mounted = true;
          break;
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(mounted).toBe(true);

    d.kill("SIGTERM");
    await d.exited;

    await new Promise((r) => setTimeout(r, 200));
    const mnt2Stat = await stat(mnt2).catch(() => null);
    if (mnt2Stat) {
      expect(mnt2Stat.dev).toEqual((await stat(root)).dev);
    }
  });

  test("--daemon mode exits immediately after mount", async () => {
    const mnt3 = path.join(root, "mnt3");

    const d = Bun.spawn(
      [
        path.join(binDir, "maskfs"),
        src,
        mnt3,
        "--secrets-file",
        secretsFile,
        "--daemon",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const code = await d.exited;
    const stderr = await new Response(d.stderr).text();
    expect(code).toEqual(0);
    expect(stderr).toContain("mounted");
    expect(stderr).toContain("--unmount");

    // Mount should be active
    const rootDev = (await stat(root)).dev;
    expect((await stat(mnt3)).dev).not.toEqual(rootDev);

    // Masked content should be readable
    const content = await readFile(path.join(mnt3, "secret.env"), "utf8");
    expect(content).toEqual(`API_KEY=${MASKED}\n`);

    // --unmount should work
    const u = Bun.spawn([path.join(binDir, "maskfs"), "--unmount", mnt3], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const uCode = await u.exited;
    const uStderr = await new Response(u.stderr).text();
    expect(uCode).toEqual(0);
    expect(uStderr).toContain("unmounted");

    // Mount should be gone
    await new Promise((r) => setTimeout(r, 200));
    const mnt3Stat = await stat(mnt3).catch(() => null);
    if (mnt3Stat) {
      expect(mnt3Stat.dev).toEqual(rootDev);
    }
  });
});

describe("maskfs CLI argument validation", () => {
  const runMaskfs = async (args: string[]) => {
    const proc = Bun.spawn(["bash", SCRIPT_PATH, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { code, stderr };
  };

  test("missing sourceDir shows error", async () => {
    const { code, stderr } = await runMaskfs([]);
    expect(code).not.toEqual(0);
    expect(stderr).toContain("sourceDir is required");
  });

  test("missing mountpoint shows error", async () => {
    const { code, stderr } = await runMaskfs(["/tmp/src"]);
    expect(code).not.toEqual(0);
    expect(stderr).toContain("mountpoint is required");
  });

  test("missing --secrets-file shows error", async () => {
    const { code, stderr } = await runMaskfs(["/tmp/src", "/tmp/mnt"]);
    expect(code).not.toEqual(0);
    expect(stderr).toContain("--secrets-file is required");
  });

  test("nonexistent secrets file shows error", async () => {
    const { code, stderr } = await runMaskfs([
      "/tmp/src",
      "/tmp/mnt",
      "--secrets-file",
      "/nonexistent/file",
    ]);
    expect(code).not.toEqual(0);
    expect(stderr).toContain("secrets file not found");
  });

  test("invalid --write-policy shows error", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "maskfs-argtest-"));
    const sf = path.join(tmp, "secrets.txt");
    await writeFile(sf, "long-enough-secret\n");
    const { code, stderr } = await runMaskfs([
      "/tmp/src",
      "/tmp/mnt",
      "--secrets-file",
      sf,
      "--write-policy",
      "invalid",
    ]);
    await rm(tmp, { recursive: true, force: true });
    expect(code).not.toEqual(0);
    expect(stderr).toContain("'readonly' or 'passthrough'");
  });

  test("secret shorter than 4 bytes shows error", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "maskfs-argtest-"));
    const sf = path.join(tmp, "secrets.txt");
    await writeFile(sf, "abc\n");
    const { code, stderr } = await runMaskfs([
      "/tmp/src",
      "/tmp/mnt",
      "--secrets-file",
      sf,
    ]);
    await rm(tmp, { recursive: true, force: true });
    expect(code).not.toEqual(0);
    expect(stderr).toContain("too short");
  });

  test("empty secrets file (only blank lines) shows error", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "maskfs-argtest-"));
    const sf = path.join(tmp, "secrets.txt");
    await writeFile(sf, "\n\n\n");
    const { code, stderr } = await runMaskfs([
      "/tmp/src",
      "/tmp/mnt",
      "--secrets-file",
      sf,
    ]);
    await rm(tmp, { recursive: true, force: true });
    expect(code).not.toEqual(0);
    expect(stderr).toContain("no secrets found");
  });
});

test.skipIf(usable)(
  "maskfs standalone integration skipped (no FUSE available)",
  () => {
    expect(true).toEqual(true);
  },
);
