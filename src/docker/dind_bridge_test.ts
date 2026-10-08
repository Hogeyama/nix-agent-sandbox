import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readlink, rm } from "node:fs/promises";
import { createServer as httpServer, request } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { startGateway } = await import(
  join(import.meta.dir, "embed/dind-bridge-gateway.mjs")
);
const {
  closeServer,
  gatewayRequest,
  listen,
  openSocket,
  pipeSockets,
  readFrame,
  splitUpgradeBody,
  trackServer,
} = await import(join(import.meta.dir, "embed/dind-bridge-protocol.mjs"));
const { namespaceAlone, relayPaths, runRelay, startRelay } = await import(
  join(import.meta.dir, "embed/dind-bridge-runtime.mjs")
);

const script = join(import.meta.dir, "embed/dind-bridge.mjs");
// Stand-ins for dockerd's publish address and the namespace's loopback.
const publishHost = "127.0.0.3";
const bindHost = "127.0.0.2";
const id = "a".repeat(64);

function port(server: Server): number {
  return (server.address() as { port: number }).port;
}
async function http(
  path: string,
  url: string,
  body?: Buffer,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: path,
        path: url,
        method: body ? "POST" : "GET",
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
async function tcpHttp(
  port: number,
  url: string,
  body?: Buffer,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: bindHost,
        port,
        path: url,
        method: body ? "POST" : "GET",
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
async function readAll(socket: Socket): Promise<Buffer> {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.resume();
  return new Promise((resolve, reject) => {
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("error", reject);
  });
}
async function freePort(host: string): Promise<number> {
  const reservation = createServer();
  await listen(reservation, { host, port: 0 });
  const value = port(reservation);
  await closeServer(reservation);
  return value;
}

/**
 * A fake dockerd: one container whose start publishes an echo service on
 * `publishHost`, plus endpoints that exercise the API stream itself.
 */
async function fixture(fn: (ctx: any) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "nas-dind-bridge-test-"));
  const sockets = new Set<Socket>();
  const echo = createServer({ allowHalfOpen: true }, (socket) =>
    socket.pipe(socket),
  );
  trackServer(echo, sockets);
  const publishedPort = await freePort(publishHost);
  let running = false;
  let publishIp = publishHost;
  let listStatus = 200;
  const extraPorts: unknown[] = [];
  const docker = httpServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const path = req.url?.replace(/^\/v[0-9.]+/, "");
    if (path === "/containers/json" && listStatus !== 200) {
      res.writeHead(listStatus);
      res.end("{}");
    } else if (path === "/containers/json")
      res.end(
        JSON.stringify([
          {
            Id: id,
            Ports: [
              ...(running
                ? [
                    {
                      IP: publishIp,
                      PrivatePort: 80,
                      PublicPort: publishedPort,
                      Type: "tcp",
                    },
                  ]
                : []),
              ...extraPorts,
            ],
          },
        ]),
      );
    else if (
      path === `/containers/${id}/start` ||
      path === `/containers/${id}/restart`
    ) {
      if (running) await closeServer(echo);
      await listen(echo, { host: publishHost, port: publishedPort });
      running = true;
      res.writeHead(204);
      res.end();
    } else if (path === `/containers/${id}/stop`) {
      running = false;
      await closeServer(echo);
      res.writeHead(204);
      res.end();
    } else if (path === "/echo") req.pipe(res);
    else if (path === "/stream") {
      res.write("first\n");
      setTimeout(() => res.end("last\n"), 30);
    } else if (path === "/long-poll") {
      res.writeHead(200);
      res.flushHeaders();
      setTimeout(() => res.end("done\n"), 2000);
    } else res.end("OK");
  });
  docker.on("upgrade", (req, socket, head) => {
    if (req.url === "/exec-start") {
      // Like Docker, answer only once the whole request body has arrived.
      void splitUpgradeBody(req, socket, head).then(
        ({ body, rest }: { body: Buffer; rest: Buffer }) => {
          socket.write(
            `HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nbody=${body};`,
          );
          if (rest.length) socket.write(rest);
          socket.pipe(socket);
          socket.resume();
        },
      );
      return;
    }
    socket.write(
      req.url === "/legacy"
        ? "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: close\r\n\r\n"
        : "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  trackServer(docker, sockets);
  let gateway: any;
  let relay: any;
  const warnings: Error[] = [];
  try {
    await listen(docker, { host: "127.0.0.1", port: 0 });
    const socketPath = join(dir, "gateway.sock");
    const apiPath = join(dir, "docker.sock");
    gateway = await startGateway({
      socketPath,
      dockerHost: `tcp://127.0.0.1:${port(docker)}`,
      publishHost,
    });
    await fn({
      dir,
      socketPath,
      apiPath,
      publishedPort,
      warnings,
      setPublishIp(value: string) {
        publishIp = value;
      },
      setListStatus(value: number) {
        listStatus = value;
      },
      addPort(value: unknown) {
        extraPorts.push(value);
      },
      async relay(pollMs = 60_000, options: Record<string, unknown> = {}) {
        relay = await startRelay({
          socketPath,
          apiPath,
          publishHost,
          bindHost,
          pollMs,
          onWarning: (error: Error) => warnings.push(error),
          ...options,
        });
        return relay;
      },
      async stopGateway() {
        await gateway.close();
      },
    });
  } finally {
    await relay?.close();
    await gateway?.close();
    for (const socket of sockets) socket.destroy();
    await closeServer(docker);
    await closeServer(echo);
    await rm(dir, { recursive: true, force: true });
  }
}

test("Docker API preserves binary request bodies and chunked streamed responses", async () => {
  await fixture(async (ctx) => {
    await ctx.relay();
    const body = Buffer.alloc(2 * 1024 * 1024, 0xa5);
    for (const path of [ctx.apiPath, `${ctx.socketPath}.api`]) {
      expect((await http(path, "/echo", body)).body.equals(body)).toBe(true);
      expect((await http(path, "/stream")).body.toString()).toBe(
        "first\nlast\n",
      );
    }
  });
});

test("start response waits for its published port; a poll drops it after stop", async () => {
  await fixture(async (ctx) => {
    const relay = await ctx.relay();
    expect(
      (
        await http(
          ctx.apiPath,
          `/v1.44/containers/${id}/start`,
          Buffer.alloc(0),
        )
      ).status,
    ).toBe(204);
    // No poll has run: the start response itself waited for the mirror.
    const client = await openSocket({
      host: bindHost,
      port: ctx.publishedPort,
    });
    const result = readAll(client);
    client.end("half-close tail");
    expect((await result).toString()).toBe("half-close tail");
    expect(
      (await http(ctx.apiPath, `/containers/${id}/stop`, Buffer.alloc(0)))
        .status,
    ).toBe(204);
    await relay.sync();
    await expect(
      openSocket({ host: bindHost, port: ctx.publishedPort }),
    ).rejects.toThrow();
  });
});

test("a start whose ports cannot be synchronized reports it", async () => {
  await fixture(async (ctx) => {
    await ctx.relay();
    ctx.setListStatus(500);
    const started = await http(
      ctx.apiPath,
      `/containers/${id}/start`,
      Buffer.alloc(0),
    );
    expect(started.status).toBe(502);
    expect(started.body.toString()).toContain("HTTP 500");
  });
});

test("a poll mirrors containers started from another namespace", async () => {
  await fixture(async (ctx) => {
    const relay = await ctx.relay();
    expect(
      (
        await http(
          `${ctx.socketPath}.api`,
          `/containers/${id}/start`,
          Buffer.alloc(0),
        )
      ).status,
    ).toBe(204);
    await relay.sync();
    const client = await openSocket({
      host: bindHost,
      port: ctx.publishedPort,
    });
    const echoed = readAll(client);
    client.end("mirrored");
    expect((await echoed).toString()).toBe("mirrored");
  });
});

test("ports published on any other address are not mirrored", async () => {
  await fixture(async (ctx) => {
    ctx.setPublishIp("127.0.0.1");
    const relay = await ctx.relay();
    await http(
      `${ctx.socketPath}.api`,
      `/containers/${id}/start`,
      Buffer.alloc(0),
    );
    ctx.addPort({ IP: "::1", PublicPort: ctx.publishedPort, Type: "tcp" });
    await relay.sync();
    await expect(
      openSocket({ host: bindHost, port: ctx.publishedPort }),
    ).rejects.toThrow();
  });
});

test("gateway connects only to the publish address, whatever the request asks", async () => {
  await fixture(async (ctx) => {
    let reached = 0;
    const loopbackService = createServer((socket) => {
      reached++;
      socket.end("secret");
    });
    try {
      await listen(loopbackService, { host: "127.0.0.1", port: 0 });
      const target = port(loopbackService);
      for (const request of [
        { kind: "connect", port: target },
        { kind: "connect", port: target, host: "127.0.0.1" },
      ])
        await expect(gatewayRequest(ctx.socketPath, request)).rejects.toThrow();
      for (const request of [
        { kind: "connect", port: 0 },
        { kind: "connect", port: 70000 },
        { kind: "connect", port: "80" },
        { kind: "maps" },
        { kind: "api" },
      ])
        await expect(gatewayRequest(ctx.socketPath, request)).rejects.toThrow(
          "unknown bridge operation",
        );
      expect(reached).toBe(0);
    } finally {
      await closeServer(loopbackService);
    }
  });
});

test("oversized control frame is rejected with bounded protocol parsing", async () => {
  await fixture(async (ctx) => {
    const client = await openSocket({ path: ctx.socketPath });
    try {
      client.write("x".repeat(9000));
      const response = await readFrame(client);
      expect(response.ok).toBe(false);
      expect(response.error).toContain("exceeds limit");
    } finally {
      client.destroy();
    }
  });
});

test("a start whose port is taken in the namespace fails; the port is mirrored once free", async () => {
  await fixture(async (ctx) => {
    const relay = await ctx.relay();
    let reached = 0;
    const conflict = createServer((socket) => {
      reached++;
      socket.end("inner service");
    });
    try {
      await listen(conflict, { host: bindHost, port: ctx.publishedPort });
      // A client could reach the other service on that port, so the start
      // reports the conflict instead of success.
      const started = await http(
        ctx.apiPath,
        `/containers/${id}/start`,
        Buffer.alloc(0),
      );
      expect(started.status).toBe(502);
      expect(started.body.toString()).toContain(
        `published TCP port ${ctx.publishedPort} is already in use`,
      );
      await relay.sync();
      expect(ctx.warnings.map((error: Error) => error.message)).toEqual([
        expect.stringContaining(
          `cannot mirror Docker TCP port ${ctx.publishedPort}`,
        ),
      ]);
      const client = await openSocket({
        host: bindHost,
        port: ctx.publishedPort,
      });
      expect((await readAll(client)).toString()).toBe("inner service");
      client.destroy();
      expect(reached).toBe(1);
    } finally {
      await closeServer(conflict);
    }
    await relay.sync();
    const client = await openSocket({
      host: bindHost,
      port: ctx.publishedPort,
    });
    const echoed = readAll(client);
    client.end("mirrored after conflict");
    expect((await echoed).toString()).toBe("mirrored after conflict");
  });
});

test("failed polls keep the relay and its listeners, and warn once", async () => {
  await fixture(async (ctx) => {
    const relay = await ctx.relay();
    await http(ctx.apiPath, `/containers/${id}/start`, Buffer.alloc(0));
    await ctx.stopGateway();
    await expect(relay.sync()).rejects.toThrow();
    await expect(relay.sync()).rejects.toThrow();
    expect(ctx.warnings).toHaveLength(1);
    // The listener stays; the gateway behind it is what is missing.
    const client = await openSocket({
      host: bindHost,
      port: ctx.publishedPort,
    });
    client.destroy();
  });
});

test("HTTP upgrade preserves Docker hijack bytes in both directions", async () => {
  await fixture(async (ctx) => {
    await ctx.relay();
    for (const [url, status] of [
      ["/containers/test/attach", "101 UPGRADED"],
      ["/legacy", "200 OK"],
    ]) {
      const client = await openSocket({ path: ctx.apiPath });
      try {
        const data = new Promise<string>((resolve) => {
          let result = "";
          client.on("data", (chunk: Buffer) => {
            result += chunk.toString();
            if (result.includes("hijack payload")) resolve(result);
          });
        });
        client.write(
          `POST ${url} HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n`,
        );
        client.write("hijack payload");
        client.resume();
        const result = await data;
        expect(result).toContain(status);
        expect(result).toEndWith("hijack payload");
      } finally {
        client.destroy();
      }
    }
  });
});

for (const split of [false, true]) {
  test(`upgrade request body reaches Docker before it answers: split=${split}`, async () => {
    await fixture(async (ctx) => {
      await ctx.relay();
      for (const path of [ctx.apiPath, `${ctx.socketPath}.api`]) {
        const client = await openSocket({ path });
        try {
          const data = new Promise<string>((resolve) => {
            let result = "";
            client.on("data", (chunk: Buffer) => {
              result += chunk.toString();
              if (result.includes("stream tail")) resolve(result);
            });
          });
          const body = '{"Detach":false,"Tty":false}';
          client.write(
            `POST /exec-start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${split ? body.slice(0, 5) : body}`,
          );
          if (split) {
            await Bun.sleep(50);
            client.write(body.slice(5));
          }
          client.resume();
          await Bun.sleep(50);
          client.write("stream tail");
          const result = await data;
          expect(result).toContain("101 UPGRADED");
          expect(result).toContain(`body=${body};`);
          expect(result).toEndWith("stream tail");
        } finally {
          client.destroy();
        }
      }
    });
  });
}

test("long-poll response headers reach the client before its body", async () => {
  await fixture(async (ctx) => {
    await ctx.relay();
    for (const path of [ctx.apiPath, `${ctx.socketPath}.api`]) {
      const started = Date.now();
      const headers = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            socketPath: path,
            path: "/long-poll",
            method: "POST",
            agent: false,
          },
          (res) => {
            resolve(Date.now() - started);
            res.resume();
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(headers).toBeLessThan(1000);
    }
  });
});

test("a half-closed stream keeps carrying the other direction", async () => {
  // Compress any long timer so a half-close timeout would fire during the test.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) =>
    realSetTimeout(
      fn,
      (ms ?? 0) >= 10_000 ? 50 : ms,
      ...args,
    )) as typeof setTimeout;
  const sockets = new Set<Socket>();
  const pair = async () => {
    const server = createServer({ allowHalfOpen: true });
    trackServer(server, sockets);
    await listen(server, { host: "127.0.0.1", port: 0 });
    const accepted = new Promise<Socket>((resolve) =>
      server.once("connection", resolve),
    );
    const client = await openSocket({ host: "127.0.0.1", port: port(server) });
    sockets.add(client);
    return { server, client, peer: await accepted };
  };
  const front = await pair();
  const back = await pair();
  try {
    pipeSockets(front.peer, back.client);
    const received = readAll(front.client);
    back.peer.once("end", () =>
      realSetTimeout(() => back.peer.end("late tail"), 200),
    );
    back.peer.resume();
    // Like the Docker CLI without stdin: close the write side at once.
    front.client.end();
    expect((await received).toString()).toBe("late tail");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    for (const socket of sockets) socket.destroy();
    await closeServer(front.server);
    await closeServer(back.server);
  }
});

test("the gateway reaches Docker through a Unix socket endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nas-dind-bridge-test-"));
  const docker = httpServer((_req, res) => res.end("OK"));
  let gateway: any;
  try {
    await listen(docker, join(dir, "docker.sock"));
    gateway = await startGateway({
      socketPath: join(dir, "gateway.sock"),
      dockerHost: `unix://${join(dir, "docker.sock")}`,
      publishHost,
    });
    expect(
      (await http(join(dir, "gateway.sock.api"), "/_ping")).body.toString(),
    ).toBe("OK");
  } finally {
    await gateway?.close();
    await closeServer(docker);
    await rm(dir, { recursive: true, force: true });
  }
});

