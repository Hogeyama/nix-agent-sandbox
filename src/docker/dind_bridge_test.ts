import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readlink, rm } from "node:fs/promises";
import { createServer as httpServer, request } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { startGateway, listenerSnapshot } = await import(
  join(import.meta.dir, "embed/dind-bridge.mjs")
);
const {
  closeServer,
  gatewayRequest,
  listen,
  openSocket,
  readFrame,
  splitUpgradeBody,
  trackServer,
} = await import(join(import.meta.dir, "embed/dind-bridge-protocol.mjs"));
const { startRelay } = await import(
  join(import.meta.dir, "embed/dind-bridge-runtime.mjs")
);

const id = "a".repeat(64);
const otherId = "d".repeat(64);
const network = "b".repeat(64);
const endpoint = "c".repeat(64);

const script = join(import.meta.dir, "embed/dind-bridge.mjs");

// Inside a nas sandbox namespace /bin/bash is nas's own wrapper, which bridges
// the session's real DinD and overrides the DOCKER_HOST these tests inspect.
function bashInterposed(bash: string): boolean {
  const probe = Bun.spawnSync([bash, "-c", 'printf %s "$DOCKER_HOST"'], {
    env: { ...process.env, DOCKER_HOST: "nas-test-probe" },
    stderr: "pipe",
  });
  return (
    probe.stdout.toString() !== "nas-test-probe" || probe.stderr.length > 0
  );
}
const bashTest = test.skipIf(bashInterposed("/bin/bash"));

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
async function readAll(socket: Socket): Promise<Buffer> {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.resume();
  return new Promise((resolve, reject) => {
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("error", reject);
  });
}

