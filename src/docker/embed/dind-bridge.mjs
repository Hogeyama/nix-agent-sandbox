import { appendFile, chmod, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  closeServer,
  listen,
  openSocket,
  PUBLISH_HOST,
  pipeSockets,
  readFrame,
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

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

/**
 * The gateway lives in the namespace DinD shares with nas and is reached only
 * through Unix sockets. It offers exactly two things:
 *
 * - `${socketPath}.api`: the session's Docker API, byte for byte.
 * - `socketPath`: a TCP connection to `publishHost:<port>`.
 *
 * dockerd publishes container ports on `publishHost`, a loopback address that
 * nothing else in nas listens on, so any port there belongs to a container.
 * Fixing the address is the whole authorization: no request can steer a
 * connection to another loopback service, and no Docker state has to be
 * tracked to prove where a port came from.
 */
export async function startGateway({
  socketPath,
  dockerHost,
  publishHost = PUBLISH_HOST,
}) {
  const endpoint = dockerEndpoint(dockerHost);
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const api = createServer({ allowHalfOpen: true }, (client) => {
    void openSocket(endpoint).then(
      (docker) => {
        track(docker);
        if (client.destroyed) docker.destroy();
        else pipeSockets(client, docker);
      },
      () => client.destroy(),
    );
  });
  trackServer(api, sockets);
  const control = createServer({ allowHalfOpen: true }, (client) => {
    void (async () => {
      let target;
      try {
        const frame = await readFrame(client, 8192);
        if (frame.kind !== "connect" || !validPort(frame.port))
          throw new Error("unknown bridge operation");
        target = await openSocket({ host: publishHost, port: frame.port });
        track(target);
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
          setTimeout(() => client.destroy(), 1000).unref();
        }
      }
    })();
  });
  trackServer(control, sockets);
  const apiPath = `${socketPath}.api`;
  const servers = [];
  try {
    for (const [server, path] of [
      [api, apiPath],
      [control, socketPath],
    ]) {
      await listen(server, path);
      servers.push([server, path]);
      await chmod(path, 0o600);
    }
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    for (const [server, path] of servers) {
      await closeServer(server);
      await unlink(path).catch(() => {});
    }
    throw error;
  }
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      for (const [server, path] of servers) {
        await closeServer(server);
        await unlink(path).catch(() => {});
      }
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  const opts = {};
  while (args.length) {
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
    // The gateway's own namespace gets a relay too, so clients there see the
    // published ports on 127.0.0.1 as with a local daemon, synchronized with
    // start responses like every other namespace.
    const { startRelay } = await import("./dind-bridge-runtime.mjs");
    const directory = dirname(opts.socket);
    let relay;
    try {
      relay = await startRelay({
        socketPath: opts.socket,
        apiPath: `${directory}/docker.sock`,
        onWarning: (error) =>
          void appendFile(
            `${directory}/relay.log`,
            `${new Date().toISOString()} ${error.message}\n`,
          ).catch(() => {}),
      });
    } catch (error) {
      await gateway.close();
      throw error;
    }
    const stop = async () => {
      await relay.close();
      await gateway.close();
      process.exit(0);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    process.stdout.write("ready\n");
  } else if (mode === "relay" || mode === "ensure") {
    if (!opts.instance) throw new Error("--instance is required");
    const runtime = await import("./dind-bridge-runtime.mjs");
    const options = { socketPath: opts.socket, instance: opts.instance };
    if (mode === "relay") {
      await (await runtime.runRelay(options)).stopped;
      process.exit(0);
    } else
      process.stdout.write(
        `${await runtime.ensureRelay({ ...options, script: process.argv[1] })}\n`,
      );
  } else throw new Error("expected serve, relay or ensure");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`nas DinD bridge: ${error.message}`);
    process.exitCode = 1;
  });
}
