import { appendFile, chmod, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import {
  closeServer,
  listen,
  loopbackEndpoint,
  openSocket,
  PUBLISH_HOST,
  pipeSockets,
  readFrame,
  trackServer,
  writeFrame,
} from "./dind-bridge-protocol.mjs";

function dockerEndpoint(host) {
  if (typeof host === "string" && host.startsWith("unix://")) {
    const path = host.slice("unix://".length);
    if (!path.startsWith("/") || path.includes("\0"))
      throw new Error("Docker endpoint must be unix:///ABSOLUTE/PATH");
    return { path };
  }
  return loopbackEndpoint(host, "Docker endpoint");
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
 * tracked to prove where a port came from. Outside nas, `publishHost` is the
 * DinD sidecar's hostname, which must listen on nothing but published ports.
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

const RELAY_OPTIONS = [
  "socket",
  "instance",
  "publish-ip",
  "api",
  "name-prefix",
];
const MODES = {
  serve: {
    required: ["socket", "docker-host"],
    allowed: ["socket", "docker-host", "publish-host", "publish-ip", "api"],
  },
  relay: { required: ["socket", "instance"], allowed: RELAY_OPTIONS },
  ensure: { required: ["socket", "instance"], allowed: RELAY_OPTIONS },
};

/** Parse `--key value` pairs for a mode, rejecting anything it does not take. */
export function parseOptions(mode, args, defaults = {}) {
  const spec = MODES[mode];
  if (!spec) throw new Error("expected serve, relay or ensure");
  const opts = {};
  const rest = [...args];
  while (rest.length) {
    const key = rest.shift();
    if (!key?.startsWith("--") || !rest.length)
      throw new Error("invalid DinD bridge arguments");
    const name = key.slice(2);
    if (!spec.allowed.includes(name))
      throw new Error(`unknown option ${key} for ${mode}`);
    if (Object.hasOwn(opts, name)) throw new Error(`${key} given twice`);
    opts[name] = rest.shift();
  }
  for (const name of spec.allowed)
    if (!Object.hasOwn(opts, name) && Object.hasOwn(defaults, name))
      opts[name] = defaults[name];
  for (const name of spec.required)
    if (!opts[name]) throw new Error(`--${name} is required`);
  return opts;
}

/** The relay options shared by relay and ensure, as the runtime takes them. */
function relayOptions(opts) {
  return {
    socketPath: opts.socket,
    instance: opts.instance,
    publishHost: opts["publish-ip"],
    api: opts.api ? loopbackEndpoint(opts.api, "--api") : undefined,
    namePrefix: opts["name-prefix"],
  };
}

/**
 * Run one bridge command. `script` is the file a detached relay is started
 * from; `defaults` fills options the caller did not give.
 */
export async function runCli(
  args,
  { script, defaults = {}, waitForInitialSync = true, beforeFirstRequest },
) {
  const [mode, ...rest] = args;
  const opts = parseOptions(mode, rest, defaults);
  if (mode === "serve") {
    const publishHost = opts["publish-host"] ?? PUBLISH_HOST;
    const api = opts.api ? loopbackEndpoint(opts.api, "--api") : undefined;
    const gateway = await startGateway({
      socketPath: opts.socket,
      dockerHost: opts["docker-host"],
      publishHost,
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
        api,
        waitForInitialSync,
        beforeFirstRequest,
        publishHost: opts["publish-ip"] ?? publishHost,
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
    return;
  }
  const runtime = await import("./dind-bridge-runtime.mjs");
  const options = {
    ...relayOptions(opts),
    waitForInitialSync,
    beforeFirstRequest,
  };
  if (mode === "relay") {
    await (await runtime.runRelay(options)).stopped;
    process.exit(0);
  }
  const passed = ["publish-ip", "api", "name-prefix"].flatMap((name) =>
    opts[name] === undefined ? [] : [`--${name}`, opts[name]],
  );
  process.stdout.write(
    `${await runtime.ensureRelay({ ...options, script, relayArgs: passed })}\n`,
  );
}
