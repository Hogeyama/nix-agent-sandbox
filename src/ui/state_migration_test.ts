/**
 * Tests for `migrateLegacyUiState`: idempotent one-shot migration of UI
 * daemon state from `$XDG_CACHE_HOME/nas/ui` to `$XDG_STATE_HOME/nas/ui`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { migrateLegacyUiState } from "./state_migration.ts";

describe("migrateLegacyUiState", () => {
  const origCache = process.env.XDG_CACHE_HOME;
  const origState = process.env.XDG_STATE_HOME;
  const origHome = process.env.HOME;

  let root: string;
  let legacyDir: string;
  let newDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "nas-ui-mig-"));
    process.env.XDG_CACHE_HOME = path.join(root, "cache");
    process.env.XDG_STATE_HOME = path.join(root, "state");
    legacyDir = path.join(root, "cache", "nas", "ui");
    newDir = path.join(root, "state", "nas", "ui");
  });

  afterEach(async () => {
    if (origCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = origCache;
    if (origState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = origState;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    await rm(root, { recursive: true, force: true });
  });

  async function fileExists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  function neverLegacyDaemonAlive(): Promise<boolean> {
    return Promise.resolve(false);
  }

  // 1. noop when legacy dir absent.
  test("returns noop when legacy dir does not exist", async () => {
    const result = await migrateLegacyUiState({
      isLegacyDaemonAlive: neverLegacyDaemonAlive,
      log: () => {},
    });
    expect(result).toEqual({ kind: "noop" });
    expect(await fileExists(newDir)).toBe(false);
  });

  // 2. happy path with all three files.
  test("migrates daemon.json, daemon.token, daemon.log on the same fs", async () => {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "daemon.json"),
      JSON.stringify({ port: 3939, startedAt: "x" }),
    );
    await writeFile(path.join(legacyDir, "daemon.token"), "tok");
    await chmod(path.join(legacyDir, "daemon.token"), 0o600);
    await writeFile(path.join(legacyDir, "daemon.log"), "log line\n");

    const result = await migrateLegacyUiState({
      isLegacyDaemonAlive: neverLegacyDaemonAlive,
      log: () => {},
    });

    expect(result.kind).toBe("migrated");
    if (result.kind === "migrated") {
      expect(result.movedFiles.sort()).toEqual([
        "daemon.json",
        "daemon.log",
        "daemon.token",
      ]);
    }

    expect(await readFile(path.join(newDir, "daemon.token"), "utf8")).toBe(
      "tok",
    );
    const tokenStat = await stat(path.join(newDir, "daemon.token"));
    expect(tokenStat.mode & 0o777).toBe(0o600);
    expect(await fileExists(legacyDir)).toBe(false);
  });

  // 3. token-only migration.
  test("migrates only daemon.token when others are absent", async () => {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, "daemon.token"), "tok");
    await chmod(path.join(legacyDir, "daemon.token"), 0o600);

    const result = await migrateLegacyUiState({
      isLegacyDaemonAlive: neverLegacyDaemonAlive,
      log: () => {},
    });

    expect(result).toEqual({ kind: "migrated", movedFiles: ["daemon.token"] });
    const tokenStat = await stat(path.join(newDir, "daemon.token"));
    expect(tokenStat.mode & 0o777).toBe(0o600);
    expect(await fileExists(legacyDir)).toBe(false);
  });

  // 4. legacy dir is empty.
  test("returns noop and removes empty legacy dir", async () => {
    await mkdir(legacyDir, { recursive: true });

    const result = await migrateLegacyUiState({
      isLegacyDaemonAlive: neverLegacyDaemonAlive,
      log: () => {},
    });

    expect(result).toEqual({ kind: "noop" });
    expect(await fileExists(legacyDir)).toBe(false);
  });

  // 5. new daemon.json already exists -> skipped-new-exists, legacy untouched.
  test("skips when new daemon.json already exists", async () => {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "daemon.json"),
      JSON.stringify({ port: 4040 }),
    );
    await mkdir(newDir, { recursive: true });
    await writeFile(
      path.join(newDir, "daemon.json"),
      JSON.stringify({ port: 5050 }),
    );

    const warnings: string[] = [];
    const result = await migrateLegacyUiState({
      isLegacyDaemonAlive: neverLegacyDaemonAlive,
      log: (msg) => warnings.push(msg),
    });

    expect(result).toEqual({ kind: "skipped-new-exists" });
    // legacy file untouched
    expect(
      JSON.parse(await readFile(path.join(legacyDir, "daemon.json"), "utf8")),
    ).toEqual({ port: 4040 });
    // new file untouched
    expect(
      JSON.parse(await readFile(path.join(newDir, "daemon.json"), "utf8")),
    ).toEqual({ port: 5050 });
    expect(warnings.some((w) => w.includes("legacy UI state directory"))).toBe(
      true,
    );
  });

  // 6. idempotent: second call after a successful migration is skipped.
  test("is idempotent across two invocations", async () => {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "daemon.json"),
      JSON.stringify({ port: 3939 }),
    );
    await writeFile(path.join(legacyDir, "daemon.token"), "tok");
    await chmod(path.join(legacyDir, "daemon.token"), 0o600);

    const first = await migrateLegacyUiState({
      isLegacyDaemonAlive: neverLegacyDaemonAlive,
      log: () => {},
    });
    expect(first.kind).toBe("migrated");

    const second = await migrateLegacyUiState({
      isLegacyDaemonAlive: neverLegacyDaemonAlive,
      log: () => {},
    });
    expect(second).toEqual({ kind: "skipped-new-exists" });
  });

  // 7. EXDEV fallback exercises copy+chmod+unlink.
  test("falls back to copy+chmod+unlink on EXDEV", async () => {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "daemon.json"),
      JSON.stringify({ port: 3939 }),
    );
    await writeFile(path.join(legacyDir, "daemon.token"), "tok");
    await chmod(path.join(legacyDir, "daemon.token"), 0o600);

    let renameCalls = 0;
    const result = await migrateLegacyUiState({
      isLegacyDaemonAlive: neverLegacyDaemonAlive,
      log: () => {},
      rename: async () => {
        renameCalls++;
        const err = new Error("cross-device link not permitted") as Error & {
          code: string;
        };
        err.code = "EXDEV";
        throw err;
      },
      // copyFile / chmod / unlink fall back to real fs.
    });

    expect(result.kind).toBe("migrated");
    expect(renameCalls).toBeGreaterThanOrEqual(2);
    if (result.kind === "migrated") {
      expect(result.movedFiles.sort()).toEqual(["daemon.json", "daemon.token"]);
    }
    const tokenStat = await stat(path.join(newDir, "daemon.token"));
    expect(tokenStat.mode & 0o777).toBe(0o600);
    expect(await fileExists(path.join(legacyDir, "daemon.json"))).toBe(false);
    expect(await fileExists(path.join(legacyDir, "daemon.token"))).toBe(false);
  });

  // 8. legacy daemon still listening -> throw.
  test("throws when legacy daemon is still running", async () => {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "daemon.json"),
      JSON.stringify({ port: 3939 }),
    );

    let err: Error | null = null;
    try {
      await migrateLegacyUiState({
        isLegacyDaemonAlive: () => Promise.resolve(true),
        log: () => {},
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(
      err?.message.startsWith("legacy UI daemon is still running on port"),
    ).toBe(true);
    expect(err?.message).toContain("run `nas ui stop` first");
    // Files remain in place.
    expect(await fileExists(path.join(legacyDir, "daemon.json"))).toBe(true);
    // The throw must precede `mkdir(newDir, ...)`, so the destination
    // directory must not have been created.
    expect(await fileExists(newDir)).toBe(false);
  });

  // 9. token migration partial failure rolls back token and short-circuits.
  test("rolls back token and short-circuits when copyFile fails for token", async () => {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "daemon.json"),
      JSON.stringify({ port: 3939 }),
    );
    await writeFile(path.join(legacyDir, "daemon.token"), "tok");
    await chmod(path.join(legacyDir, "daemon.token"), 0o600);
    await writeFile(path.join(legacyDir, "daemon.log"), "log");

    const warnings: string[] = [];
    const result = await migrateLegacyUiState({
      isLegacyDaemonAlive: neverLegacyDaemonAlive,
      log: (msg) => warnings.push(msg),
      rename: () => {
        // Force EXDEV path to trigger copyFile fallback for every file.
        const err = new Error("cross-device") as Error & { code: string };
        err.code = "EXDEV";
        return Promise.reject(err);
      },
      copyFile: async (
        src: string,
        dest: string,
        mode?: number,
      ): Promise<void> => {
        if (path.basename(src) === "daemon.token") {
          throw new Error("simulated copy failure");
        }
        // delegate to real fs.copyFile for non-token files
        const fs = await import("node:fs/promises");
        await fs.copyFile(src, dest, mode);
      },
    });

    expect(result).toEqual({ kind: "skipped-token-failure" });
    // Token must not be left in the new dir.
    expect(await fileExists(path.join(newDir, "daemon.token"))).toBe(false);
    // daemon.log must not have been migrated (early return after token fail).
    expect(await fileExists(path.join(newDir, "daemon.log"))).toBe(false);
    expect(warnings.some((w) => w.includes("regenerate"))).toBe(true);
  });
});
