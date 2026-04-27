import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * local-proxy.mjs unit テスト（Docker 不要）
 *
 * コンテナ内ローカル認証プロキシの HTTP 転送・CONNECT トンネル・エラー処理を検証する。
 * local-proxy.mjs は node:http/node:net のみ使用しており Bun で実行可能。
 */

const PROXY_SCRIPT = new URL("./embed/local-proxy.mjs", import.meta.url)
  .pathname;

/** Start a mock upstream proxy server that records received requests */
function startMockUpstream(
  port: number,
  handler: (req: Request) => Response | Promise<Response>,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: handler,
  });
}

/** Start local-proxy.mjs as a child process on the given port */
async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
          sock.destroy();
          resolve();
        });
        sock.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  throw new Error(`Timed out waiting for port ${port}`);
}

async function startLocalProxy(
  upstreamUrl: string,
  port: number,
  envOverrides: Record<string, string | undefined> = {},
): Promise<ReturnType<typeof Bun.spawn>> {
  const proc = Bun.spawn(["bun", "run", PROXY_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NAS_UPSTREAM_PROXY: upstreamUrl,
      NAS_LOCAL_PROXY_PORT: String(port),
      ...envOverrides,
    },
  });

  // Wait until the proxy is accepting connections
  await waitForPort(port);
  return proc;
}

async function killProcess(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  try {
    proc.kill();
  } catch {
    // already exited
  }
  await proc.exited.catch(() => {});
}

/** Run curl through the proxy and return stdout */
async function curlViaProxy(
  proxyPort: number,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  const result = Bun.spawn(
    [
      "curl",
      "-s",
      "-w",
      "\n%{http_code}",
      "-x",
      `http://127.0.0.1:${proxyPort}`,
      targetUrl,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const combined = await new Response(result.stdout).text();
  const lastNewline = combined.lastIndexOf("\n");
  const body = combined.slice(0, lastNewline);
  const status = parseInt(combined.slice(lastNewline + 1), 10);
  return { status, body };
}

test("local-proxy: forwards HTTP request with Proxy-Authorization", async () => {
  const upstreamPort = 19901;
  const proxyPort = 18081;
  let receivedAuth = "";

  const upstream = startMockUpstream(upstreamPort, (req) => {
    receivedAuth = req.headers.get("proxy-authorization") ?? "";
    return new Response("upstream ok", { status: 200 });
  });

  const process = await startLocalProxy(
    `http://sess_abc:token123@127.0.0.1:${upstreamPort}`,
    proxyPort,
  );

  try {
    const { status, body } = await curlViaProxy(
      proxyPort,
      "http://httpbin.org/get",
    );

    expect(status).toEqual(200);
    expect(body).toEqual("upstream ok");
    expect(receivedAuth).toContain("Basic ");
    const decoded = atob(receivedAuth.replace("Basic ", ""));
    expect(decoded).toEqual("sess_abc:token123");
  } finally {
    await killProcess(process);
    upstream.stop();
  }
});

test("local-proxy: returns 502 when upstream is unreachable", async () => {
  const proxyPort = 18082;
  const process = await startLocalProxy(
    "http://sess_abc:token123@127.0.0.1:19999",
    proxyPort,
  );

  try {
    const { status } = await curlViaProxy(proxyPort, "http://example.com/test");

    expect(status).toEqual(502);
  } finally {
    await killProcess(process);
  }
});

test("local-proxy: CONNECT tunnel forwards with Proxy-Authorization", async () => {
  const upstreamPort = 19902;
  const proxyPort = 18083;
  let receivedConnectReq = "";

  // Mock upstream proxy: accept CONNECT, echo back data through tunnel
  const listener = net.createServer();
  listener.listen(upstreamPort, "127.0.0.1");
  const upstreamReady = new Promise<void>((resolve) => {
    listener.once("connection", (conn) => {
      conn.once("data", (buf) => {
        receivedConnectReq = buf.toString();
        conn.write("HTTP/1.1 200 OK\r\n\r\n");
        conn.once("data", (data) => {
          conn.write(data);
          conn.end();
          resolve();
        });
      });
    });
  });

  const process = await startLocalProxy(
    `http://sess_abc:token123@127.0.0.1:${upstreamPort}`,
    proxyPort,
  );

  try {
    const conn = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection(
        {
          host: "127.0.0.1",
          port: proxyPort,
        },
        () => resolve(sock),
      );
      sock.on("error", reject);
    });

    // Send CONNECT request
    conn.write(
      "CONNECT target.example.com:443 HTTP/1.1\r\nHost: target.example.com:443\r\n\r\n",
    );

    const response = await new Promise<string>((resolve) => {
      conn.once("data", (buf) => resolve(buf.toString()));
    });
    expect(response).toContain("200");

    const testPayload = "hello through tunnel";
    conn.write(testPayload);
    const echoData = await new Promise<string>((resolve) => {
      conn.once("data", (buf) => resolve(buf.toString()));
    });
    expect(echoData).toEqual(testPayload);

    conn.destroy();
    await upstreamReady;

    expect(receivedConnectReq).toContain("CONNECT target.example.com:443");
    expect(receivedConnectReq).toContain("Proxy-Authorization: Basic ");
    const authLine = receivedConnectReq
      .split("\r\n")
      .find((l) => l.startsWith("Proxy-Authorization:"))!;
    const b64 = authLine.replace("Proxy-Authorization: Basic ", "");
    expect(atob(b64)).toEqual("sess_abc:token123");
  } finally {
    await killProcess(process);
    listener.close();
  }
});