test("the gateway takes only loopback TCP or an absolute Unix path for Docker", async () => {
  for (const dockerHost of [
    "tcp://10.0.0.1:2375",
    "tcp://localhost:2375",
    "unix://relative/docker.sock",
    "http://127.0.0.1:2375",
  ])
    await expect(
      startGateway({ socketPath: "/nonexistent/gateway.sock", dockerHost }),
    ).rejects.toThrow("Docker endpoint must be");
});

test("ports reported on another address reach the gateway's publish host", async () => {
  // In a Dev Container dockerd reports 0.0.0.0 while the gateway connects to
  // the sidecar's hostname; the relay selects by the former only.
  await fixture(async (ctx) => {
    ctx.setPublishIp("0.0.0.0");
    await ctx.relay(60_000, { publishHost: "0.0.0.0" });
    expect(
      (await http(ctx.apiPath, `/containers/${id}/start`, Buffer.alloc(0)))
        .status,
    ).toBe(204);
    const client = await openSocket({
      host: bindHost,
      port: ctx.publishedPort,
    });
    const echoed = readAll(client);
    client.end("through 0.0.0.0");
    expect((await echoed).toString()).toBe("through 0.0.0.0");
  });
});

test("a relay can serve the Docker API on loopback TCP instead of a socket file", async () => {
  await fixture(async (ctx) => {
    const apiPort = await freePort(bindHost);
    await ctx.relay(60_000, { api: { host: bindHost, port: apiPort } });
    expect((await tcpHttp(apiPort, "/_ping")).body.toString()).toBe("OK");
    expect(
      (await tcpHttp(apiPort, `/containers/${id}/start`, Buffer.alloc(0)))
        .status,
    ).toBe(204);
    const client = await openSocket({
      host: bindHost,
      port: ctx.publishedPort,
    });
    const echoed = readAll(client);
    client.end("over tcp");
    expect((await echoed).toString()).toBe("over tcp");
    expect(require("node:fs").existsSync(ctx.apiPath)).toBe(false);
  });
});

