import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  acquireClaudeRefreshLock,
  acquireDirLock,
  LockContendedError,
} from "./oauth_refresh_lock.ts";

// Root bypasses file-mode permission checks, so permission-error tests only
// mean something as an unprivileged user; skip them under root rather than
// silently passing for the wrong reason.
const runningAsRoot = process.getuid?.() === 0;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "nas-oauth-lock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

test("acquireDirLock: creates the lock directory and removes it on release", async () => {
  const lockPath = path.join(dir, "x.lock");
  const lock = await acquireDirLock(lockPath);
  expect(await exists(lockPath)).toBe(true);
  await lock.release();
  expect(await exists(lockPath)).toBe(false);
});

test("acquireDirLock: a fresh lock held elsewhere is contended", async () => {
  const lockPath = path.join(dir, "x.lock");
  await mkdir(lockPath);
  await expect(acquireDirLock(lockPath)).rejects.toBeInstanceOf(
    LockContendedError,
  );
});

test("acquireDirLock: a stale lock is taken over", async () => {
  const lockPath = path.join(dir, "x.lock");
  await mkdir(lockPath);
  const old = new Date(Date.now() - 120_000);
  await utimes(lockPath, old, old);
  const lock = await acquireDirLock(lockPath);
  await lock.release();
});

test("acquireDirLock: a non-empty stale directory is not taken over", async () => {
  const lockPath = path.join(dir, "x.lock");
  await mkdir(lockPath);
  const filePath = path.join(lockPath, "somefile");
  await writeFile(filePath, "not a proper-lockfile lock");
  const old = new Date(Date.now() - 120_000);
  await utimes(lockPath, old, old);
  await expect(acquireDirLock(lockPath)).rejects.toBeInstanceOf(
    LockContendedError,
  );
  expect(await exists(filePath)).toBe(true);
});

test.skipIf(runningAsRoot)(
  "acquireDirLock: a non-ENOENT/ENOTEMPTY rmdir error during stale takeover is rethrown",
  async () => {
    const lockPath = path.join(dir, "x.lock");
    await mkdir(lockPath);
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    // Removing write permission on the parent lets stat/lookup of the
    // existing entry still succeed (search only needs execute), but makes
    // rmdir(lockPath) fail with EACCES instead of removing it.
    await chmod(dir, 0o555);
    try {
      const error = await acquireDirLock(lockPath).catch((e) => e);
      expect(error).not.toBeInstanceOf(LockContendedError);
      expect((error as NodeJS.ErrnoException).code).toBe("EACCES");
    } finally {
      await chmod(dir, 0o755);
    }
  },
);

test("acquireDirLock: refreshes the mtime while held", async () => {
  const lockPath = path.join(dir, "x.lock");
  const lock = await acquireDirLock(lockPath, { updateMs: 20 });
  const { mtimeMs: initialMtimeMs } = await stat(lockPath);
  await Bun.sleep(60);
  const { mtimeMs } = await stat(lockPath);
  expect(mtimeMs).toBeGreaterThan(initialMtimeMs);
  expect(lock.isCompromised()).toBe(false);
  await lock.release();
  expect(await exists(lockPath)).toBe(false);
});

test("acquireDirLock: an intact lock is not compromised", async () => {
  const lockPath = path.join(dir, "x.lock");
  const lock = await acquireDirLock(lockPath, { updateMs: 20 });
  await Bun.sleep(60);
  expect(lock.isCompromised()).toBe(false);
  await lock.release();
  expect(await exists(lockPath)).toBe(false);
});

test("acquireDirLock: a filesystem that rounds mtime does not make the lock look taken over", async () => {
  const lockPath = path.join(dir, "x.lock");
  // Stores whole seconds, as NFS can. The requested time is never on a
  // second boundary, so the stored mtime always differs from it.
  const roundingSetMtime = async (p: string, t: Date) => {
    const rounded = new Date(Math.floor(t.getTime() / 1000) * 1000);
    await utimes(p, rounded, rounded);
  };
  const lock = await acquireDirLock(lockPath, {
    updateMs: 20,
    now: () => Math.floor(Date.now() / 1000) * 1000 + 500,
    setMtime: roundingSetMtime,
  });
  // Several ticks: the first sets a rounded mtime, the later ones compare
  // against what the first stored.
  await Bun.sleep(100);
  expect(lock.isCompromised()).toBe(false);
  expect((await stat(lockPath)).mtimeMs % 1000).toBe(0);
  await lock.release();
  expect(await exists(lockPath)).toBe(false);
});

