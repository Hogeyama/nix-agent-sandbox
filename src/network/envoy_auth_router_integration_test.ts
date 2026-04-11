import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionBroker } from "./broker.ts";
import { serveAuthRouter } from "./envoy_auth_router.ts";
import { hashToken } from "./protocol.ts";
import {
  brokerSocketPath,
  resolveNetworkRuntimePaths,
  writeSessionRegistry,
} from "./registry.ts";

interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

test("AuthRouter: listens on unix socket and challenges missing credentials", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-auth-router-"));
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

    expect(response.status).toEqual(407);
    expect(response.headers["proxy-authenticate"]).toEqual('Basic realm="nas"');
    expect(response.body).toEqual("missing proxy credentials");
  } finally {
    controller.abort();
    await server;
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("AuthRouter: authorizes valid session credentials over unix socket", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-auth-router-"));
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
      pid: process.pid,
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

    expect(response.status).toEqual(200);
    expect(response.headers["x-envoy-auth-headers-to-remove"]).toEqual(
      "proxy-authorization",
    );
    expect(response.body).toMatch(/^$/);
  } finally {
    controller.abort();
    await server;
    await broker.close().catch(() => {});
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const conn = await new Promise<net.Socket>((resolve, reject) => {
        const sock = net.createConnection({ path: socketPath }, () =>
          resolve(sock),
        );
        sock.on("error", reject);
      });
      conn.destroy();
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
  return new Promise((resolve, reject) => {
    const conn = net.createConnection({ path: socketPath }, () => {
      conn.write(rawRequest);
    });
    let response = "";
    conn.on("data", (chunk) => {
      response += chunk.toString();
    });
    conn.on("end", () => {
      conn.destroy();
      resolve(parseHttpResponse(response));
    });
    conn.on("error", (err) => {
      conn.destroy();
      reject(err);
    });
  });
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
    headers[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }

  return {
    status: Number(match[1]),
    headers,
    body: bodyParts.join("\r\n\r\n"),
  };
}