/**
 * Spawn local-proxy.mjs wired up for forward-port testing.
 *
 * NAS_UPSTREAM_PROXY is required by the script's startup guard (it's used by
 * the HTTP/HTTPS proxy paths). Forward-port traffic no longer touches the
 * upstream proxy — it goes straight to the per-port UDS bind-mounted into
 * the container — so we hand the script an unreachable URL on purpose.
 */
async function startLocalProxyForForward(
  proxyPort: number,
  socketDir: string,
  ports: number[],
): Promise<ReturnType<typeof Bun.spawn>> {
  return startLocalProxy(
    "http://sess_abc:token123@127.0.0.1:65535",
    proxyPort,
    {
      NAS_FORWARD_PORTS: ports.join(","),
      NAS_FORWARD_PORT_SOCKET_DIR: socketDir,
    },
  );
}

/** Listen on a UDS for forward-port testing; resolves with the listener. */
function listenUds(socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function connectWithRetry(
  port: number,
  deadlineMs = 5_000,
): Promise<net.Socket> {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.createConnection({ host: "127.0.0.1", port }, () =>
        resolve(sock),
      );
      sock.on("error", (error) => {
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(error);
          return;
        }
        setTimeout(tryOnce, 50);
      });
    };
    tryOnce();
  });
}

test("local-proxy: forwarded port preserves early client bytes via UDS", async () => {
  const proxyPort = 18084;
  const forwardedPort = 18085;
  const payload = "hello before tunnel";

  const socketDir = await mkdtemp(path.join(tmpdir(), "nas-fp-test-"));
  const socketPath = path.join(socketDir, `${forwardedPort}.sock`);

  let tunneledPayload = "";
  const upstreamReady = new Promise<void>((resolve, reject) => {
    listenUds(socketPath).then((server) => {
      server.on("connection", (conn) => {
        // The first chunk we see should already include the early client
        // bytes the spec promises to preserve. We echo back to prove the
        // pipe is wired both ways.
        conn.once("data", (data) => {
          tunneledPayload += data.toString();
          conn.write(data);
          conn.end();
          resolve();
        });
        conn.on("error", reject);
      });
      server.on("error", reject);
    }, reject);
  });

  const process = await startLocalProxyForForward(proxyPort, socketDir, [
    forwardedPort,
  ]);

  try {
    const client = await connectWithRetry(forwardedPort);

    // Write immediately on connect — the local-proxy must hold these bytes
    // until the UDS hop is established and then deliver them to the upstream.
    client.write(payload);
    const echoData = await new Promise<string>((resolve, reject) => {
      client.once("data", (buf) => resolve(buf.toString()));
      client.once("error", reject);
    });
    expect(echoData).toEqual(payload);

    await Promise.race([
      upstreamReady,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Timed out waiting for forwarded payload")),
          1_000,
        ),
      ),
    ]);

    expect(tunneledPayload).toEqual(payload);

    client.destroy();
  } finally {
    await killProcess(process);
    await rm(socketDir, { recursive: true, force: true });
  }
});