test("acquireDirLock: the lock directory stays empty while held", async () => {
  const lockPath = path.join(dir, "x.lock");
  const lock = await acquireDirLock(lockPath);
  const contents = await readdir(lockPath);
  expect(contents).toEqual([]);
  await lock.release();
});

test("acquireDirLock: errors other than EEXIST are rethrown", async () => {
  const lockPath = path.join(dir, "nonexistent", "x.lock");
  const error = await acquireDirLock(lockPath).catch((e) => e);
  expect(error).not.toBeInstanceOf(LockContendedError);
});

test("acquireDirLock: a lock taken over before the first update is detected on the next update", async () => {
  const lockPath = path.join(dir, "x.lock");
  const A = await acquireDirLock(lockPath, { updateMs: 20 });
  await Bun.sleep(5);
  // B takes over, treating A as stale.
  const B = await acquireDirLock(lockPath, {
    now: () => Date.now() + 120_000,
  });
  await Bun.sleep(60);
  expect(A.isCompromised()).toBe(true);
  await A.release();
  expect(await exists(lockPath)).toBe(true);
  await B.release();
  expect(await exists(lockPath)).toBe(false);
});

test("acquireDirLock: release does not remove a lock taken over before any update", async () => {
  const lockPath = path.join(dir, "x.lock");
  const A = await acquireDirLock(lockPath, { updateMs: 60_000 });
  await Bun.sleep(5);
  // B takes over before A's first update tick.
  const B = await acquireDirLock(lockPath, {
    now: () => Date.now() + 120_000,
  });
  await A.release();
  expect(A.isCompromised()).toBe(true);
  expect(await exists(lockPath)).toBe(true);
  await B.release();
  expect(await exists(lockPath)).toBe(false);
});

test("acquireClaudeRefreshLock: takes both the current and the legacy lock", async () => {
  const claudeDir = path.join(dir, ".claude");
  await mkdir(claudeDir);
  const lock = await acquireClaudeRefreshLock(claudeDir);
  expect(await exists(path.join(claudeDir, ".oauth_refresh.lock"))).toBe(true);
  expect(await exists(`${claudeDir}.lock`)).toBe(true);
  await lock.release();
  expect(await exists(path.join(claudeDir, ".oauth_refresh.lock"))).toBe(false);
  expect(await exists(`${claudeDir}.lock`)).toBe(false);
});

test("acquireClaudeRefreshLock: releases the first lock when the legacy lock is contended", async () => {
  const claudeDir = path.join(dir, ".claude");
  await mkdir(claudeDir);
  await mkdir(`${claudeDir}.lock`);
  await expect(acquireClaudeRefreshLock(claudeDir)).rejects.toBeInstanceOf(
    LockContendedError,
  );
  expect(await exists(path.join(claudeDir, ".oauth_refresh.lock"))).toBe(false);
});

test("acquireClaudeRefreshLock: a contended current lock fails without taking the legacy lock", async () => {
  const claudeDir = path.join(dir, ".claude");
  await mkdir(claudeDir);
  await mkdir(path.join(claudeDir, ".oauth_refresh.lock"));
  await expect(acquireClaudeRefreshLock(claudeDir)).rejects.toBeInstanceOf(
    LockContendedError,
  );
  expect(await exists(`${claudeDir}.lock`)).toBe(false);
});

test.skipIf(runningAsRoot)(
  "acquireClaudeRefreshLock: release rejects when the legacy rmdir fails, but still frees the current lock",
  async () => {
    const tempDir = await mkdtemp(
      path.join(tmpdir(), "nas-oauth-lock-legacy-"),
    );
    try {
      const claudeDir = path.join(tempDir, ".claude");
      await mkdir(claudeDir);
      const lock = await acquireClaudeRefreshLock(claudeDir);

      // The legacy lock is `<claudeDir>.lock`, a sibling of `.claude` in
      // tempDir. A read-only tempDir makes its rmdir fail with EACCES
      // without touching the lock's inode or mtime, so stillOwned() still
      // reports it as owned and release() goes on to rmdir. The current
      // lock lives inside `.claude`, which stays writable.
      await chmod(tempDir, 0o555);

      await expect(lock.release()).rejects.toThrow();
      // The current lock is still released via the `finally` in
      // acquireClaudeRefreshLock's release(), despite the legacy rejection.
      expect(await exists(path.join(claudeDir, ".oauth_refresh.lock"))).toBe(
        false,
      );
    } finally {
      await chmod(tempDir, 0o755).catch(() => {});
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);
