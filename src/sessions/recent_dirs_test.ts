import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  addRecentDir,
  RECENT_DIRS_MAX,
  readRecentDirs,
  resolveRecentDirsFile,
} from "./recent_dirs.ts";

describe("resolveRecentDirsFile", () => {
  const origOverride = process.env.NAS_RECENT_DIRS_FILE;
  const origXdg = process.env.XDG_STATE_HOME;
  const origHome = process.env.HOME;

  afterEach(() => {
    process.env.NAS_RECENT_DIRS_FILE = origOverride;
    if (origXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = origXdg;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  });

  test("honors NAS_RECENT_DIRS_FILE override", () => {
    process.env.NAS_RECENT_DIRS_FILE = "/custom/recent.json";
    expect(resolveRecentDirsFile()).toBe("/custom/recent.json");
  });

  test("uses XDG_STATE_HOME when set", () => {
    delete process.env.NAS_RECENT_DIRS_FILE;
    process.env.XDG_STATE_HOME = "/xdg/state";
    expect(resolveRecentDirsFile()).toBe("/xdg/state/nas/recent_dirs.json");
  });

  test("falls back to HOME/.local/state", () => {
    delete process.env.NAS_RECENT_DIRS_FILE;
    delete process.env.XDG_STATE_HOME;
    process.env.HOME = "/home/u";
    expect(resolveRecentDirsFile()).toBe(
      "/home/u/.local/state/nas/recent_dirs.json",
    );
  });

  test("throws when neither is set", () => {
    delete process.env.NAS_RECENT_DIRS_FILE;
    delete process.env.XDG_STATE_HOME;
    delete process.env.HOME;
    expect(() => resolveRecentDirsFile()).toThrow();
  });
});

describe("recent dirs read/write", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nas-recent-"));
    file = path.join(dir, "recent.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("readRecentDirs returns [] when file missing", async () => {
    expect(await readRecentDirs(file)).toEqual([]);
  });

  test("addRecentDir creates file and stores entry", async () => {
    await addRecentDir("/a", file);
    expect(await readRecentDirs(file)).toEqual(["/a"]);
  });

  test("addRecentDir moves existing entry to front (MRU)", async () => {
    await addRecentDir("/a", file);
    await addRecentDir("/b", file);
    await addRecentDir("/c", file);
    await addRecentDir("/a", file);
    expect(await readRecentDirs(file)).toEqual(["/a", "/c", "/b"]);
  });

  test("addRecentDir caps at RECENT_DIRS_MAX", async () => {
    for (let i = 0; i < RECENT_DIRS_MAX + 5; i++) {
      await addRecentDir(`/d${i}`, file);
    }
    const list = await readRecentDirs(file);
    expect(list.length).toBe(RECENT_DIRS_MAX);
    expect(list[0]).toBe(`/d${RECENT_DIRS_MAX + 4}`);
  });

  test("readRecentDirs ignores non-string entries", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify(["/a", 42, null, "/b"]));
    expect(await readRecentDirs(file)).toEqual(["/a", "/b"]);
  });

  test("readRecentDirs returns [] for non-array JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({ foo: "bar" }));
    expect(await readRecentDirs(file)).toEqual([]);
  });
});
