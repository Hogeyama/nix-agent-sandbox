import { connect } from "node:net";

export const TIMEOUT = 10_000;
export const MAX_FRAME = 1024 * 1024;

export function readFrame(socket, limit = MAX_FRAME) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(
      () => fail(new Error("bridge handshake timed out")),
      TIMEOUT,
    );
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", data);
      socket.off("error", fail);
      socket.off("end", end);
      socket.off("close", end);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const end = () => fail(new Error("bridge disconnected during handshake"));
    const data = (chunk) => {
      const newline = chunk.indexOf(10);
      const length = newline < 0 ? chunk.length : newline;
      if (buffered.length + length > limit)
        return fail(new Error("bridge frame exceeds limit"));
      buffered = Buffer.concat([buffered, chunk.subarray(0, length)]);
      if (newline < 0) return;
      cleanup();
      socket.pause();
      if (newline + 1 < chunk.length)
        socket.unshift(chunk.subarray(newline + 1));
      try {
        resolve(JSON.parse(buffered.toString()));
      } catch {
        reject(new Error("invalid bridge frame"));
      }
    };
    socket.on("data", data);
    socket.once("error", fail);
    socket.once("end", end);
    socket.once("close", end);
    socket.resume();
  });
}

export function writeFrame(socket, value) {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME)
    throw new Error("bridge frame exceeds limit");
  socket.write(frame);
}

export function openSocket(options) {
  return new Promise((resolve, reject) => {
    const socket = connect({ ...options, allowHalfOpen: true });
    const timer = setTimeout(
      () => socket.destroy(new Error("bridge connection timed out")),
      TIMEOUT,
    );
    socket.once("error", reject);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", reject);
      // Keep asynchronous errors observed while ownership moves to a caller.
      socket.on("error", () => {});
      resolve(socket);
    });
    socket.once("close", () => clearTimeout(timer));
  });
}

export async function gatewayRequest(path, request) {
  const socket = await openSocket({ path });
  try {
    writeFrame(socket, request);
    const response = await readFrame(socket);
    if (!response.ok)
      throw new Error(response.error || "bridge request rejected");
    return { socket, response };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export function pipeSockets(a, b) {
  let timer;
  const ended = new Set();
  const destroy = () => {
    clearTimeout(timer);
    a.destroy();
    b.destroy();
  };
  for (const socket of [a, b]) {
    socket.on("error", destroy);
    socket.on("end", () => {
      ended.add(socket);
      if (ended.size === 2) clearTimeout(timer);
      else timer = setTimeout(destroy, TIMEOUT);
    });
    socket.on("close", () => {
      if (!socket.readableEnded || !socket.writableFinished) destroy();
      if (a.destroyed && b.destroyed) clearTimeout(timer);
    });
  }
  a.pipe(b);
  b.pipe(a);
  a.resume();
  b.resume();
}

export function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export function trackServer(server, sockets) {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
}

export function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
