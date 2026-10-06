import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readlink, rm } from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import { createServer } from "node:net";
import { constants } from "node:os";
import {
  closeServer,
  gatewayRequest,
  listen,
  pipeSockets,
  readFrame,
  trackServer,
  writeFrame,
} from "./dind-bridge-protocol.mjs";

function rawHeaders(res) {
  let value = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
  for (let i = 0; i < res.rawHeaders.length; i += 2)
    value += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
  return `${value}\r\n`;
}

export async function startRelay({
  socketPath,
  apiPath,
  onFailure = () => {},
  bindHost = "127.0.0.1",
}) {
  const sockets = new Set();
  const listeners = new Map();
  let closed = false;
  let syncing;
  let failed;
  const fail = (error) => {
    if (failed || closed) return;
    failed = error;
    for (const socket of sockets) socket.destroy();
    for (const entry of listeners.values()) {
      entry.server.close();
      for (const socket of entry.sockets) socket.destroy();
    }
    listeners.clear();
    onFailure(error);
  };
  const sync = () => {
    if (failed) return Promise.reject(failed);
    if (syncing) return syncing;
    syncing = (async () => {
      const { socket, response } = await gatewayRequest(socketPath, {
        kind: "maps",
      });
      socket.destroy();
      const desired = new Map(
        response.mappings.map((mapping) => [mapping.port, mapping]),
      );
      for (const [port, entry] of listeners) {
        if (
          JSON.stringify(desired.get(port)) !== JSON.stringify(entry.mapping)
        ) {
          for (const client of entry.sockets) client.destroy();
          await closeServer(entry.server);
          listeners.delete(port);
        }
      }
      for (const [port, mapping] of desired) {
        if (listeners.has(port)) continue;
        const clients = new Set();
        const server = createServer({ allowHalfOpen: true }, (client) => {
          client.pause();
          void gatewayRequest(socketPath, {
            kind: "connect",
            id: mapping.id,
            port,
          }).then(
            ({ socket: upstream }) => {
              clients.add(upstream);
              upstream.once("close", () => clients.delete(upstream));
              if (client.destroyed || closed || failed) {
                upstream.destroy();
                return;
              }
              pipeSockets(client, upstream);
            },
            () => {
              client.destroy();
            },
          );
        });
        trackServer(server, clients);
        try {
          await listen(server, { host: bindHost, port });
        } catch (error) {
          throw new Error(
            `cannot mirror Docker TCP port ${port}: ${error.message}`,
          );
        }
        listeners.set(port, { server, sockets: clients, mapping });
      }
    })()
      .catch((error) => {
        fail(error);
        throw error;
      })
      .finally(() => {
        syncing = undefined;
      });
    return syncing;
  };

  // A response must not join a poll that began before its Docker operation.
  const syncFresh = async () => {
    await syncing;
    await sync();
  };

  const proxy = async (req, response, head) => {
    let upstream;
    let dockerSocket;
    const raw = head !== undefined;
    const report = (error) => {
      upstream?.destroy();
      dockerSocket?.destroy();
      if (raw) response.destroy();
      else if (!response.headersSent && !response.destroyed) {
        response.writeHead(502, {
          "content-type": "text/plain",
          connection: "close",
        });
        response.end(`nas DinD bridge: ${error.message}\n`);
      } else response.destroy();
    };
    try {
      if (response.destroyed || closed || failed) return;
      upstream = request({
        socketPath: `${socketPath}.api`,
        method: req.method,
        path: req.url,
        headers: req.headers,
        agent: false,
      });
      upstream.on("socket", (socket) => {
        dockerSocket = socket;
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      upstream.on("error", report);
      upstream.on("response", (res) => {
        res.pause();
        res.on("error", report);
        void syncFresh().then(() => {
          if (response.destroyed) {
            res.destroy();
            return;
          }
          if (raw) {
            response.write(rawHeaders(res));
            // Docker's legacy attach responds 200 and then hijacks the socket.
            res.pipe(response);
            response.pipe(dockerSocket);
            if (head.length) dockerSocket.write(head);
          } else {
            response.writeHead(res.statusCode, res.rawHeaders);
            res.pipe(response);
          }
          res.resume();
        }, report);
      });
      upstream.on("upgrade", (res, socket, upstreamHead) => {
        socket.pause();
        void syncFresh()
          .then(() => {
            if (!raw) throw new Error("unexpected Docker HTTP upgrade");
            response.write(rawHeaders(res));
            if (upstreamHead.length) response.write(upstreamHead);
            if (head.length) socket.write(head);
            pipeSockets(response, socket);
          })
          .catch(report);
      });
      req.on("aborted", () => upstream.destroy());
      response.on("close", () => {
        if (raw || !response.writableFinished) upstream.destroy();
      });
      if (raw) upstream.end();
      else req.pipe(upstream);
    } catch (error) {
      report(error);
    }
  };
  const server = createHttpServer((req, res) => void proxy(req, res));
  server.on("upgrade", (req, socket, head) => void proxy(req, socket, head));
  server.on("clientError", (_error, socket) => socket.destroy());
  trackServer(server, sockets);
  let timer;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    await syncing?.catch(() => {});
    for (const socket of sockets) socket.destroy();
    for (const entry of listeners.values()) {
      for (const socket of entry.sockets) socket.destroy();
      await closeServer(entry.server);
    }
    listeners.clear();
    await closeServer(server);
    await rm(apiPath, { force: true });
  };
  try {
    await sync();
    await listen(server, apiPath);
    await chmod(apiPath, 0o600);
    timer = setInterval(() => void sync().catch(() => {}), 500);
  } catch (error) {
    await close();
    throw error;
  }
  return { close, sync };
}

async function acquireNamespace(socketPath, namespace) {
  const key = createHash("sha256")
    .update(`${socketPath}\0${namespace}`)
    .digest("hex")
    .slice(0, 24);
  const directory = `/tmp/nas-dind-${process.getuid()}-${key}`;
  const controlPath = `${directory}/control.sock`;
  const apiPath = `${directory}/docker.sock`;
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  let relay;
  let failure;
  const leases = new Set();
  const control = createServer({ allowHalfOpen: true }, (client) => {
    client.on("error", () => {});
    void readFrame(client, 8192)
      .then(async (frame) => {
        if (frame.kind !== "lease" || frame.namespace !== namespace)
          throw new Error("wrong bridge namespace");
        await ready;
        if (failure) throw failure;
        leases.add(client);
        client.once("close", () => {
          leases.delete(client);
          if (ownerDone && leases.size === 0) void closeOwner();
        });
        client.on("end", () => client.destroy());
        writeFrame(client, {
          ok: true,
          namespace,
          apiPath,
          ownerPid: process.pid,
        });
        client.resume();
      })
      .catch((error) => {
        writeFrame(client, { ok: false, error: error.message });
        client.end();
      });
  });
  let owner = false;
  let ownerDone = false;
  let ready;
  let finished;
  let finish;
  const closeOwner = async () => {
    if (!owner || finished) return;
    finished = true;
    for (const lease of leases) lease.destroy();
    await relay?.close();
    await closeServer(control);
    await rm(directory, { recursive: true, force: true });
    finish?.();
  };
  try {
    await listen(control, controlPath);
    owner = true;
    ready = startRelay({
      socketPath,
      apiPath,
      onFailure: (error) => {
        failure = error;
        for (const lease of leases) lease.destroy();
      },
    }).then((value) => {
      relay = value;
    });
    await ready;
  } catch (error) {
    if (owner) {
      await closeOwner();
      throw error;
    }
    if (error.code !== "EADDRINUSE") throw error;
  }
  let lease;
  let ownerPid;
  try {
    const connected = await gatewayRequest(controlPath, {
      kind: "lease",
      namespace,
    });
    lease = connected.socket;
    ownerPid = connected.response.ownerPid;
    if (
      connected.response.namespace !== namespace ||
      connected.response.apiPath !== apiPath
    )
      throw new Error("namespace bridge identity mismatch");
    lease.on("end", () => lease.destroy());
    lease.resume();
  } catch (error) {
    await closeOwner();
    throw new Error(`namespace bridge unavailable: ${error.message}`);
  }
  return {
    apiPath,
    lease,
    owner,
    ownerPid,
    async close() {
      lease.destroy();
      if (!owner) return;
      ownerDone = true;
      if (leases.size === 0) await closeOwner();
      else if (!finished)
        await new Promise((resolve) => {
          finish = resolve;
        });
    },
  };
}

export async function runCommand({ socketPath, baseNetns, argv0, command }) {
  const namespace = await readlink("/proc/self/ns/net");
  const bridge =
    namespace === baseNetns
      ? undefined
      : await acquireNamespace(socketPath, namespace);
  const env = { ...process.env };
  if (bridge) {
    env.DOCKER_HOST = `unix://${bridge.apiPath}`;
    env.TESTCONTAINERS_HOST_OVERRIDE = "127.0.0.1";
    env.NAS_DIND_BRIDGE_NETNS = namespace;
    delete env.DOCKER_TLS_VERIFY;
    delete env.DOCKER_CERT_PATH;
    delete env.DOCKER_CONTEXT;
  }
  const inheritedOwner = () => {
    let pid = process.ppid;
    for (let depth = 0; pid > 1 && depth < 256; depth++) {
      if (pid === bridge?.ownerPid) return true;
      try {
        pid = Number(
          readFileSync(`/proc/${pid}/stat`, "utf8")
            .split(") ")[1]
            .split(" ")[1],
        );
      } catch {
        return false;
      }
    }
    return false;
  };
  if (bridge && !bridge.owner && inheritedOwner()) {
    // The inherited owner's lease keeps the listeners alive. Validate it before
    // replacing ourselves so ordinary nested Bash adds no resident supervisor.
    await bridge.close();
    process.execve(command[0], [argv0, ...command.slice(1)], env);
    throw new Error("execve returned unexpectedly");
  }
  let failed = false;
  let child;
  const ownGroup =
    !process.stdin.isTTY && !process.stdout.isTTY && !process.stderr.isTTY;
  const descendants = new Map();
  const startTime = (pid) => {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8")
        .split(") ")[1]
        .split(" ")[19];
    } catch {
      return undefined;
    }
  };
  const signalChildren = (signal) => {
    if (!child?.pid) return;
    if (ownGroup) {
      try {
        process.kill(-child.pid, signal);
      } catch {}
      return;
    }
    // A TTY child stays in the caller's session so Bash job control continues
    // to work. Signal its process tree without killing the caller's group.
    const visit = (pid) => {
      try {
        for (const value of readFileSync(
          `/proc/${pid}/task/${pid}/children`,
          "utf8",
        )
          .trim()
          .split(/\s+/)) {
          const next = Number(value);
          if (!next) continue;
          descendants.set(next, startTime(next));
          visit(next);
        }
      } catch {}
    };
    visit(child.pid);
    for (const [pid, born] of descendants) {
      if (born && startTime(pid) === born) {
        try {
          process.kill(pid, signal);
        } catch {}
      }
    }
    child.kill(signal);
  };
  const cleanupChildren = async () => {
    signalChildren("SIGTERM");
    if (ownGroup) {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          process.kill(-child.pid, 0);
        } catch {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    signalChildren("SIGKILL");
  };
  let killTimer;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
  const handlers = new Map();
  try {
    child = spawn(command[0], command.slice(1), {
      argv0,
      stdio: "inherit",
      detached: ownGroup,
      env,
    });
    const disconnected = () => {
      failed = true;
      console.error("nas DinD bridge: namespace relay disconnected");
      signalChildren("SIGTERM");
      killTimer = setTimeout(() => signalChildren("SIGKILL"), 2000);
    };
    bridge?.lease.once("close", disconnected);
    for (const signal of signals) {
      const handler = () => {
        signalChildren(signal);
        killTimer ??= setTimeout(() => signalChildren("SIGKILL"), 2000);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(killTimer);
    // Interactive Bash owns its ordinary background-job lifetime. Only our
    // non-TTY process group is subject to normal-exit descendant cleanup.
    if (ownGroup) await cleanupChildren();
    bridge?.lease.off("close", disconnected);
    await bridge?.close();
    for (const [signal, handler] of handlers) process.off(signal, handler);
    handlers.clear();
    if (failed) process.exitCode = 125;
    else if (result.signal) {
      process.exitCode = 128 + constants.signals[result.signal];
      process.kill(process.pid, result.signal);
    } else process.exitCode = result.code ?? 125;
  } finally {
    clearTimeout(killTimer);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await bridge?.close();
  }
}
