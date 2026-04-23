import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  generateWsToken,
  loadOrCreateWsToken,
  tokenEquals,
} from "./ws_token.ts";

const IS_POSIX = process.platform !== "win32";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-ws-token-test-"));
  let primary: unknown = null;
  try {
    await fn(dir);
  } catch (err) {
    primary = err;
  }
  // Cleanup outside `finally` so a cleanup failure never shadows a primary
  // test failure (CLAUDE.md: cleanup must not mask the original error).
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (cleanupErr) {
    if (primary === null) throw cleanupErr;
    // else: drop cleanup error so the real test failure surfaces below
  }
  if (primary !== null) throw primary;
}

test("generateWsToken: returns base64url chars only, 43 chars, differs between calls", () => {
  const a = generateWsToken();
  const b = generateWsToken();
  expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(b).toMatch(/^[A-Za-z0-9_-]+$/);
  // 32 bytes base64url without padding = ceil(32*4/3) = 43 chars
  expect(a.length).toBe(43);
  expect(b.length).toBe(43);
  expect(a).not.toBe(b);
});

test("loadOrCreateWsToken: creates file with 0600 perms on first call", async () => {
  await withTmpDir(async (dir) => {
    const token = await loadOrCreateWsToken(dir);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    const p = path.join(dir, "daemon.token");
    const raw = await readFile(p, "utf-8");
    expect(raw.trim()).toBe(token);

    if (IS_POSIX) {
      const st = await stat(p);
      expect(st.mode & 0o777).toBe(0o600);
    }
  });
});

test("loadOrCreateWsToken: returns the same token on second call and preserves 0600", async () => {
  await withTmpDir(async (dir) => {
    const first = await loadOrCreateWsToken(dir);
    const second = await loadOrCreateWsToken(dir);
    expect(second).toBe(first);

    if (IS_POSIX) {
      const st = await stat(path.join(dir, "daemon.token"));
      expect(st.mode & 0o777).toBe(0o600);
    }
  });
});

test("loadOrCreateWsToken: corrects overly permissive perms on load", async () => {
  if (!IS_POSIX) return; // chmod bits not meaningful on Windows
  await withTmpDir(async (dir) => {
    const p = path.join(dir, "daemon.token");
    // Seed a valid token file with wide-open permissions.
    const seeded = generateWsToken();
    await writeFile(p, seeded, { mode: 0o644 });
    await chmod(p, 0o644);

    const loaded = await loadOrCreateWsToken(dir);
    expect(loaded).toBe(seeded);

    const st = await stat(p);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

test("loadOrCreateWsToken: regenerates when stored file is empty / whitespace", async () => {
  await withTmpDir(async (dir) => {
    const p = path.join(dir, "daemon.token");
    await writeFile(p, "   \n\t  ", { mode: 0o600 });

    const token = await loadOrCreateWsToken(dir);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBe(43);

    const raw = await readFile(p, "utf-8");
    expect(raw.trim()).toBe(token);

    if (IS_POSIX) {
      const st = await stat(p);
      expect(st.mode & 0o777).toBe(0o600);
    }
  });
});

test("tokenEquals: returns true for identical tokens", () => {
  const t = generateWsToken();
  expect(tokenEquals(t, t)).toBe(true);
});

test("tokenEquals: returns false for different same-length tokens", () => {
  const a = generateWsToken();
  const b = generateWsToken();
  expect(tokenEquals(a, b)).toBe(false);
});

test("tokenEquals: returns false for length mismatch without throwing (short)", () => {
  expect(tokenEquals("abc", "abcdef")).toBe(false);
});

test("tokenEquals: returns false for length mismatch without throwing (long)", () => {
  const a = generateWsToken();
  expect(tokenEquals(a, `${a}x`)).toBe(false);
});

test("tokenEquals: handles empty strings safely", () => {
  expect(tokenEquals("", "")).toBe(true);
  expect(tokenEquals("", "x")).toBe(false);
  expect(tokenEquals("x", "")).toBe(false);
});
