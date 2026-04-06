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

export async function readJsonLine(socket: Socket): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let text = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      const nl = text.indexOf("\n");
      if (nl !== -1) {
        cleanup();
        resolve(text.slice(0, nl));
      }
    };
    const onEnd = () => {
      cleanup();
      const trimmed = text.trim();
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
    socket.write(JSON.stringify(data) + "\n", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