test("local-proxy: forwarded port handles large bidirectional payloads without drift", async () => {
  const proxyPort = 18086;
  const forwardedPort = 18087;

  const socketDir = await mkdtemp(path.join(tmpdir(), "nas-fp-test-"));
  const socketPath = path.join(socketDir, `${forwardedPort}.sock`);

  // 64 KiB of deterministic bytes per direction. The local-proxy chunks
  // streams; if early-bytes buffering or pause/resume drops anything we'll
  // see a mismatch in length or content.
  const size = 64 * 1024;
  const clientToServer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) clientToServer[i] = i & 0xff;
  const serverToClient = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) serverToClient[i] = (i * 7 + 3) & 0xff;

  const collectedFromClient: Buffer[] = [];
  const upstreamDone = new Promise<void>((resolve, reject) => {
    listenUds(socketPath).then((server) => {
      server.on("connection", (conn) => {
        conn.on("data", (chunk) => {
          collectedFromClient.push(chunk);
          const total = Buffer.concat(collectedFromClient).length;
          if (total >= size) {
            conn.write(serverToClient, () => {
              conn.end();
              resolve();
            });
          }
        });
        conn.on("error", reject);
      });
      server.on("error", reject);
    }, reject);
  });

  const process = await startLocalProxyForForward(proxyPort, socketDir, [
    forwardedPort,
  ]);

  try {
    const client = await connectWithRetry(forwardedPort);

    const collectedFromServer: Buffer[] = [];
    const clientDone = new Promise<void>((resolve, reject) => {
      client.on("data", (chunk) => {
        collectedFromServer.push(chunk);
      });
      client.on("end", () => resolve());
      client.on("error", reject);
    });

    client.write(clientToServer);

    await Promise.race([
      Promise.all([upstreamDone, clientDone]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Timed out on large payload exchange")),
          5_000,
        ),
      ),
    ]);

    const fromClient = Buffer.concat(collectedFromClient);
    const fromServer = Buffer.concat(collectedFromServer);
    expect(fromClient.length).toEqual(size);
    expect(fromServer.length).toEqual(size);
    expect(fromClient.equals(clientToServer)).toEqual(true);
    expect(fromServer.equals(serverToClient)).toEqual(true);
  } finally {
    await killProcess(process);
    await rm(socketDir, { recursive: true, force: true });
  }
});

test("local-proxy: forwarded port closes client connection when UDS is missing", async () => {
  const proxyPort = 18088;
  const forwardedPort = 18089;

  // Create the dir but intentionally do NOT create the socket file.
  const socketDir = await mkdtemp(path.join(tmpdir(), "nas-fp-test-"));

  const process = await startLocalProxyForForward(proxyPort, socketDir, [
    forwardedPort,
  ]);

  try {
    const client = await connectWithRetry(forwardedPort);

    // The local-proxy should fail the UDS connect (ENOENT) and destroy the
    // client socket; we observe that as either an immediate close or an
    // error event with no data ever arriving.
    await Promise.race([
      new Promise<void>((resolve) => client.on("close", () => resolve())),
      new Promise<void>((resolve) => client.on("error", () => resolve())),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Timed out waiting for client close")),
          2_000,
        ),
      ),
    ]);

    expect(client.destroyed).toEqual(true);
  } finally {
    await killProcess(process);
    await rm(socketDir, { recursive: true, force: true });
  }
});

test("local-proxy: exits with error when NAS_UPSTREAM_PROXY is not set", async () => {
  const proc = Bun.spawn(["bun", "run", PROXY_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NAS_UPSTREAM_PROXY: undefined,
      NAS_LOCAL_PROXY_PORT: undefined,
    },
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);

  expect(exitCode).not.toEqual(0);
  expect(stderr).toContain("NAS_UPSTREAM_PROXY");
});
