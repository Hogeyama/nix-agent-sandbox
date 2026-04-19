/**
 * unix_socket wire-format tests. Exercises the onEnd branch of readJsonLine
 * (partial line, nothing received) which the integration tests don't reach
 * consistently.
 */

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  connectUnix,
  createUnixServer,
  readJsonLine,
  writeJsonLine,
} from "./unix_socket.ts";

async function withSocket<T>(
  fn: (socketPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-socket-"));
  try {
    return await fn(path.join(dir, "s.sock"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readJsonLine: resolves with payload up to the newline", async () => {
  await withSocket(async (socketPath) => {
    const server = await createUnixServer(socketPath, (socket) => {
      socket.write('{"hello":"world"}\nignored after newline');
      socket.end();
    });
    try {
      const client = await connectUnix(socketPath);
      const line = await readJsonLine(client);
      expect(line).toEqual('{"hello":"world"}');
      client.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("readJsonLine: onEnd path — resolves with trimmed text when no newline was sent", async () => {
  await withSocket(async (socketPath) => {
    const server = await createUnixServer(socketPath, (socket) => {
      // Write without newline, then close. onEnd branch.
      socket.write("  partial-no-newline  ");
      socket.end();
    });
    try {
      const client = await connectUnix(socketPath);
      const line = await readJsonLine(client);
      expect(line).toEqual("partial-no-newline");
      client.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("readJsonLine: onEnd path — returns null when peer closed without sending data", async () => {
  await withSocket(async (socketPath) => {
    const server = await createUnixServer(socketPath, (socket) => {
      socket.end();
    });
    try {
      const client = await connectUnix(socketPath);
      expect(await readJsonLine(client)).toEqual(null);
      client.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("writeJsonLine → readJsonLine: round trip for arbitrary JSON", async () => {
  await withSocket(async (socketPath) => {
    const server = await createUnixServer(socketPath, async (socket) => {
      const line = await readJsonLine(socket);
      if (line !== null) {
        // Echo back the parsed value.
        await writeJsonLine(socket, JSON.parse(line));
      }
      socket.end();
    });
    try {
      const client = await connectUnix(socketPath);
      await writeJsonLine(client, { ok: true, n: 42, list: ["a", "b"] });
      const echoed = await readJsonLine(client);
      expect(echoed && JSON.parse(echoed)).toEqual({
        ok: true,
        n: 42,
        list: ["a", "b"],
      });
      client.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("connectUnix: rejects when the socket does not exist", async () => {
  await withSocket(async (socketPath) => {
    // Do not bind a server — connect should fail with ENOENT.
    await expect(connectUnix(socketPath)).rejects.toThrow();
  });
});
