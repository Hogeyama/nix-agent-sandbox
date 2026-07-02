/**
 * Host-side integration test for nas-maskfs (real FUSE, no Docker).
 *
 * Spawns the real nas-maskfs daemon directly (no `allow_other`, so this does
 * not depend on `/etc/fuse.conf`), mounts a real FUSE filesystem, and drives
 * it through node:fs to verify end-to-end masking behavior.
 *
 * Skips gracefully when FUSE is not usable in the current environment
 * (e.g. `/dev/fuse` missing, `fusermount3` not on PATH, or the nas-maskfs
 * binary hasn't been built yet).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveMaskFsBinPath } from "./maskfs_path.ts";
import { encodeMaskSecrets } from "./secrets_frame.ts";

const SECRET = "hunter2secret"; // 13 bytes
const MASKED = "*".repeat(13);

async function fuseUsable(): Promise<boolean> {
  try {
    await stat("/dev/fuse");
  } catch {
    return false;
  }
  if (!Bun.which("fusermount3")) return false;
  return (await resolveMaskFsBinPath()) !== null;
}

const usable = await fuseUsable();

describe.skipIf(!usable)("maskfs integration (real FUSE)", () => {
  let root: string;
  let src: string;
  let mnt: string;
  let daemon: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "nas-maskfs-it-"));
    src = path.join(root, "src");
    mnt = path.join(root, "mnt");
    await mkdir(src, { recursive: true });
    await mkdir(mnt, { recursive: true });
    await writeFile(path.join(src, "secret.env"), `DB_PASSWORD=${SECRET}\n`);
    await writeFile(path.join(src, "plain.txt"), "hello world\n");
    await mkdir(path.join(src, "sub"), { recursive: true });
    await writeFile(path.join(src, "sub", "nested.txt"), `token=${SECRET};\n`);

    const bin = (await resolveMaskFsBinPath()) as string;
    daemon = Bun.spawn([bin, src, mnt, "--write-policy=readonly"], {
      stdin: encodeMaskSecrets([SECRET]),
      stdout: "pipe",
      stderr: "pipe",
    });
    // Wait for mount readiness: poll until mnt's st_dev differs from root's.
    const rootDev = (await stat(root)).dev;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await stat(mnt)).dev !== rootDev) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("maskfs mount did not become ready");
  });

  afterAll(async () => {
    await Bun.spawn(["fusermount3", "-u", mnt], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    daemon?.kill();
    await rm(root, { recursive: true, force: true });
  });

  test("read masks the secret with same length", async () => {
    const content = await readFile(path.join(mnt, "secret.env"), "utf8");
    expect(content).toEqual(`DB_PASSWORD=${MASKED}\n`);
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
    expect(content).toEqual("hello world\n");
  });

  test("readonly policy denies write to secret-containing file", async () => {
    await expect(
      appendFile(path.join(mnt, "secret.env"), "x"),
    ).rejects.toThrow();
    // The real file underneath must be untouched.
    const real = await readFile(path.join(src, "secret.env"), "utf8");
    expect(real).toEqual(`DB_PASSWORD=${SECRET}\n`);
  });

  test("readonly policy denies unlink of secret-containing file", async () => {
    await expect(rm(path.join(mnt, "secret.env"))).rejects.toThrow();
  });

  test("non-secret file is writable and reaches the real workspace", async () => {
    await appendFile(path.join(mnt, "plain.txt"), "more\n");
    const real = await readFile(path.join(src, "plain.txt"), "utf8");
    expect(real).toEqual("hello world\nmore\n");
  });

  test("new file creation works", async () => {
    await writeFile(path.join(mnt, "created.txt"), "fresh\n");
    const real = await readFile(path.join(src, "created.txt"), "utf8");
    expect(real).toEqual("fresh\n");
  });

  test("grep-style scan does not find the secret", async () => {
    const proc = Bun.spawn(["grep", "-r", SECRET, mnt], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const code = await proc.exited;
    expect(code).toEqual(1); // grep: not found
  });
});

test.skipIf(usable)("maskfs integration skipped (no FUSE available)", () => {
  expect(true).toEqual(true);
});
