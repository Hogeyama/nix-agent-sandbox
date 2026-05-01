import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  _closeHistoryDb,
  HistoryDbVersionMismatchError,
  openHistoryDb,
  resolveHistoryDbPath,
  resolveHistoryDir,
} from "./store.ts";

test("resolveHistoryDir: uses XDG_DATA_HOME when set", () => {
  const originalXdg = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = "/tmp/custom-data";
    expect(resolveHistoryDir()).toEqual("/tmp/custom-data/nas");
    expect(resolveHistoryDbPath()).toEqual("/tmp/custom-data/nas/history.db");
  } finally {
    if (originalXdg !== undefined) {
      process.env.XDG_DATA_HOME = originalXdg;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
  }
});

test("resolveHistoryDir: falls back to HOME/.local/share when XDG_DATA_HOME is unset", () => {
  const originalXdg = process.env.XDG_DATA_HOME;
  const originalHome = process.env.HOME;
  try {
    delete process.env.XDG_DATA_HOME;
    process.env.HOME = "/tmp/fakehome";
    expect(resolveHistoryDir()).toEqual("/tmp/fakehome/.local/share/nas");
    expect(resolveHistoryDbPath()).toEqual(
      "/tmp/fakehome/.local/share/nas/history.db",
    );
  } finally {
    if (originalXdg !== undefined) {
      process.env.XDG_DATA_HOME = originalXdg;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  }
});

test("resolveHistoryDir: throws when neither XDG_DATA_HOME nor HOME is set", () => {
  const originalXdg = process.env.XDG_DATA_HOME;
  const originalHome = process.env.HOME;
  try {
    delete process.env.XDG_DATA_HOME;
    delete process.env.HOME;
    expect(() => resolveHistoryDir()).toThrow(
      "Cannot resolve history directory",
    );
  } finally {
    if (originalXdg !== undefined) {
      process.env.XDG_DATA_HOME = originalXdg;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  }
});

test("openHistoryDb: readwrite and readonly handles for the same path are independent cache entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-history-"));
  const dbPath = path.join(dir, "history.db");
  try {
    const writer1 = openHistoryDb({ path: dbPath, mode: "readwrite" });
    const writer2 = openHistoryDb({ path: dbPath, mode: "readwrite" });
    // Same mode reuses the cached handle.
    expect(writer1).toBe(writer2);

    const reader1 = openHistoryDb({ path: dbPath, mode: "readonly" });
    const reader2 = openHistoryDb({ path: dbPath, mode: "readonly" });
    expect(reader1).toBe(reader2);

    // Different mode keys yield distinct handles.
    expect(writer1).not.toBe(reader1);
  } finally {
    _closeHistoryDb(dbPath);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HistoryDbVersionMismatchError carries actual version", () => {
  const err = new HistoryDbVersionMismatchError("/tmp/x.db", 7);
  expect(err).toBeInstanceOf(Error);
  expect(err).toBeInstanceOf(HistoryDbVersionMismatchError);
  expect(err.actual).toEqual(7);
  expect(err.name).toEqual("HistoryDbVersionMismatchError");
  expect(err.message).toContain("/tmp/x.db");
  expect(err.message).toContain("7");
});
