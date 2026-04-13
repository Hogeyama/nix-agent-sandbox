import { expect, test } from "bun:test";
import { existsSync, promises as fs, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  dtachHasSession,
  dtachListSessions,
  gcDtachRuntime,
  probeDtachSocket,
  socketPathFor,
} from "./client.ts";

async function withUnixServer<T>(
  socketPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    return await fn();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

test("probeDtachSocket returns true for a live unix socket", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "nas-dtach-test-"));
  const socketPath = socketPathFor("sess-live", runtimeDir);
  await fs.mkdir(path.dirname(socketPath), { recursive: true });

  try {
    await withUnixServer(socketPath, async () => {
      expect(await probeDtachSocket(socketPath)).toBe(true);
      expect(await dtachHasSession(socketPath)).toBe(true);
      const sessions = await dtachListSessions(runtimeDir);
      expect(sessions.map((session) => session.name)).toEqual(["sess-live"]);
    });
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("gcDtachRuntime removes stale sockets and keeps live ones", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(tmpdir(), "nas-dtach-test-"));
  const staleSocketPath = socketPathFor("sess-stale", runtimeDir);
  const liveSocketPath = socketPathFor("sess-live", runtimeDir);
  await fs.mkdir(path.dirname(staleSocketPath), { recursive: true });

  try {
    writeFileSync(staleSocketPath, "not-a-socket");

    await withUnixServer(liveSocketPath, async () => {
      const removed = await gcDtachRuntime(runtimeDir);
      expect(removed).toEqual(["sess-stale"]);
      expect(existsSync(staleSocketPath)).toBe(false);

      const sessions = await dtachListSessions(runtimeDir);
      expect(sessions.map((session) => session.name)).toEqual(["sess-live"]);
      expect(await dtachHasSession(staleSocketPath)).toBe(false);
    });
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});
