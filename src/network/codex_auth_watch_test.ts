import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CodexOAuthUnavailableError } from "../agents/codex_oauth.ts";
import {
  CODEX_AUTH_CHECK_INTERVAL_MS,
  type CodexAuthWatchDeps,
  type FileIdentity,
  liveCodexAuthWatchDeps,
  watchCodexAuthFile,
} from "./codex_auth_watch.ts";

interface Fake {
  identity: FileIdentity | null;
  onEvent: (() => void) | null;
  scheduled: { fn: () => void; delayMs: number }[];
  unwatched: boolean;
}

function fakeDeps(fake: Fake): CodexAuthWatchDeps {
  return {
    identify: async () => fake.identity,
    watch: (onEvent) => {
      fake.onEvent = onEvent;
      return () => {
        fake.unwatched = true;
      };
    },
    schedule: (fn, delayMs) => {
      const entry = { fn, delayMs };
      fake.scheduled.push(entry);
      return () => {
        fake.scheduled = fake.scheduled.filter((e) => e !== entry);
      };
    },
  };
}

function newFake(): Fake {
  return {
    identity: { dev: 1, ino: 10 },
    onEvent: null,
    scheduled: [],
    unwatched: false,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("watchCodexAuthFile: fails when the file is missing at start", async () => {
  const fake = newFake();
  fake.identity = null;
  await expect(
    watchCodexAuthFile(fakeDeps(fake), () => {}),
  ).rejects.toBeInstanceOf(CodexOAuthUnavailableError);
});

test("watchCodexAuthFile: an in-place write does not fire", async () => {
  const fake = newFake();
  let fired = 0;
  const stop = await watchCodexAuthFile(fakeDeps(fake), () => fired++);
  fake.onEvent?.();
  await flush();
  expect(fired).toBe(0);
  expect(fake.scheduled.map((e) => e.delayMs)).toEqual([
    CODEX_AUTH_CHECK_INTERVAL_MS,
  ]);
  stop();
  expect(fake.unwatched).toBe(true);
  expect(fake.scheduled).toEqual([]);
});

test("watchCodexAuthFile: removal fires once and stops watching", async () => {
  const fake = newFake();
  let fired = 0;
  await watchCodexAuthFile(fakeDeps(fake), () => fired++);
  fake.identity = null;
  fake.onEvent?.();
  fake.onEvent?.();
  await flush();
  expect(fired).toBe(1);
  expect(fake.unwatched).toBe(true);
  expect(fake.scheduled).toEqual([]);
});

test("watchCodexAuthFile: a replaced inode found by the periodic check fires", async () => {
  const fake = newFake();
  let fired = 0;
  await watchCodexAuthFile(fakeDeps(fake), () => fired++);
  fake.identity = { dev: 1, ino: 11 };
  fake.scheduled[0]?.fn();
  await flush();
  expect(fired).toBe(1);
});

test("watchCodexAuthFile: the periodic check reschedules itself", async () => {
  const fake = newFake();
  const stop = await watchCodexAuthFile(fakeDeps(fake), () => {});
  const first = fake.scheduled[0];
  fake.scheduled = [];
  first?.fn();
  await flush();
  expect(fake.scheduled.map((e) => e.delayMs)).toEqual([
    CODEX_AUTH_CHECK_INTERVAL_MS,
  ]);
  stop();
});

test("liveCodexAuthWatchDeps: distinguishes rename from an in-place write", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-codex-watch-"));
  try {
    const dir = path.join(home, ".codex");
    await mkdir(dir);
    const file = path.join(dir, "auth.json");
    await writeFile(file, "a");
    const deps = liveCodexAuthWatchDeps(home);
    const before = await deps.identify();
    await writeFile(file, "b");
    expect(await deps.identify()).toEqual(before);
    await writeFile(path.join(dir, "auth.json.tmp"), "c");
    await rename(path.join(dir, "auth.json.tmp"), file);
    expect(await deps.identify()).not.toEqual(before);
    await rm(file);
    expect(await deps.identify()).toBeNull();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