test("a container publishing the API's port is reported, and the API keeps it", async () => {
  await fixture(async (ctx) => {
    await ctx.relay(60_000, {
      api: { host: bindHost, port: ctx.publishedPort },
    });
    const started = await tcpHttp(
      ctx.publishedPort,
      `/containers/${id}/start`,
      Buffer.alloc(0),
    );
    expect(started.status).toBe(502);
    expect(started.body.toString()).toContain(
      `published TCP port ${ctx.publishedPort} is already in use`,
    );
    expect((await tcpHttp(ctx.publishedPort, "/_ping")).body.toString()).toBe(
      "OK",
    );
  });
});

test("the CLI rejects options its mode does not take", async () => {
  for (const args of [
    ["ensure", "--socket", "/x", "--instance", "a", "--bogus", "1"],
    [
      "serve",
      "--socket",
      "/x",
      "--docker-host",
      "tcp://127.0.0.1:1",
      "--instance",
      "a",
    ],
    ["relay", "--socket", "/x", "--instance", "a", "--instance", "b"],
    [
      "ensure",
      "--socket",
      "/x",
      "--instance",
      "a",
      "--api",
      "tcp://0.0.0.0:2375",
    ],
  ]) {
    const proc = Bun.spawn([process.execPath, script, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown option|given twice|must be tcp/);
  }
});

test("serve with --api answers Docker on that address in its own namespace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nas-dind-bridge-test-"));
  const docker = httpServer((_req, res) => res.end("OK"));
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await listen(docker, { host: "127.0.0.1", port: 0 });
    const apiPort = await freePort("127.0.0.1");
    proc = Bun.spawn(
      [
        process.execPath,
        script,
        "serve",
        "--socket",
        join(dir, "bridge.sock"),
        "--docker-host",
        `tcp://127.0.0.1:${port(docker)}`,
        "--api",
        `tcp://127.0.0.1:${apiPort}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("ready\n");
    const response = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: apiPort, path: "/_ping", agent: false },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve(text));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(response).toBe("OK");
    expect(require("node:fs").existsSync(join(dir, "docker.sock"))).toBe(false);
  } finally {
    proc?.kill("SIGTERM");
    await proc?.exited;
    await closeServer(docker);
    await rm(dir, { recursive: true, force: true });
  }
});

// --- the per-namespace relay daemon -------------------------------------

async function relayStatus(name: string) {
  const { socket, response } = await gatewayRequest(name, { kind: "status" });
  socket.destroy();
  return response as { apiPath: string; pid: number };
}
async function ensure(socketPath: string, instance: string) {
  const proc = Bun.spawn(
    [
      process.execPath,
      script,
      "ensure",
      "--socket",
      socketPath,
      "--instance",
      instance,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr };
}
async function processGone(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}
async function withDaemon(
  fn: (ctx: any, instance: string, paths: any) => Promise<void>,
) {
  const instance = `test${crypto.randomUUID().slice(0, 8)}`;
  const paths = relayPaths(instance, await readlink("/proc/self/ns/net"));
  await fixture(async (ctx) => {
    try {
      await fn(ctx, instance, paths);
    } finally {
      try {
        process.kill((await relayStatus(paths.name)).pid, "SIGTERM");
      } catch {}
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          await relayStatus(paths.name);
        } catch {
          break;
        }
        await Bun.sleep(50);
      }
      await rm(paths.directory, { recursive: true, force: true });
    }
  });
}

test("concurrent ensures in one namespace share one relay", async () => {
  await withDaemon(async (ctx, instance, paths) => {
    const results = await Promise.all(
      [1, 2, 3].map(() => ensure(ctx.socketPath, instance)),
    );
    for (const result of results)
      expect(result).toMatchObject({ code: 0, stdout: paths.apiPath });
    expect((await http(paths.apiPath, "/_ping")).body.toString()).toBe("OK");
    const { pid } = await relayStatus(paths.name);
    expect((await ensure(ctx.socketPath, instance)).stdout).toBe(paths.apiPath);
    expect((await relayStatus(paths.name)).pid).toBe(pid);
  });
});

test("a killed relay leaves nothing that blocks the next one", async () => {
  await withDaemon(async (ctx, instance, paths) => {
    expect((await ensure(ctx.socketPath, instance)).code).toBe(0);
    const { pid } = await relayStatus(paths.name);
    process.kill(pid, "SIGKILL");
    expect(await processGone(pid)).toBe(true);
    expect((await ensure(ctx.socketPath, instance)).code).toBe(0);
    expect((await relayStatus(paths.name)).pid).not.toBe(pid);
    expect((await http(paths.apiPath, "/_ping")).body.toString()).toBe("OK");
  });
});

test("a relay never serves from a directory others can write", async () => {
  await withDaemon(async (ctx, instance, paths) => {
    await mkdir(paths.directory, { mode: 0o755 });
    await chmod(paths.directory, 0o755);
    const result = await ensure(ctx.socketPath, instance);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("relay did not start");
    await expect(relayStatus(paths.name)).rejects.toThrow();
  });
});

function unixNames(): string {
  return require("node:fs").readFileSync("/proc/self/net/unix", "utf8");
}

test("the public name appears only once the relay can answer", async () => {
  await withDaemon(async (ctx, instance, paths) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const starting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const running = runRelay({
      socketPath: ctx.socketPath,
      instance,
      handleSignals: false,
      checkMs: 60_000,
      start: async (options: any) => {
        entered();
        await held;
        return startRelay(options);
      },
    });
    await starting;
    const visible = unixNames();
    expect(visible).toContain(`@${paths.lock.slice(1)}`);
    expect(visible).not.toContain(`@${paths.name.slice(1)}\n`);
    await expect(relayStatus(paths.name)).rejects.toThrow();
    release();
    const relay = await running;
    try {
      expect((await relayStatus(paths.name)).apiPath).toBe(paths.apiPath);
      expect((await http(paths.apiPath, "/_ping")).body.toString()).toBe("OK");
    } finally {
      await relay.stop();
    }
  });
});

test("a relay stays while its namespace has other processes, then cleans up", async () => {
  await withDaemon(async (ctx, instance, paths) => {
    let alone = false;
    const relay = await runRelay({
      socketPath: ctx.socketPath,
      instance,
      handleSignals: false,
      checkMs: 20,
      alone: async () => alone,
    });
    let stopped = false;
    void relay.stopped.then(() => {
      stopped = true;
    });
    await Bun.sleep(200);
    // A long command that has not touched Docker yet keeps its relay.
    expect(stopped).toBe(false);
    expect((await http(paths.apiPath, "/_ping")).body.toString()).toBe("OK");
    alone = true;
    await relay.stopped;
    await expect(relayStatus(paths.name)).rejects.toThrow();
    expect(await Bun.file(paths.apiPath).exists()).toBe(false);
  });
});

test("a relay with a TCP API creates no files and answers with its address", async () => {
  const instance = `test${crypto.randomUUID().slice(0, 8)}`;
  const paths = relayPaths(
    instance,
    await readlink("/proc/self/ns/net"),
    "dind-test",
  );
  await fixture(async (ctx) => {
    const apiPort = await freePort("127.0.0.1");
    const relay = await runRelay({
      socketPath: ctx.socketPath,
      instance,
      namePrefix: "dind-test",
      api: { host: "127.0.0.1", port: apiPort },
      handleSignals: false,
      checkMs: 60_000,
    });
    try {
      expect(paths.name).toContain("dind-test-");
      expect((await relayStatus(paths.name)).apiPath).toBe(
        `tcp://127.0.0.1:${apiPort}`,
      );
      expect(require("node:fs").existsSync(paths.directory)).toBe(false);
    } finally {
      await relay.stop();
    }
    expect(require("node:fs").existsSync(paths.directory)).toBe(false);
  });
});

test("this test's own namespace is never mistaken for an empty one", async () => {
  // The test runner's parents share the namespace, or /proc belongs to
  // another PID namespace; either way the relay must not leave.
  expect(await namespaceAlone(await readlink("/proc/self/ns/net"))).toBe(false);
});
