import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

export type { Server, Socket } from "node:net";

export function createUnixServer(
  socketPath: string,
  handler: (socket: Socket) => void,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

export function connectUnix(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath }, () => {
      socket.removeListener("error", reject);
      resolve(socket);
    });
    socket.on("error", reject);
  });
}

/**
 * Reads one newline-terminated line, holding at most `maxBytes` raw bytes
 * before the newline. The bound is mandatory: a peer that never sends `\n`
 * would otherwise grow the buffer until the host process runs out of memory.
 * On overflow the promise rejects without echoing any payload; the caller
 * owns the socket and is expected to destroy it.
 *
 * Bytes are accumulated as Buffers and decoded once, so a multi-byte UTF-8
 * character split across two reads is not corrupted.
 */
export async function readJsonLine(
  socket: Socket,
  maxBytes: number,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesBeforeNewline = 0;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      const newlineIndex = chunk.indexOf(0x0a);
      const lineBytes = newlineIndex === -1 ? chunk.length : newlineIndex;
      bytesBeforeNewline += lineBytes;
      if (bytesBeforeNewline > maxBytes) {
        cleanup();
        chunks.length = 0;
        reject(new Error("JSON line exceeds byte limit"));
        return;
      }
      if (newlineIndex === -1) {
        chunks.push(chunk);
        return;
      }
      chunks.push(chunk.subarray(0, newlineIndex));
      cleanup();
      resolve(Buffer.concat(chunks, bytesBeforeNewline).toString("utf8"));
    };
    const onEnd = () => {
      cleanup();
      const trimmed = Buffer.concat(chunks, bytesBeforeNewline)
        .toString("utf8")
        .trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
  });
}

export function writeJsonLine(socket: Socket, data: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${JSON.stringify(data)}\n`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