async function fixture(fn: (ctx: any) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "nas-dind-bridge-test-"));
  const sockets = new Set<Socket>();
  const echo = createServer({ allowHalfOpen: true }, (socket) => {
    socket.pipe(socket);
  });
  trackServer(echo, sockets);
  const reservation = createServer();
  let running = false;
  let existing = false;
  let started = 0;
  let metadataStatus = 200;
  const holds = new Map<
    string,
    { entered: () => void; released: Promise<void> }
  >();
  const delayNext = (point: string) => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    holds.set(point, { entered, released });
    return { entered: reached, release };
  };
  const checkpoint = async (point: string) => {
    const hold = holds.get(point);
    if (!hold) return;
    holds.delete(point);
    hold.entered();
    await hold.released;
  };
  let gateway: any;
  let relay: any;
  let targetIp = "172.18.0.2";
  const warnings: Error[] = [];
  let existingPorts: Record<string, unknown> = {};
  const docker = httpServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const path = req.url?.replace(/^\/v[0-9.]+/, "");
    if (path === "/containers/json")
      res.end(
        JSON.stringify([
          ...(existing ? [{ Id: otherId }] : []),
          ...(running ? [{ Id: id }] : []),
        ]),
      );
    else if (path === `/containers/${otherId}/json`) {
      await checkpoint(`inspect:${otherId}`);
      res.end(
        JSON.stringify({
          Id: otherId,
          State: { Running: true },
          HostConfig: { NetworkMode: "bridge" },
          NetworkSettings: { Ports: existingPorts },
        }),
      );
    } else if (path === `/containers/${id}/json`) {
      const snapshot = {
        Id: id,
        State: { Running: running, StartedAt: String(started) },
        HostConfig: { NetworkMode: "bridge" },
        NetworkSettings: {
          Ports: {
            "80/tcp": [{ HostIp: "0.0.0.0", HostPort: String(publishedPort) }],
          },
          Networks: {
            bridge: {
              NetworkID: network,
              IPAddress: targetIp,
              EndpointID: endpoint,
            },
          },
        },
      };
      await checkpoint(`inspect:${id}`);
      if (metadataStatus !== 200) {
        res.writeHead(metadataStatus);
        res.end(JSON.stringify({ message: "metadata unavailable" }));
      } else res.end(JSON.stringify(snapshot));
    } else if (path === `/networks/${network}`)
      res.end(
        JSON.stringify({
          Id: network,
          Driver: "bridge",
          Scope: "local",
          Containers: {
            [id]: { IPv4Address: `${targetIp}/16`, EndpointID: endpoint },
          },
        }),
      );
    else if (
      path === `/containers/${id}/start` ||
      path === `/containers/${id}/restart`
    ) {
      if (running) await closeServer(echo);
      started++;
      await listen(echo, { host: "127.0.0.1", port: publishedPort });
      running = true;
      res.writeHead(204);
      res.end();
    } else if (path === `/containers/${id}/stop`) {
      running = false;
      await closeServer(echo);
      res.writeHead(204);
      res.end();
    } else if (path === "/echo") req.pipe(res);
    else if (path === "/long-poll") {
      res.writeHead(200);
      res.flushHeaders();
      setTimeout(() => res.end("done\n"), 2000);
    } else if (path === "/stream") {
      res.write("first\n");
      setTimeout(() => res.end("last\n"), 30);
    } else {
      res.writeHead(200);
      res.end("OK");
    }
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
  let publishedPort = 0;
  try {
    await listen(reservation, { host: "127.0.0.1", port: 0 });
    publishedPort = port(reservation);
    await closeServer(reservation);
    await listen(docker, { host: "127.0.0.1", port: 0 });
    const socketPath = join(dir, "gateway.sock");
    const apiPath = join(dir, "docker.sock");
    gateway = await startGateway({
      socketPath,
      dockerHost: `tcp://127.0.0.1:${port(docker)}`,
      readListeners: async () => {
        const snapshot = await listenerSnapshot();
        await checkpoint("listeners");
        return snapshot;
      },
    });
    await fn({
      dir,
      socketPath,
      apiPath,
      publishedPort,
      warnings,
      delayNext,
      metadataStatus(value: number) {
        metadataStatus = value;
      },
      enableExisting(ports: Record<string, unknown> = {}) {
        existing = true;
        existingPorts = ports;
      },
      setRunning(value: boolean) {
        running = value;
      },
      setTargetIp(value: string) {
        targetIp = value;
      },
      async relay() {
        relay = await startRelay({
          socketPath,
          apiPath,
          onWarning: (error: Error) => warnings.push(error),
          bindHost: "127.0.0.2",
        });
        return relay;
      },
      async stopPublished() {
        await closeServer(echo);
      },
      async startOutsideGateway() {
        await listen(echo, { host: "127.0.0.1", port: publishedPort });
        running = true;
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
    await closeServer(reservation);
    await rm(dir, { recursive: true, force: true });
  }
}

test("Docker API preserves binary request bodies and chunked streamed responses", async () => {
  await fixture(async (ctx) => {
    await ctx.relay();
    const body = Buffer.alloc(2 * 1024 * 1024, 0xa5);
    expect((await http(ctx.apiPath, "/echo", body)).body.equals(body)).toBe(
      true,
    );
    expect((await http(ctx.apiPath, "/stream")).body.toString()).toBe(
      "first\nlast\n",
    );
  });
});

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

test("start response waits for dynamic published port; stop closes forwarding", async () => {
  await fixture(async (ctx) => {
    await ctx.relay();
    expect(
      (
        await http(
          ctx.apiPath,
          `/v1.44/containers/${id}/start`,
          Buffer.alloc(0),
        )
      ).status,
    ).toBe(204);
    const client = await openSocket({
      host: "127.0.0.2",
      port: ctx.publishedPort,
    });
    const result = readAll(client);
    client.end("half-close tail");
    expect((await result).toString()).toBe("half-close tail");
    expect(
      (await http(ctx.apiPath, `/containers/${id}/stop`, Buffer.alloc(0)))
        .status,
    ).toBe(204);
    await expect(
      openSocket({ host: "127.0.0.2", port: ctx.publishedPort }),
    ).rejects.toThrow();
  });
});

test("gateway rejects arbitrary port/address and undeclared container targets", async () => {
  await fixture(async (ctx) => {
    await expect(
      gatewayRequest(ctx.socketPath, {
        kind: "connect",
        id,
        port: ctx.publishedPort,
        host: "127.0.0.1",
      }),
    ).rejects.toThrow("not currently published");
    await expect(
      gatewayRequest(ctx.socketPath, {
        kind: "connect",
        id: "../../anything",
        port: 80,
      }),
    ).rejects.toThrow("identity");
    ctx.setRunning(true);
    ctx.setTargetIp("127.0.0.1");
    await expect(
      gatewayRequest(ctx.socketPath, {
        kind: "connect",
        id,
        port: ctx.publishedPort,
      }),
    ).rejects.toThrow("loopback listener");
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

test("HTTP upgrade preserves Docker hijack bytes in both directions", async () => {
  await fixture(async (ctx) => {
    await ctx.relay();
    const client = await openSocket({ path: ctx.apiPath });
    try {
      const data = new Promise<Buffer>((resolve) => {
        let result = Buffer.alloc(0);
        client.on("data", (chunk: Buffer) => {
          result = Buffer.concat([result, chunk]);
          if (result.includes("hijack payload")) resolve(result);
        });
      });
      client.write(
        "POST /containers/test/attach HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n",
      );
      client.write("hijack payload");
      client.resume();
      const result = (await data).toString();
      expect(result).toContain("101 UPGRADED");
      expect(result).toEndWith("hijack payload");
    } finally {
      client.destroy();
    }
  });
});

test("conflicting inner listener is reported, never forwarded, and spares other Docker access", async () => {
  await fixture(async (ctx) => {
    const relay = await ctx.relay();
    let reached = 0;
    const conflict = createServer((socket) => {
      reached++;
      socket.end("inner service");
    });
    try {
      await listen(conflict, { host: "127.0.0.2", port: ctx.publishedPort });
      expect(
        (await http(ctx.apiPath, `/containers/${id}/start`, Buffer.alloc(0)))
          .status,
      ).toBe(204);
      expect(ctx.warnings.map((error: Error) => error.message)).toEqual([
        expect.stringContaining(
          `cannot mirror Docker TCP port ${ctx.publishedPort}`,
        ),
      ]);
      // Repeated polls do not repeat the warning.
      await relay.sync();
      expect(ctx.warnings).toHaveLength(1);
      expect((await http(ctx.apiPath, "/_ping")).status).toBe(200);
      const client = await openSocket({
        host: "127.0.0.2",
        port: ctx.publishedPort,
      });
      expect((await readAll(client)).toString()).toBe("inner service");
      client.destroy();
      expect(reached).toBe(1);
    } finally {
      await closeServer(conflict);
    }
    // Once the port is free, the next poll mirrors the container.
    await relay.sync();
    const client = await openSocket({
      host: "127.0.0.2",
      port: ctx.publishedPort,
    });
    const echoed = readAll(client);
    client.end("mirrored after conflict");
    expect((await echoed).toString()).toBe("mirrored after conflict");
  });
});

bashTest(
  "missing gateway still runs the command; ordinary namespace preserves argv0 and exit status",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "nas-dind-command-"));
    try {
      const command = [
        process.execPath,
        script,
        "run",
        "--socket",
        join(dir, "missing.sock"),
        "--base-netns",
        "net:[0]",
        "--argv0",
        "kept-argv0",
        "--",
        "/bin/bash",
        "-c",
        'printf "%s" "$0"; exit 37',
      ];
      const bad = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
      expect(await bad.exited).toBe(37);
      expect(await new Response(bad.stdout).text()).toBe("kept-argv0");
      expect(await new Response(bad.stderr).text()).toContain(
        "nas DinD bridge:",
      );
      command[6] = await readlink("/proc/self/ns/net");
      const good = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
      expect(await good.exited).toBe(37);
      expect(await new Response(good.stdout).text()).toBe("kept-argv0");
      expect(await new Response(good.stderr).text()).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

bashTest(
  "unusable namespace bridge runs Bash without Docker and warns only once",
  async () => {
    await fixture(async (ctx) => {
      const netns = await readlink("/proc/self/ns/net");
      const key = new Bun.CryptoHasher("sha256")
        .update(`${ctx.socketPath}\0${netns}`)
        .digest("hex")
        .slice(0, 24);
      // A directory another user could write is never trusted for the API socket.
      const directory = `/tmp/nas-dind-${process.getuid!()}-${key}`;
      await mkdir(directory, { mode: 0o755 });
      await chmod(directory, 0o755);
      try {
        const run = (argv0: string, inner: string) => [
          process.execPath,
          script,
          "run",
          "--socket",
          ctx.socketPath,
          "--base-netns",
          "net:[0]",
          "--argv0",
          argv0,
          "--",
          "/bin/bash",
          "-c",
          inner,
        ];
        const nested = run("nested", 'printf "%s:" "$0"; exit 5')
          .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
          .join(" ");
        const proc = Bun.spawn(
          run("outer", `printf "%s:" "$0"; ${nested}; echo "$?"`),
          { stdout: "pipe", stderr: "pipe" },
        );
        expect(await proc.exited).toBe(0);
        expect(await new Response(proc.stdout).text()).toBe("outer:nested:5\n");
        const stderr = await new Response(proc.stderr).text();
        expect(stderr).toContain("continuing without Docker access");
        expect(stderr.match(/nas DinD bridge:/g)).toHaveLength(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

for (const bridged of [true, false]) {
  bashTest(
    `descriptors handed to Bash survive the supervisor: bridged=${bridged}`,
    async () => {
      await fixture(async (ctx) => {
        const dir = await mkdtemp(join(tmpdir(), "nas-dind-fds-"));
        try {
          const out = join(dir, "fd9");
          const proc = Bun.spawn(
            [
              "/bin/sh",
              "-c",
              'exec 9>"$1"; shift; exec "$@"',
              "sh",
              out,
              process.execPath,
              script,
              "run",
              "--socket",
              bridged ? ctx.socketPath : join(dir, "missing.sock"),
              "--base-netns",
              "net:[0]",
              "--argv0",
              "outer",
              "--fds",
              "9",
              "--",
              "/bin/bash",
              "-c",
              "printf via-fd9 >&9; [ -e /proc/self/fd/5 ] && echo leaked; exit 3",
            ],
            {
              stdout: "pipe",
              stderr: "pipe",
              env: bridged
                ? process.env
                : {
                    ...process.env,
                    NAS_DIND_BRIDGE_UNAVAILABLE:
                      await readlink("/proc/self/ns/net"),
                  },
            },
          );
          expect(await proc.exited).toBe(3);
          expect(await new Response(proc.stdout).text()).toBe("");
          expect(await Bun.file(out).text()).toBe("via-fd9");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    },
  );
}

bashTest("killing the supervisor stops the Bash it started", async () => {
  await fixture(async (ctx) => {
    const marker = join(ctx.dir, "heartbeat");
    const proc = Bun.spawn(
      [
        process.execPath,
        script,
        "run",
        "--socket",
        ctx.socketPath,
        "--base-netns",
        "net:[0]",
        "--argv0",
        "-kept-argv0",
        "--",
        "/bin/bash",
        "-c",
        'trap "" TERM; date +%s%N > "$1"; echo "$0"; while :; do date +%s%N > "$1"; sleep 0.05; done',
        "-kept-argv0",
        marker,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = proc.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "-kept-argv0\n",
    );
    proc.kill("SIGKILL");
    await proc.exited;
    await Bun.sleep(300);
    const before = await Bun.file(marker).text();
    await Bun.sleep(300);
    expect(await Bun.file(marker).text()).toBe(before);
  });
});

bashTest("a killed namespace owner does not block the next owner", async () => {
  await fixture(async (ctx) => {
    const args = (inner: string) => [
      process.execPath,
      script,
      "run",
      "--socket",
      ctx.socketPath,
      "--base-netns",
      "net:[0]",
      "--argv0",
      "outer",
      "--",
      "/bin/bash",
      "-c",
      inner,
    ];
    const first = Bun.spawn(args('echo "$DOCKER_HOST $$"; exec sleep 30'), {
      stdout: "pipe",
      stderr: "pipe",
    });
    let child = 0;
    try {
      const reader = first.stdout.getReader();
      const [host, pid] = new TextDecoder()
        .decode((await reader.read()).value)
        .trim()
        .split(" ");
      reader.releaseLock();
      child = Number(pid);
      first.kill("SIGKILL");
      await first.exited;
      // The killed owner leaves its API socket file behind.
      expect((await lstat(host.slice(7))).isSocket()).toBe(true);
      const second = Bun.spawn(
        args('curl -sf --unix-socket "$NAS_TEST_API" http://d/_ping'),
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NAS_TEST_API: host.slice(7) },
        },
      );
      expect(await second.exited).toBe(0);
      expect(await new Response(second.stdout).text()).toBe("OK");
      expect(await new Response(second.stderr).text()).toBe("");
    } finally {
      first.kill();
      await first.exited;
      if (child) {
        try {
          process.kill(child, "SIGKILL");
        } catch {}
      }
    }
  });
});

test("an unforwardable container elsewhere does not break the listing", async () => {
  await fixture(async (ctx) => {
    ctx.enableExisting({
      "80/tcp": [{ HostIp: "::1", HostPort: "18080" }],
    });
    expect(
      (
        await http(
          `${ctx.socketPath}.api`,
          `/containers/${id}/start`,
          Buffer.alloc(0),
        )
      ).status,
    ).toBe(204);
    const listing = await gatewayRequest(ctx.socketPath, { kind: "maps" });
    listing.socket.destroy();
    expect(listing.response.mappings.map((mapping: any) => mapping.id)).toEqual(
      [id],
    );
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

test("preexisting listener and Docker mapping cannot authorize unrelated loopback service", async () => {
  await fixture(async (ctx) => {
    await ctx.startOutsideGateway();
    const listing = await gatewayRequest(ctx.socketPath, { kind: "maps" });
    expect(listing.response.mappings).toEqual([]);
    listing.socket.destroy();
    await expect(
      gatewayRequest(ctx.socketPath, {
        kind: "connect",
        id,
        port: ctx.publishedPort,
      }),
    ).rejects.toThrow("not authorized");
  });
});

test("stale Docker metadata cannot forward to a replacement credential-bearing listener", async () => {
  await fixture(async (ctx) => {
    expect(
      (
        await http(
          `${ctx.socketPath}.api`,
          `/containers/${id}/start`,
          Buffer.alloc(0),
        )
      ).status,
    ).toBe(204);
    await ctx.stopPublished();
    let connections = 0;
    const secret = createServer((socket) => {
      connections++;
      socket.end("secret");
    });
    try {
      await listen(secret, { host: "127.0.0.1", port: ctx.publishedPort });
      await expect(
        gatewayRequest(ctx.socketPath, {
          kind: "connect",
          id,
          port: ctx.publishedPort,
        }),
      ).rejects.toThrow("not authorized");
      expect(connections).toBe(0);
      const listing = await gatewayRequest(ctx.socketPath, { kind: "maps" });
      expect(listing.response.mappings).toEqual([]);
      listing.socket.destroy();
    } finally {
      await closeServer(secret);
    }
  });
});

bashTest(
  "same-namespace nested Bash validates and reuses the live supervisor with execve",
  async () => {
    await fixture(async (ctx) => {
      const args = [
        process.execPath,
        script,
        "run",
        "--socket",
        ctx.socketPath,
        "--base-netns",
        "net:[0]",
        "--argv0",
        "outer",
        "--",
        "/bin/bash",
        "-c",
        '"$1" "$2" run --socket "$3" --base-netns "net:[0]" --argv0 nested -- /bin/bash -c \'printf "%s %s %s" "$0" "$DOCKER_HOST" "$PPID"\'',
        "outer",
        process.execPath,
        script,
        ctx.socketPath,
      ];
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      try {
        expect(await proc.exited).toBe(0);
        const output = await new Response(proc.stdout).text();
        expect(output).toStartWith("nested unix:///tmp/nas-dind-");
        const api = output.split(" ")[1].slice("unix://".length);
        await expect(openSocket({ path: api })).rejects.toThrow();
      } finally {
        proc.kill();
        await proc.exited;
      }
    });
  },
);

bashTest(
  "gateway disappearance leaves the supervised command running",
  async () => {
    await fixture(async (ctx) => {
      const proc = Bun.spawn(
        [
          process.execPath,
          script,
          "run",
          "--socket",
          ctx.socketPath,
          "--base-netns",
          "net:[0]",
          "--argv0",
          "outer",
          "--",
          "/bin/bash",
          "-c",
          'echo READY; read -r line; echo "$line"; exit 7',
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      try {
        const reader = proc.stdout.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          "READY",
        );
        await ctx.stopGateway();
        // Let several relay polls fail.
        await Bun.sleep(1500);
        proc.stdin.write("still running\n");
        proc.stdin.end();
        expect(await proc.exited).toBe(7);
        let rest = "";
        for (
          let chunk = await reader.read();
          !chunk.done;
          chunk = await reader.read()
        )
          rest += new TextDecoder().decode(chunk.value);
        expect(rest).toBe("still running\n");
        const stderr = await new Response(proc.stderr).text();
        // Each poll fails the same way; the warning is not repeated.
        expect(stderr.match(/nas DinD bridge:/g)).toHaveLength(1);
      } finally {
        proc.kill();
        await proc.exited;
      }
    });
  },
);

test("legacy HTTP200 Docker hijack keeps stdin and raw output streaming", async () => {
  await fixture(async (ctx) => {
    await ctx.relay();
    const client = await openSocket({ path: ctx.apiPath });
    try {
      const data = new Promise<Buffer>((resolve) => {
        let result = Buffer.alloc(0);
        client.on("data", (chunk: Buffer) => {
          result = Buffer.concat([result, chunk]);
          if (result.includes("legacy tail")) resolve(result);
        });
      });
      client.write(
        "POST /legacy HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n",
      );
      client.write("legacy tail");
      client.resume();
      const result = (await data).toString();
      expect(result).toContain("200 OK");
      expect(result).toEndWith("legacy tail");
    } finally {
      client.destroy();
    }
  });
});

test("unqualified container can be stopped and started through the bridge to recover", async () => {
  await fixture(async (ctx) => {
    await ctx.startOutsideGateway();
    await ctx.relay();
    expect((await http(ctx.apiPath, `/containers/${id}/json`)).status).toBe(
      502,
    );
    expect(
      (await http(ctx.apiPath, `/containers/${id}/stop`, Buffer.alloc(0)))
        .status,
    ).toBe(204);
    expect(
      (await http(ctx.apiPath, `/containers/${id}/start`, Buffer.alloc(0)))
        .status,
    ).toBe(204);
    expect((await http(ctx.apiPath, `/containers/${id}/json`)).status).toBe(
      200,
    );
  });
});

bashTest("supervised child signal status is preserved", async () => {
  await fixture(async (ctx) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        script,
        "run",
        "--socket",
        ctx.socketPath,
        "--base-netns",
        "net:[0]",
        "--argv0",
        "outer",
        "--",
        "/bin/bash",
        "-c",
        "echo READY; exec sleep 30",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = proc.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "READY",
      );
      reader.releaseLock();
      proc.kill("SIGTERM");
      await proc.exited;
      expect(proc.signalCode).toBe("SIGTERM");
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  bashTest(
    `${signal} reaches Bash's waiting child and leaves no running grandchild`,
    async () => {
      await fixture(async (ctx) => {
        const proc = Bun.spawn(
          [
            process.execPath,
            script,
            "run",
            "--socket",
            ctx.socketPath,
            "--base-netns",
            "net:[0]",
            "--argv0",
            "outer",
            "--",
            "/bin/bash",
            "-c",
            'sleep 30 & pid=$!; echo READY:$pid; wait "$pid"; :',
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        let descendant = 0;
        try {
          const reader = proc.stdout.getReader();
          const ready = new TextDecoder().decode((await reader.read()).value);
          reader.releaseLock();
          descendant = Number(ready.trim().split(":")[1]);
          expect(descendant).toBeGreaterThan(0);
          proc.kill(signal);
          await proc.exited;
          expect(proc.signalCode).toBe(signal);
          let running = false;
          try {
            const stat = await Bun.file(`/proc/${descendant}/stat`).text();
            running = stat.split(") ")[1].split(" ")[0] !== "Z";
          } catch {}
          expect(running).toBe(false);
        } finally {
          proc.kill();
          await proc.exited;
          if (descendant) {
            try {
              process.kill(descendant, "SIGKILL");
            } catch {}
          }
        }
      });
    },
  );
}

bashTest(
  "concurrent commands in one namespace share listeners until the last lease ends",
  async () => {
    await fixture(async (ctx) => {
      const args = [
        process.execPath,
        script,
        "run",
        "--socket",
        ctx.socketPath,
        "--base-netns",
        "net:[0]",
        "--argv0",
        "outer",
        "--",
        "/bin/bash",
        "-c",
        'echo "$DOCKER_HOST"; read -r done',
      ];
      const first = Bun.spawn(args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      let second: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const a = first.stdout.getReader();
        const firstPath = new TextDecoder()
          .decode((await a.read()).value)
          .trim();
        a.releaseLock();
        second = Bun.spawn(args, {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const b = (second.stdout as ReadableStream<Uint8Array>).getReader();
        const secondPath = new TextDecoder()
          .decode((await b.read()).value)
          .trim();
        b.releaseLock();
        expect(secondPath).toBe(firstPath);
        first.stdin.write("done\n");
        first.stdin.end();
        expect((await http(firstPath.slice(7), "/_ping")).status).toBe(200);
        (second.stdin as import("bun").FileSink).write("done\n");
        (second.stdin as import("bun").FileSink).end();
        expect(await second.exited).toBe(0);
        expect(await first.exited).toBe(0);
        await expect(
          openSocket({ path: firstPath.slice(7) }),
        ).rejects.toThrow();
      } finally {
        first.kill();
        second?.kill();
        await first.exited;
        await second?.exited;
      }
    });
  },
);

for (const operation of ["start", "restart"]) {
  for (const boundary of ["inspect", "listeners"]) {
    test(`stale ${boundary} poll cannot revoke concurrent ${operation} authorization`, async () => {
      await fixture(async (ctx) => {
        ctx.enableExisting();
        if (operation === "restart") {
          expect(
            (
              await http(
                `${ctx.socketPath}.api`,
                `/containers/${id}/start`,
                Buffer.alloc(0),
              )
            ).status,
          ).toBe(204);
        }
        const hold = ctx.delayNext(
          boundary === "listeners"
            ? "listeners"
            : `inspect:${operation === "restart" ? id : otherId}`,
        );
        const poll = gatewayRequest(ctx.socketPath, { kind: "maps" });
        try {
          await hold.entered;
          expect(
            (
              await http(
                `${ctx.socketPath}.api`,
                `/containers/${id}/${operation}`,
                Buffer.alloc(0),
              )
            ).status,
          ).toBe(204);
        } finally {
          hold.release();
        }
        const snapshot = await poll;
        snapshot.socket.destroy();
        expect(
          snapshot.response.mappings.map((mapping: any) => mapping.id),
        ).toContain(id);
        expect(
          (await http(`${ctx.socketPath}.api`, `/containers/${id}/json`))
            .status,
        ).toBe(200);
        const forwarded = await gatewayRequest(ctx.socketPath, {
          kind: "connect",
          id,
          port: ctx.publishedPort,
        });
        const echoed = readAll(forwarded.socket);
        forwarded.socket.end("authorization survived");
        expect((await echoed).toString()).toBe("authorization survived");
      });
    });
  }
}

for (const boundary of ["inspect", "listeners"]) {
  test(`stale connection ${boundary} check cannot delete a replacement restart grant`, async () => {
    await fixture(async (ctx) => {
      expect(
        (
          await http(
            `${ctx.socketPath}.api`,
            `/containers/${id}/start`,
            Buffer.alloc(0),
          )
        ).status,
      ).toBe(204);
      const hold = ctx.delayNext(
        boundary === "listeners" ? "listeners" : `inspect:${id}`,
      );
      const stale = gatewayRequest(ctx.socketPath, {
        kind: "connect",
        id,
        port: ctx.publishedPort,
      }).then(
        (result: any) => {
          result.socket.destroy();
          return "accepted stale mapping";
        },
        (error: Error) => error.message,
      );
      try {
        await hold.entered;
        expect(
          (
            await http(
              `${ctx.socketPath}.api`,
              `/containers/${id}/restart`,
              Buffer.alloc(0),
            )
          ).status,
        ).toBe(204);
      } finally {
        hold.release();
      }
      expect(await stale).not.toBe("accepted stale mapping");
      expect(
        (await http(`${ctx.socketPath}.api`, `/containers/${id}/json`)).status,
      ).toBe(200);
      const forwarded = await gatewayRequest(ctx.socketPath, {
        kind: "connect",
        id,
        port: ctx.publishedPort,
      });
      const echoed = readAll(forwarded.socket);
      forwarded.socket.end("replacement grant retained");
      expect((await echoed).toString()).toBe("replacement grant retained");
    });
  });
}

test("container removal between list and inspect does not fail the namespace relay", async () => {
  await fixture(async (ctx) => {
    const relay = await ctx.relay();
    expect(
      (await http(ctx.apiPath, `/containers/${id}/start`, Buffer.alloc(0)))
        .status,
    ).toBe(204);
    const hold = ctx.delayNext(`inspect:${id}`);
    const poll = relay.sync();
    try {
      await hold.entered;
      ctx.setRunning(false);
      ctx.metadataStatus(404);
      await ctx.stopPublished();
    } finally {
      hold.release();
    }
    await poll;
    expect(ctx.warnings).toEqual([]);
    expect((await http(ctx.apiPath, "/_ping")).status).toBe(200);
    await expect(
      openSocket({ host: "127.0.0.2", port: ctx.publishedPort }),
    ).rejects.toThrow();
  });
});

test("container metadata errors other than removal still fail closed", async () => {
  await fixture(async (ctx) => {
    ctx.setRunning(true);
    ctx.metadataStatus(500);
    await expect(
      gatewayRequest(ctx.socketPath, { kind: "maps" }),
    ).rejects.toThrow("HTTP 500");
  });
});

async function processRunning(pid: number) {
  try {
    return (
      (await Bun.file(`/proc/${pid}/stat`).text())
        .split(") ")[1]
        .split(" ")[0] !== "Z"
    );
  } catch {
    return false;
  }
}

for (const behavior of ["normal", "signal", "handled-signal"] as const) {
  const explicitSignal = behavior !== "normal";
  bashTest(
    `real PTY ${behavior} preserves Bash job lifetime and closes relay`,
    async () => {
      await fixture(async (ctx) => {
        let received = "";
        let ready!: (match: RegExpMatchArray) => void;
        const started = new Promise<RegExpMatchArray>((resolve) => {
          ready = resolve;
        });
        const terminal = new Bun.Terminal({
          data(_terminal, data) {
            received += new TextDecoder().decode(data);
            const match = received.match(
              /PTY_READY:(\d+):(unix:\/\/[^\s]+)\r?\n/,
            );
            if (match) ready(match);
          },
        });
        let descendant = 0;
        const command =
          behavior === "handled-signal"
            ? 'trap "" TERM; sleep 30 & pid=$!; trap "exit 43" TERM; printf "PTY_READY:%s:%s\\n" "$pid" "$DOCKER_HOST"; wait "$pid"'
            : explicitSignal
              ? 'trap "exit 42" TERM; sleep 30 & pid=$!; printf "PTY_READY:%s:%s\\n" "$pid" "$DOCKER_HOST"; wait "$pid"'
              : 'sleep 30 & pid=$!; printf "PTY_READY:%s:%s\\n" "$pid" "$DOCKER_HOST"; exit 37';
        const proc = Bun.spawn(
          [
            process.execPath,
            script,
            "run",
            "--socket",
            ctx.socketPath,
            "--base-netns",
            "net:[0]",
            "--argv0",
            "interactive",
            "--",
            "/bin/bash",
            "--noprofile",
            "--norc",
            "-i",
            "-c",
            command,
          ],
          { terminal },
        );
        try {
          const match = await started;
          descendant = Number(match[1]);
          const apiPath = match[2].slice(7);
          if (explicitSignal) {
            expect(await processRunning(descendant)).toBe(true);
            proc.kill("SIGTERM");
          }
          expect(await proc.exited, received).toBe(
            behavior === "handled-signal" ? 43 : explicitSignal ? 42 : 37,
          );
          await expect(openSocket({ path: apiPath })).rejects.toThrow();
          expect(await processRunning(descendant), received).toBe(
            behavior !== "signal",
          );
        } finally {
          if (descendant) {
            try {
              process.kill(descendant, "SIGKILL");
            } catch {}
          }
          proc.kill();
          await proc.exited;
          terminal.close();
        }
      });
    },
  );
}
