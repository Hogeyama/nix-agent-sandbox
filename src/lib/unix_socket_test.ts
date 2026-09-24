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

const LIMIT = 64 * 1024;

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
      const line = await readJsonLine(client, LIMIT);
      expect(line).toEqual('{"hello":"world"}');
      client.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("readJsonLine: rejects when raw bytes before the newline exceed the limit", async () => {
  await withSocket(async (socketPath) => {
    const requestContent = "é";
    const server = await createUnixServer(socketPath, (socket) => {
      socket.end(`${requestContent}\n`);
    });
    try {
      const client = await connectUnix(socketPath);
      const error = await readJsonLine(client, 1).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("JSON line exceeds byte limit");
      expect((error as Error).message).not.toContain(requestContent);
      client.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("readJsonLine: accepts an exact byte limit and ignores data after the newline", async () => {
  await withSocket(async (socketPath) => {
    const server = await createUnixServer(socketPath, (socket) => {
      socket.end("é\nignored after newline");
    });
    try {
      const client = await connectUnix(socketPath);
      expect(await readJsonLine(client, 2)).toBe("é");
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
      const line = await readJsonLine(client, LIMIT);
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
      expect(await readJsonLine(client, LIMIT)).toEqual(null);
      client.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("writeJsonLine → readJsonLine: round trip for arbitrary JSON", async () => {
  await withSocket(async (socketPath) => {
    const server = await createUnixServer(socketPath, async (socket) => {
      const line = await readJsonLine(socket, LIMIT);
      if (line !== null) {
        // Echo back the parsed value.
        await writeJsonLine(socket, JSON.parse(line));
      }
      socket.end();
    });
    try {
      const client = await connectUnix(socketPath);
      await writeJsonLine(client, { ok: true, n: 42, list: ["a", "b"] });
      const echoed = await readJsonLine(client, LIMIT);
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

test("readJsonLine: decodes a multi-byte character split across reads", async () => {
  await withSocket(async (socketPath) => {
    const bytes = Buffer.from('{"v":"é"}\n', "utf8");
    // Split inside the two-byte "é" so a per-chunk decode would corrupt it.
    const split = bytes.indexOf(0xc3) + 1;
    const server = await createUnixServer(socketPath, async (socket) => {
      socket.write(bytes.subarray(0, split));
      await Bun.sleep(20);
      socket.end(bytes.subarray(split));
    });
    try {
      const client = await connectUnix(socketPath);
      expect(await readJsonLine(client, LIMIT)).toBe('{"v":"é"}');
      client.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * A server shaped like the brokers: one bounded line per connection, answer,
 * close. Overflow rejects the read and the handler destroys the socket.
 */
async function withEchoServer<T>(
  fn: (socketPath: string, rejected: () => number) => Promise<T>,
): Promise<T> {
  return await withSocket(async (socketPath) => {
    let rejectedCount = 0;
    const server = await createUnixServer(socketPath, async (socket) => {
      socket.on("error", () => {});
      try {
        const line = await readJsonLine(socket, LIMIT);
        if (line !== null) await writeJsonLine(socket, { length: line.length });
      } catch {
        rejectedCount++;
      } finally {
        socket.destroy();
      }
    });
    try {
      return await fn(socketPath, () => rejectedCount);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

async function sendRaw(socketPath: string, payload: Buffer): Promise<string> {
  const client = await connectUnix(socketPath);
  client.on("error", () => {});
  try {
    const response = readJsonLine(client, LIMIT).catch(() => null);
    client.write(payload);
    return (await response) ?? "";
  } finally {
    client.destroy();
  }
}

test("readJsonLine: a line that never ends is cut off at the limit and the server keeps serving", async () => {
  await withEchoServer(async (socketPath, rejected) => {
    const client = await connectUnix(socketPath);
    client.on("error", () => {});
    let open = true;
    const closed = new Promise<void>((resolve) =>
      client.once("close", () => {
        open = false;
        resolve();
      }),
    );
    // Keep writing without a newline: the server must drop the connection
    // rather than buffer everything the peer sends.
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    const ceiling = LIMIT * 64;
    let written = 0;
    while (open && written < ceiling) {
      client.write(chunk);
      written += chunk.length;
      await Bun.sleep(1);
    }
    await closed;
    expect(written).toBeLessThan(ceiling);
    expect(rejected()).toBe(1);

    // Another connection on the same server is still answered.
    expect(await sendRaw(socketPath, Buffer.from('{"ok":true}\n'))).toBe(
      '{"length":11}',
    );
  });
});

test("readJsonLine: a line of exactly the limit is accepted, one byte more is not", async () => {
  await withEchoServer(async (socketPath, rejected) => {
    const atLimit = Buffer.alloc(LIMIT + 1, 0x61);
    atLimit[LIMIT] = 0x0a;
    expect(await sendRaw(socketPath, atLimit)).toBe(
      JSON.stringify({ length: LIMIT }),
    );
    expect(rejected()).toBe(0);

    const overLimit = Buffer.alloc(LIMIT + 2, 0x61);
    overLimit[LIMIT + 1] = 0x0a;
    expect(await sendRaw(socketPath, overLimit)).toBe("");
    expect(rejected()).toBe(1);
  });
});

test("connectUnix: rejects when the socket does not exist", async () => {
  await withSocket(async (socketPath) => {
    // Do not bind a server — connect should fail with ENOENT.
    await expect(connectUnix(socketPath)).rejects.toThrow();
  });
});
