import { chmod, readFile, unlink } from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import {
  closeServer,
  listen,
  openSocket,
  pipeSockets,
  readFrame,
  splitUpgradeBody,
  TIMEOUT,
  trackServer,
  writeFrame,
} from "./dind-bridge-protocol.mjs";

function dockerEndpoint(host) {
  const url = new URL(host);
  if (
    url.protocol !== "tcp:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "DinD bridge requires a fixed tcp://127.0.0.1:PORT Docker endpoint",
    );
  }
  return { host: "127.0.0.1", port: Number(url.port) };
}

function dockerJson(endpoint, path) {
  return new Promise((resolve, reject) => {
    const req = request(
      { ...endpoint, path, method: "GET", agent: false },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024)
            res.destroy(new Error("Docker metadata exceeds limit"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) {
            const error = new Error(
              `Docker metadata ${path}: HTTP ${res.statusCode}`,
            );
            error.statusCode = res.statusCode;
            return reject(error);
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(TIMEOUT, () =>
      req.destroy(new Error("Docker metadata timed out")),
    );
    req.on("error", reject);
    req.end();
  });
}

function validId(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

async function containerMappings(
  endpoint,
  id,
  { skipUnsupported = false } = {},
) {
  if (!validId(id)) throw new Error("invalid container identity");
  let info;
  try {
    info = await dockerJson(endpoint, `/containers/${id}/json`);
  } catch (error) {
    // A container can disappear between list and inspect during ordinary
    // parallel teardown. Other metadata failures must still fail closed.
    if (error.statusCode === 404) return [];
    throw error;
  }
  if (info.Id !== id || !info.State?.Running) return [];
  if (
    info.HostConfig?.NetworkMode === "host" ||
    info.HostConfig?.NetworkMode?.startsWith("container:")
  )
    return [];
  return Object.entries(info.NetworkSettings?.Ports ?? {}).flatMap(
    ([key, bindings]) => {
      if (!bindings?.length) return [];
      const [portText, protocol] = key.split("/");
      if (protocol !== "tcp") return [];
      const targetPort = Number(portText);
      if (!validPort(targetPort)) throw new Error("invalid Docker TCP port");
      const ipv4 = bindings.filter(
        (binding) =>
          binding.HostIp === "0.0.0.0" ||
          binding.HostIp === "127.0.0.1" ||
          binding.HostIp === "",
      );
      if (!ipv4.length) {
        if (skipUnsupported) return [];
        throw new Error(
          `unsupported published address for ${id.slice(0, 12)}:${key}; IPv4 loopback is required`,
        );
      }
      return ipv4.map((binding) => {
        const port = Number(binding.HostPort);
        if (!validPort(port)) throw new Error("invalid published Docker port");
        return { id, port, targetPort, started: info.State.StartedAt };
      });
    },
  );
}

export async function listenerSnapshot() {
  const result = [];
  for (const family of ["tcp", "tcp6"]) {
    let data;
    try {
      data = await readFile(`/proc/net/${family}`, "utf8");
    } catch (error) {
      if (family === "tcp6" && error.code === "ENOENT") continue;
      throw error;
    }
    for (const line of data.trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== "0A") continue;
      const [address, hexPort] = fields[1].split(":");
      const inode = fields[9];
      if (!inode || inode === "0")
        throw new Error("cannot identify Docker published listener");
      result.push({
        family,
        address,
        port: Number.parseInt(hexPort, 16),
        inode,
      });
    }
  }
  return result;
}

function publishedListener(snapshot, port) {
  const ipv4 = snapshot.filter(
    (entry) =>
      entry.port === port &&
      entry.family === "tcp" &&
      (entry.address === "00000000" || entry.address === "0100007F"),
  );
  const candidates = ipv4.length
    ? ipv4
    : snapshot.filter(
        (entry) =>
          entry.port === port &&
          entry.family === "tcp6" &&
          entry.address === "00000000000000000000000000000000",
      );
  if (candidates.length !== 1)
    throw new Error(
      `published TCP port ${port} has no unique loopback listener`,
    );
  return candidates[0].inode;
}

async function allMappings(endpoint) {
  const containers = await dockerJson(endpoint, "/containers/json");
  if (!Array.isArray(containers) || containers.length > 4096)
    throw new Error("invalid Docker container list");
  const mappings = [];
  // Serial enumeration bounds API fan-out and response memory. One
  // container's unforwardable port must not fail the listing for every
  // namespace, so leave such ports out rather than throwing.
  for (const container of containers)
    mappings.push(
      ...(await containerMappings(endpoint, container.Id, {
        skipUnsupported: true,
      })),
    );
  const seen = new Map();
  const ambiguous = new Set();
  for (const mapping of mappings) {
    const previous = seen.get(mapping.port);
    if (previous && JSON.stringify(previous) !== JSON.stringify(mapping))
      ambiguous.add(mapping.port);
    seen.set(mapping.port, mapping);
  }
  for (const port of ambiguous) seen.delete(port);
  return [...seen.values()];
}

export async function startGateway({
  socketPath,
  dockerHost,
  readListeners = listenerSnapshot,
}) {
  const endpoint = dockerEndpoint(dockerHost);
  const sockets = new Set();
  const authorized = new Map();
  const starting = new Set();
  let generation = 0;
  const key = (mapping) => `${mapping.id}:${mapping.port}`;
  const checkMapping = async (mapping) => {
    const name = key(mapping);
    const pinned = authorized.get(name);
    const observedGeneration = generation;
    const identity = JSON.stringify(mapping);
    const snapshot = await readListeners();
    // The metadata may predate a restart, or a new grant may have arrived
    // during the listener read. Neither observation can revoke that new grant.
    if (observedGeneration !== generation || authorized.get(name) !== pinned)
      throw new Error("Docker mapping changed during validation");
    let inode;
    let listenerError;
    try {
      inode = publishedListener(snapshot, mapping.port);
    } catch (error) {
      listenerError = error;
    }
    if (!pinned || pinned.identity !== identity || pinned.inode !== inode) {
      if (pinned?.identity === identity) authorized.delete(name);
      if (listenerError) throw listenerError;
      throw new Error(
        `published TCP port ${mapping.port} is not authorized; start or restart its container through the namespace Docker endpoint`,
      );
    }
    return inode;
  };
  const maps = async () => {
    for (;;) {
      await Promise.all([...starting]);
      const observedGeneration = generation;
      const mappings = await allMappings(endpoint);
      if (observedGeneration !== generation || starting.size !== 0) continue;
      const snapshot = await readListeners();
      if (observedGeneration !== generation || starting.size !== 0) continue;
      // Everything below is synchronous: a start cannot install a grant
      // between snapshot validation and pruning. In particular, an old poll
      // must never delete a newly started container's grant before retrying.
      const live = new Set(mappings.map(key));
      for (const name of authorized.keys())
        if (!live.has(name)) authorized.delete(name);
      const permitted = [];
      for (const mapping of mappings) {
        const name = key(mapping);
        const pinned = authorized.get(name);
        let inode;
        try {
          inode = publishedListener(snapshot, mapping.port);
        } catch {}
        if (
          pinned &&
          pinned.identity === JSON.stringify(mapping) &&
          pinned.inode === inode
        )
          permitted.push(mapping);
        else authorized.delete(name);
      }
      return permitted;
    }
  };
  const api = createHttpServer((req, res) => {
    void (async () => {
      const match =
        /^\/(?:v[0-9.]+\/)?containers\/([^/?]+)\/(start|restart)(?:\?|$)/.exec(
          req.url,
        );
      let finishStart;
      if (req.method === "POST" && match) {
        generation++;
        const pending = new Promise((resolve) => {
          finishStart = () => {
            starting.delete(pending);
            resolve();
          };
        });
        starting.add(pending);
      }
      let before;
      try {
        before = finishStart
          ? new Set((await readListeners()).map((entry) => entry.inode))
          : undefined;
      } catch (error) {
        finishStart?.();
        throw error;
      }
      const forward = request(
        {
          ...endpoint,
          method: req.method,
          path: req.url,
          headers: req.headers,
          agent: false,
        },
        (response) => {
          response.on("error", () => {
            finishStart?.();
            res.destroy();
          });
          response.pause();
          void (async () => {
            if (
              before &&
              response.statusCode >= 200 &&
              response.statusCode < 300
            ) {
              const info = await dockerJson(
                endpoint,
                `/containers/${match[1]}/json`,
              );
              const mappings = await containerMappings(endpoint, info.Id);
              const after = await readListeners();
              for (const mapping of mappings) {
                const inode = publishedListener(after, mapping.port);
                if (mapping.port === endpoint.port || before.has(inode)) {
                  authorized.delete(key(mapping));
                  throw new Error(
                    `Docker start did not create a new TCP listener for port ${mapping.port}`,
                  );
                }
                authorized.set(key(mapping), {
                  identity: JSON.stringify(mapping),
                  inode,
                });
              }
            }
            const inspect =
              req.method === "GET" &&
              /^\/(?:v[0-9.]+\/)?containers\/([^/?]+)\/json(?:\?|$)/.exec(
                req.url,
              );
            if (inspect && response.statusCode === 200) {
              await Promise.all([...starting]);
              const info = await dockerJson(
                endpoint,
                `/containers/${inspect[1]}/json`,
              );
              for (const mapping of await containerMappings(endpoint, info.Id))
                await checkMapping(mapping);
            }
            finishStart?.();
            res.writeHead(response.statusCode, response.rawHeaders);
            // Docker flushes headers before a long-poll body (container
            // wait); the CLI waits for them before starting the container.
            res.flushHeaders();
            response.pipe(res);
            response.resume();
          })().catch((error) => {
            finishStart?.();
            response.destroy();
            if (!res.headersSent) {
              res.writeHead(502);
              res.end(`nas DinD bridge: ${error.message}\n`);
            } else res.destroy();
          });
        },
      );
      forward.on("error", (error) => {
        finishStart?.();
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(error.message);
        } else res.destroy();
      });
      res.on("close", () => {
        if (!res.writableFinished) forward.destroy();
      });
      req.on("aborted", () => {
        finishStart?.();
        forward.destroy();
      });
      req.pipe(forward);
    })().catch((error) => {
      res.writeHead(502);
      res.end(error.message);
    });
  });
  api.on(
    "upgrade",
    (req, client, head) =>
      void splitUpgradeBody(req, client, head).then(
        (parts) => upgrade(req, client, parts),
        () => client.destroy(),
      ),
  );
  const upgrade = (req, client, { body, rest }) => {
    const forward = request({
      ...endpoint,
      method: req.method,
      path: req.url,
      headers: req.headers,
      agent: false,
    });
    forward.on("upgrade", (res, target, responseHead) => {
      client.write(
        `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n${res.rawHeaders.reduce((text, value, index) => text + value + (index % 2 ? "\r\n" : ": "), "")}\r\n`,
      );
      if (responseHead.length) client.write(responseHead);
      if (rest.length) target.write(rest);
      sockets.add(target);
      target.once("close", () => sockets.delete(target));
      pipeSockets(client, target);
    });
    forward.on("response", (res) => {
      client.write(
        `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n${res.rawHeaders.reduce((text, value, index) => text + value + (index % 2 ? "\r\n" : ": "), "")}\r\n`,
      );
      res.pipe(client);
      client.pipe(forward.socket);
      if (rest.length) forward.socket.write(rest);
    });
    forward.on("error", () => client.destroy());
    client.on("close", () => forward.destroy());
    forward.end(body);
  };
  api.on("clientError", (_error, client) => client.destroy());
  const apiPath = `${socketPath}.api`;
  trackServer(api, sockets);
  const server = createServer({ allowHalfOpen: true }, (client) => {
    void (async () => {
      let target;
      try {
        const frame = await readFrame(client, 8192);
        if (frame.kind === "api") {
          target = await openSocket({ path: apiPath });
        } else if (frame.kind === "maps") {
          writeFrame(client, { ok: true, mappings: await maps() });
          client.end();
          return;
        } else if (frame.kind === "connect") {
          if (!validPort(frame.port)) throw new Error("invalid published port");
          const mapping = (await containerMappings(endpoint, frame.id)).find(
            (entry) => entry.port === frame.port,
          );
          if (!mapping)
            throw new Error(
              "TCP target is not currently published by this DinD",
            );
          const inode = await checkMapping(mapping);
          target = await openSocket({ host: "127.0.0.1", port: mapping.port });
          const current = (await containerMappings(endpoint, frame.id)).find(
            (entry) => entry.port === frame.port,
          );
          if (
            JSON.stringify(mapping) !== JSON.stringify(current) ||
            inode !== (await checkMapping(current))
          )
            throw new Error("Docker mapping changed during connection");
        } else throw new Error("unknown bridge operation");
        sockets.add(target);
        target.once("close", () => sockets.delete(target));
        if (client.destroyed) {
          target.destroy();
          return;
        }
        writeFrame(client, { ok: true });
        pipeSockets(client, target);
      } catch (error) {
        target?.destroy();
        if (!client.destroyed) {
          writeFrame(client, { ok: false, error: error.message });
          client.end();
          const timer = setTimeout(() => client.destroy(), 1000);
          timer.unref();
        }
      }
    })();
  });
  trackServer(server, sockets);
  let apiListening = false;
  let controlListening = false;
  try {
    await listen(api, apiPath);
    apiListening = true;
    await chmod(apiPath, 0o600);
    await listen(server, socketPath);
    controlListening = true;
    await chmod(socketPath, 0o600);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (apiListening) {
      await closeServer(api);
      await unlink(apiPath).catch(() => {});
    }
    if (controlListening) {
      await closeServer(server);
      await unlink(socketPath).catch(() => {});
    }
    throw error;
  }
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await closeServer(api);
      await unlink(socketPath).catch(() => {});
      await unlink(apiPath).catch(() => {});
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  const opts = {};
  while (args.length && args[0] !== "--") {
    const key = args.shift();
    if (!key?.startsWith("--") || !args.length)
      throw new Error("invalid DinD bridge arguments");
    opts[key.slice(2)] = args.shift();
  }
  if (!opts.socket) throw new Error("--socket is required");
  if (mode === "serve") {
    const gateway = await startGateway({
      socketPath: opts.socket,
      dockerHost: opts["docker-host"],
    });
    const stop = async () => {
      await gateway.close();
      process.exit(0);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    process.stdout.write("ready\n");
  } else if (mode === "run") {
    if (
      args.shift() !== "--" ||
      !args.length ||
      !opts["base-netns"] ||
      !opts.argv0
    )
      throw new Error("run requires --base-netns, --argv0 and -- COMMAND");
    const { runCommand } = await import("./dind-bridge-runtime.mjs");
    await runCommand({
      socketPath: opts.socket,
      baseNetns: opts["base-netns"],
      argv0: opts.argv0,
      fds: (opts.fds ?? "")
        .split(",")
        .filter(Boolean)
        .map((fd) => {
          if (!/^[0-9]+$/.test(fd)) throw new Error("invalid --fds");
          return Number(fd);
        }),
      command: args,
    });
  } else throw new Error("expected serve or run");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`nas DinD bridge: ${error.message}`);
    process.exitCode = 125;
  });
}
