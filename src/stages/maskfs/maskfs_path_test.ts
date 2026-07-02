import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveMaskFsBinPath } from "./maskfs_path.ts";

test("resolveMaskFsBinPath finds binary under assetDir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-maskfs-path-"));
  try {
    await mkdir(path.join(dir, "maskfs"), { recursive: true });
    await writeFile(path.join(dir, "maskfs", "nas-maskfs"), "");
    const resolved = await resolveMaskFsBinPath({ assetDir: dir });
    expect(resolved).toEqual(path.join(dir, "maskfs", "nas-maskfs"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveMaskFsBinPath returns null when missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-maskfs-path-"));
  try {
    const resolved = await resolveMaskFsBinPath({ assetDir: dir });
    expect(resolved).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
