import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import net from "node:net";
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
async function startLocalProxy(
  upstreamUrl: string,
  port: number,
): Promise<ReturnType<typeof Bun.spawn>> {
  const proc = Bun.spawn(["bun", "run", PROXY_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NAS_UPSTREAM_PROXY: upstreamUrl,
      NAS_LOCAL_PROXY_PORT: String(port),
    },
  });

  // Wait until the proxy is accepting connections
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
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

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
