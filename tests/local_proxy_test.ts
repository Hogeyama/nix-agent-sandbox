/**
 * local-proxy.mjs unit テスト（Docker 不要、Node.js 必要）
 *
 * コンテナ内ローカル認証プロキシの HTTP 転送・CONNECT トンネル・エラー処理を検証する。
 * Node.js が利用不可の環境ではスキップ。
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

async function nodeAvailable(): Promise<boolean> {
  try {
    const result = await new Deno.Command("node", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return result.success;
  } catch {
    return false;
  }
}

const hasNode = await nodeAvailable();

const PROXY_SCRIPT = new URL(
  "../src/docker/embed/local-proxy.mjs",
  import.meta.url,
).pathname;

/** Start a mock upstream proxy server that records received requests */
function startMockUpstream(
  port: number,
  handler: (
    req: Request,
    info: Deno.ServeHandlerInfo,
  ) => Response | Promise<Response>,
): Deno.HttpServer {
  return Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
}

/** Start local-proxy.mjs as a child process on the given port */
async function startLocalProxy(
  upstreamUrl: string,
  port: number,
): Promise<Deno.ChildProcess> {
  const process = new Deno.Command("node", {
    args: [PROXY_SCRIPT],
    env: {
      NAS_UPSTREAM_PROXY: upstreamUrl,
      NAS_LOCAL_PROXY_PORT: String(port),
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Wait until the proxy is accepting connections
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      conn.close();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return process;
}

async function killProcess(process: Deno.ChildProcess): Promise<void> {
  try {
    process.kill("SIGTERM");
  } catch {
    // already exited
  }
  await process.status.catch(() => {});
}

/** Run curl through the proxy and return stdout */
async function curlViaProxy(
  proxyPort: number,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  const result = await new Deno.Command("curl", {
    args: [
      "-s",
      "-o",
      "/dev/stderr",
      "-w",
      "%{http_code}",
      "-x",
      `http://127.0.0.1:${proxyPort}`,
      targetUrl,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const status = parseInt(new TextDecoder().decode(result.stdout), 10);
  const body = new TextDecoder().decode(result.stderr);
  return { status, body };
}

Deno.test({
  name: "local-proxy: forwards HTTP request with Proxy-Authorization",
  ignore: !hasNode,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
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

      assertEquals(status, 200);
      assertEquals(body, "upstream ok");
      assertStringIncludes(receivedAuth, "Basic ");
      const decoded = atob(receivedAuth.replace("Basic ", ""));
      assertEquals(decoded, "sess_abc:token123");
    } finally {
      await killProcess(process);
      await upstream.shutdown();
    }
  },
});

Deno.test({
  name: "local-proxy: returns 502 when upstream is unreachable",
  ignore: !hasNode,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const proxyPort = 18082;
    const process = await startLocalProxy(
      "http://sess_abc:token123@127.0.0.1:19999",
      proxyPort,
    );

    try {
      const { status } = await curlViaProxy(
        proxyPort,
        "http://example.com/test",
      );

      assertEquals(status, 502);
    } finally {
      await killProcess(process);
    }
  },
});

Deno.test({
  name: "local-proxy: CONNECT tunnel forwards with Proxy-Authorization",
  ignore: !hasNode,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const upstreamPort = 19902;
    const proxyPort = 18083;
    let receivedConnectReq = "";

    // Mock upstream proxy: accept CONNECT, echo back data through tunnel
    const listener = Deno.listen({ hostname: "127.0.0.1", port: upstreamPort });
    const upstreamReady = (async () => {
      let conn: Deno.Conn | undefined;
      try {
        conn = await listener.accept();
        const buf = new Uint8Array(4096);
        const n = await conn.read(buf);
        receivedConnectReq = new TextDecoder().decode(buf.subarray(0, n!));
        await conn.write(
          new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\n"),
        );
        const data = new Uint8Array(4096);
        const dn = await conn.read(data);
        if (dn) {
          await conn.write(data.subarray(0, dn));
        }
      } catch {
        // listener closed
      } finally {
        conn?.close();
      }
    })();

    const process = await startLocalProxy(
      `http://sess_abc:token123@127.0.0.1:${upstreamPort}`,
      proxyPort,
    );

    try {
      const conn = await Deno.connect({
        hostname: "127.0.0.1",
        port: proxyPort,
      });
      await conn.write(
        new TextEncoder().encode(
          "CONNECT target.example.com:443 HTTP/1.1\r\nHost: target.example.com:443\r\n\r\n",
        ),
      );

      const buf = new Uint8Array(4096);
      const n = await conn.read(buf);
      const response = new TextDecoder().decode(buf.subarray(0, n!));
      assertStringIncludes(response, "200");

      const testPayload = "hello through tunnel";
      await conn.write(new TextEncoder().encode(testPayload));
      const echoBuf = new Uint8Array(4096);
      const en = await conn.read(echoBuf);
      const echoData = new TextDecoder().decode(echoBuf.subarray(0, en!));
      assertEquals(echoData, testPayload);

      conn.close();
      await upstreamReady;

      assertStringIncludes(
        receivedConnectReq,
        "CONNECT target.example.com:443",
      );
      assertStringIncludes(receivedConnectReq, "Proxy-Authorization: Basic ");
      const authLine = receivedConnectReq
        .split("\r\n")
        .find((l) => l.startsWith("Proxy-Authorization:"))!;
      const b64 = authLine.replace("Proxy-Authorization: Basic ", "");
      assertEquals(atob(b64), "sess_abc:token123");
    } finally {
      await killProcess(process);
      listener.close();
    }
  },
});

Deno.test({
  name: "local-proxy: exits with error when NAS_UPSTREAM_PROXY is not set",
  ignore: !hasNode,
  async fn() {
    const result = await new Deno.Command("node", {
      args: [PROXY_SCRIPT],
      env: {},
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(result.success, false);
    const stderr = new TextDecoder().decode(result.stderr);
    assertStringIncludes(stderr, "NAS_UPSTREAM_PROXY");
  },
});
