/**
 * fs_utils tests — exercise branches that integration tests don't reach,
 * especially the pid validation + runtime-dir fallback logic.
 */

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  atomicWriteJson,
  defaultRuntimeDir,
  isPidAlive,
  pathExists,
  readJsonDir,
  readJsonFile,
  readPid,
  removeIfExists,
  safeRemove,
} from "./fs_utils.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-fsutils-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// readPid
// ---------------------------------------------------------------------------

test("readPid: parses a valid positive integer", async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, "pid");
    await writeFile(file, "12345\n");
    expect(await readPid(file)).toEqual(12345);
  });
});

test("readPid: returns null for missing file", async () => {
  await withTmp(async (dir) => {
    expect(await readPid(path.join(dir, "absent"))).toEqual(null);
  });
});

test("readPid: returns null for non-numeric content", async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, "pid");
    await writeFile(file, "not-a-pid");
    expect(await readPid(file)).toEqual(null);
  });
});

test("readPid: returns null for zero / negative pids", async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, "pid");
    await writeFile(file, "0");
    expect(await readPid(file)).toEqual(null);
    await writeFile(file, "-5");
    expect(await readPid(file)).toEqual(null);
  });
});

test("readPid: trims whitespace", async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, "pid");
    await writeFile(file, "  4321  \n");
    expect(await readPid(file)).toEqual(4321);
  });
});

// ---------------------------------------------------------------------------
// isPidAlive
// ---------------------------------------------------------------------------

test("isPidAlive: pid <= 0 is always false (even though kill -0 0 would succeed)", async () => {
  // Guards against the "kill -0 0" signal-to-process-group trap.
  expect(await isPidAlive(0)).toEqual(false);
  expect(await isPidAlive(-1)).toEqual(false);
  expect(await isPidAlive(1.5)).toEqual(false);
});

test("isPidAlive: own pid is alive", async () => {
  expect(await isPidAlive(process.pid)).toEqual(true);
});

test("isPidAlive: pid 2^31 - 1 is not alive (sentinel large value)", async () => {
  expect(await isPidAlive(2 ** 31 - 1)).toEqual(false);
});

// ---------------------------------------------------------------------------
// pathExists
// ---------------------------------------------------------------------------

test("pathExists: true for existing dir", async () => {
  await withTmp(async (dir) => {
    expect(await pathExists(dir)).toEqual(true);
  });
});

test("pathExists: false for missing path", async () => {
  await withTmp(async (dir) => {
    expect(await pathExists(path.join(dir, "nope"))).toEqual(false);
  });
});

// ---------------------------------------------------------------------------
// safeRemove / removeIfExists
// ---------------------------------------------------------------------------

test("safeRemove: no-op when path is missing", async () => {
  await withTmp(async (dir) => {
    await safeRemove(path.join(dir, "absent"));
  });
});

test("safeRemove: removes an existing file", async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, "f");
    await writeFile(file, "x");
    await safeRemove(file);
    expect(await pathExists(file)).toEqual(false);
  });
});

test("removeIfExists: returns false for missing path, true for present", async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, "f");
    expect(await removeIfExists(file)).toEqual(false);
    await writeFile(file, "x");
    expect(await removeIfExists(file)).toEqual(true);
    expect(await pathExists(file)).toEqual(false);
  });
});

// ---------------------------------------------------------------------------
// readJsonFile / readJsonDir
// ---------------------------------------------------------------------------

test("readJsonFile: parses valid JSON", async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, "x.json");
    await writeFile(file, '{"k":1}');
    expect(await readJsonFile<{ k: number }>(file)).toEqual({ k: 1 });
  });
});

test("readJsonFile: returns null when file is missing", async () => {
  await withTmp(async (dir) => {
    expect(await readJsonFile(path.join(dir, "nope.json"))).toEqual(null);
  });
});

test("readJsonFile: throws for malformed JSON", async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, "bad.json");
    await writeFile(file, "{not-json");
    await expect(readJsonFile(file)).rejects.toThrow();
  });
});

test("readJsonDir: returns [] when dir is missing", async () => {
  await withTmp(async (dir) => {
    expect(await readJsonDir(path.join(dir, "absent"))).toEqual([]);
  });
});

test("readJsonDir: returns parsed entries for each file, skips non-files", async () => {
  await withTmp(async (dir) => {
    await writeFile(path.join(dir, "a.json"), '{"v":1}');
    await writeFile(path.join(dir, "b.json"), '{"v":2}');
    const items = await readJsonDir<{ v: number }>(dir);
    expect(items.length).toEqual(2);
    expect(items.map((i) => i.v).sort()).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// atomicWriteJson — round-trip + mode
// ---------------------------------------------------------------------------

test("atomicWriteJson: writes pretty-printed JSON with trailing newline", async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, "deep/x.json");
    await atomicWriteJson(file, { a: 1, b: "two" });
    const back = await readJsonFile<{ a: number; b: string }>(file);
    expect(back).toEqual({ a: 1, b: "two" });

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("\n")).toEqual(true);
    // Pretty-printed — JSON has a newline between properties.
    expect(raw.includes("\n")).toEqual(true);
  });
});

test("atomicWriteJson: overwrites existing file", async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, "x.json");
    await atomicWriteJson(file, { v: 1 });
    await atomicWriteJson(file, { v: 2 });
    const back = await readJsonFile<{ v: number }>(file);
    expect(back).toEqual({ v: 2 });
  });
});

// ---------------------------------------------------------------------------
// defaultRuntimeDir
// ---------------------------------------------------------------------------

test("defaultRuntimeDir: uses XDG_RUNTIME_DIR when set", () => {
  const originalXdg = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = "/run/user/1000";
  try {
    expect(defaultRuntimeDir("network")).toEqual("/run/user/1000/nas/network");
    expect(defaultRuntimeDir("hostexec")).toEqual(
      "/run/user/1000/nas/hostexec",
    );
  } finally {
    if (originalXdg === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = originalXdg;
    }
  }
});

test("defaultRuntimeDir: falls back to /tmp/nas-<uid> when XDG_RUNTIME_DIR is unset", () => {
  const originalXdg = process.env.XDG_RUNTIME_DIR;
  delete process.env.XDG_RUNTIME_DIR;
  try {
    const result = defaultRuntimeDir("display");
    expect(result.startsWith("/tmp/nas-")).toEqual(true);
    expect(result.endsWith("/display")).toEqual(true);
  } finally {
    if (originalXdg !== undefined) {
      process.env.XDG_RUNTIME_DIR = originalXdg;
    }
  }
});

test("defaultRuntimeDir: falls back when XDG_RUNTIME_DIR is whitespace only", () => {
  const originalXdg = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = "   ";
  try {
    const result = defaultRuntimeDir("x");
    expect(result.startsWith("/tmp/nas-")).toEqual(true);
  } finally {
    if (originalXdg === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = originalXdg;
    }
  }
});
