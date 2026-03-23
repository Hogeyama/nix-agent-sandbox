import { assertEquals, assertMatch } from "@std/assert";
import { SessionBroker } from "../src/network/broker.ts";
import { serveAuthRouter } from "../src/network/envoy_auth_router.ts";
import {
  brokerSocketPath,
  resolveNetworkRuntimePaths,
  writeSessionRegistry,
} from "../src/network/registry.ts";
import { hashToken } from "../src/network/protocol.ts";

interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

Deno.test({
  name: "AuthRouter: listens on unix socket and challenges missing credentials",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const runtimeDir = await Deno.makeTempDir({ prefix: "nas-auth-router-" });
    const controller = new AbortController();
    const server = serveAuthRouter(runtimeDir, { signal: controller.signal });
    const paths = await resolveNetworkRuntimePaths(runtimeDir);

    try {
      await waitForSocket(paths.authRouterSocket, 2_000);
      const response = await sendUnixHttpRequest(
        paths.authRouterSocket,
        [
          "GET /authorize HTTP/1.1",
          "Host: auth-router",
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );

      assertEquals(response.status, 407);
      assertEquals(
        response.headers["proxy-authenticate"],
        'Basic realm="nas"',
      );
      assertEquals(response.body, "missing proxy credentials");
    } finally {
      controller.abort();
      await server;
      await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "AuthRouter: authorizes valid session credentials over unix socket",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const runtimeDir = await Deno.makeTempDir({ prefix: "nas-auth-router-" });
    const paths = await resolveNetworkRuntimePaths(runtimeDir);
    const controller = new AbortController();
    const sessionId = "sess_auth_router";
    const token = "secret-token";
    const brokerSocket = brokerSocketPath(paths, sessionId);
    const broker = new SessionBroker({
      paths,
      sessionId,
      allowlist: ["example.org"],
      denylist: [],
      promptEnabled: false,
      timeoutSeconds: 300,
      defaultScope: "host-port",
      notify: "off",
    });
    const server = serveAuthRouter(runtimeDir, { signal: controller.signal });

    try {
      await broker.start(brokerSocket);
      await writeSessionRegistry(paths, {
        version: 1,
        sessionId,
        tokenHash: await hashToken(token),
        brokerSocket,
        profileName: "test",
        allowlist: ["example.org"],
        createdAt: new Date().toISOString(),
        pid: Deno.pid,
        promptEnabled: false,
      });

      await waitForSocket(paths.authRouterSocket, 2_000);
      const proxyAuthorization = `Basic ${btoa(`${sessionId}:${token}`)}`;
      const response = await sendUnixHttpRequest(
        paths.authRouterSocket,
        [
          "POST /authorize HTTP/1.1",
          "Host: auth-router",
          `Proxy-Authorization: ${proxyAuthorization}`,
          "x-nas-original-method: CONNECT",
          "x-nas-original-authority: example.org:443",
          "x-request-id: req_auth_router",
          "Connection: close",
          "Content-Length: 0",
          "",
          "",
        ].join("\r\n"),
      );

      assertEquals(response.status, 200);
      assertEquals(
        response.headers["x-envoy-auth-headers-to-remove"],
        "proxy-authorization",
      );
      assertMatch(response.body, /^$/);
    } finally {
      controller.abort();
      await server;
      await broker.close().catch(() => {});
      await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    }
  },
});

async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ transport: "unix", path: socketPath });
      conn.close();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for socket: ${socketPath}`);
}

async function sendUnixHttpRequest(
  socketPath: string,
  rawRequest: string,
): Promise<RawHttpResponse> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  try {
    await conn.write(new TextEncoder().encode(rawRequest));
    const decoder = new TextDecoder();
    const chunk = new Uint8Array(1024);
    let response = "";
    while (true) {
      const size = await conn.read(chunk);
      if (size === null) break;
      response += decoder.decode(chunk.subarray(0, size));
    }
    return parseHttpResponse(response);
  } finally {
    conn.close();
  }
}

function parseHttpResponse(response: string): RawHttpResponse {
  const [head, ...bodyParts] = response.split("\r\n\r\n");
  const lines = head.split("\r\n");
  const statusLine = lines.shift() ?? "";
  const match = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})\b/);
  if (!match) {
    throw new Error(`Invalid HTTP response: ${response}`);
  }

  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(
      separator + 1,
    ).trim();
  }

  return {
    status: Number(match[1]),
    headers,
    body: bodyParts.join("\r\n\r\n"),
  };
}
