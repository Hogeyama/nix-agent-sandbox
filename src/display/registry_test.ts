import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathExists } from "../lib/fs_utils.ts";
import {
  type DisplayRegistryEntry,
  gcDisplayRuntime,
  listDisplayRegistries,
  readDisplayRegistry,
  removeDisplayRegistry,
  resolveDisplayRuntimePaths,
  writeDisplayRegistry,
} from "./registry.ts";

async function makeTmpPaths() {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-display-registry-"));
  return await resolveDisplayRuntimePaths(dir);
}

function entryFor(
  sessionId: string,
  overrides: Partial<DisplayRegistryEntry> = {},
): DisplayRegistryEntry {
  return {
    sessionId,
    xpraServerPid: 1,
    attachPid: 0,
    sessionDir: `/tmp/nas-test/${sessionId}`,
    displayNumber: 100,
    socketPath: `/tmp/.X11-unix/X100`,
    createdAt: "2026-04-18T00:00:00.000Z",
    ...overrides,
  };
}

test("resolveDisplayRuntimePaths: creates runtime + sessions dirs", async () => {
  const paths = await makeTmpPaths();
  expect(await pathExists(paths.runtimeDir)).toBe(true);
  expect(await pathExists(paths.sessionsDir)).toBe(true);
});

test("writeDisplayRegistry / readDisplayRegistry round-trips", async () => {
  const paths = await makeTmpPaths();
  const entry = entryFor("sess_abc");
  await writeDisplayRegistry(paths, entry);
  const got = await readDisplayRegistry(paths, "sess_abc");
  expect(got).toEqual(entry);
});

test("readDisplayRegistry returns null when missing", async () => {
  const paths = await makeTmpPaths();
  expect(await readDisplayRegistry(paths, "nope")).toBeNull();
});

test("listDisplayRegistries returns all entries", async () => {
  const paths = await makeTmpPaths();
  await writeDisplayRegistry(paths, entryFor("a"));
  await writeDisplayRegistry(paths, entryFor("b"));
  const all = await listDisplayRegistries(paths);
  expect(all.map((e) => e.sessionId).sort()).toEqual(["a", "b"]);
});

test("removeDisplayRegistry deletes the entry", async () => {
  const paths = await makeTmpPaths();
  await writeDisplayRegistry(paths, entryFor("a"));
  await removeDisplayRegistry(paths, "a");
  expect(await readDisplayRegistry(paths, "a")).toBeNull();
});

test("gcDisplayRuntime: keeps entries whose xpra server is alive", async () => {
  const paths = await makeTmpPaths();
  // Current pid is always alive.
  await writeDisplayRegistry(
    paths,
    entryFor("live", { xpraServerPid: process.pid }),
  );
  const result = await gcDisplayRuntime(paths);
  expect(result.removedSessions).toEqual([]);
  expect(await readDisplayRegistry(paths, "live")).not.toBeNull();
});

test("gcDisplayRuntime: removes entries whose xpra server is dead", async () => {
  const paths = await makeTmpPaths();
  // PID 1 on a typical host is init, but we need a pid that `kill -0` reports
  // as dead. Use a clearly-invalid sentinel: isPidAlive guards pid <= 0.
  const sessionDir = path.join(paths.runtimeDir, "dead");
  await writeFile(sessionDir, "marker"); // just to confirm rm happens
  await writeDisplayRegistry(
    paths,
    entryFor("dead", {
      xpraServerPid: 0,
      sessionDir,
      socketPath: path.join(paths.runtimeDir, "X999.sock"),
    }),
  );
  await writeFile(path.join(paths.runtimeDir, "X999.sock"), "");

  const result = await gcDisplayRuntime(paths);
  expect(result.removedSessions).toEqual(["dead"]);
  expect(result.removedSessionDirs).toEqual([sessionDir]);
  expect(await readDisplayRegistry(paths, "dead")).toBeNull();
  expect(await pathExists(sessionDir)).toBe(false);
  expect(await pathExists(path.join(paths.runtimeDir, "X999.sock"))).toBe(
    false,
  );
});

test("gcDisplayRuntime: mixes live and dead entries", async () => {
  const paths = await makeTmpPaths();
  await writeDisplayRegistry(
    paths,
    entryFor("live", { xpraServerPid: process.pid }),
  );
  await writeDisplayRegistry(paths, entryFor("dead", { xpraServerPid: 0 }));
  const result = await gcDisplayRuntime(paths);
  expect(result.removedSessions).toEqual(["dead"]);
  const remaining = (await listDisplayRegistries(paths)).map(
    (e) => e.sessionId,
  );
  expect(remaining).toEqual(["live"]);
});

test("gcDisplayRuntime: skips unreadable JSON files gracefully", async () => {
  const paths = await makeTmpPaths();
  await writeFile(path.join(paths.sessionsDir, "garbage.json"), "not json");
  // Should not throw; readJsonDir returns nothing for the bad file.
  const result = await gcDisplayRuntime(paths);
  expect(result.removedSessions).toEqual([]);
  // Bad JSON file stays — we don't know what it is.
  expect(await pathExists(path.join(paths.sessionsDir, "garbage.json"))).toBe(
    true,
  );
});

test("writeDisplayRegistry uses JSON", async () => {
  const paths = await makeTmpPaths();
  await writeDisplayRegistry(paths, entryFor("json-check"));
  const raw = await readFile(
    path.join(paths.sessionsDir, "json-check.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw);
  expect(parsed.sessionId).toEqual("json-check");
});

test("sessionRegistryPath rejects traversal", async () => {
  const paths = await makeTmpPaths();
  await expect(
    writeDisplayRegistry(paths, entryFor("../escape")),
  ).rejects.toThrow(/path traversal/);
});
