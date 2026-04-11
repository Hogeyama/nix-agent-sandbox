import { writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import {
  connectUnix,
  createUnixServer,
  type Server,
  type Socket,
} from "../lib/unix_socket.ts";
import {
  type AuthorizeRequest,
  type DecisionResponse,
  decodeProxyAuthorization,
  generateSessionId,
  hashToken,
  normalizeTarget,
} from "./protocol.ts";
import {
  gcNetworkRuntime,
  type NetworkRuntimePaths,
  readSessionRegistry,
  resolveNetworkRuntimePaths,
} from "./registry.ts";
import { sendBrokerRequest } from "./broker.ts";
import { logInfo } from "../log.ts";

export async function ensureAuthRouterDaemon(
  paths: NetworkRuntimePaths,
): Promise<AbortController | null> {
  await gcNetworkRuntime(paths);
  if (await canConnect(paths.authRouterSocket)) {
    return null;
  }

  const ac = new AbortController();
  void serveAuthRouter(paths.runtimeDir, { signal: ac.signal }).catch((e) =>
    logInfo(`[nas] AuthRouter: daemon exited with error: ${e}`),
  );

  await writeFile(paths.authRouterPidFile, `${process.pid}\n`, {
    mode: 0o600,
  });
  await waitForSocket(paths.authRouterSocket, 10_000);
  return ac;
}

export async function serveAuthRouter(
  runtimeDir: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  await removeSocketIfExists(paths.authRouterSocket);

  let server: Server;
  try {
    server = await createUnixServer(
      paths.authRouterSocket,
      (socket) => void handleConnection(paths, socket),
    );
  } catch (error) {
    if (options.signal?.aborted) return;
    throw error;
  }

  // Envoy runs as uid 101 inside its container and needs write access.
  await chmod(paths.authRouterSocket, 0o777);

  const abortHandler = () => server.close();
  options.signal?.addEventListener("abort", abortHandler);

  // Keep alive until the server closes
  await new Promise<void>((resolve) => {
    server.on("close", resolve);
  });
}

async function handleConnection(
  paths: NetworkRuntimePaths,
  socket: Socket,
): Promise<void> {
  try {
    let raw = "";
    // Read until we have a complete HTTP request (headers end with \r\n\r\n).
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        raw += chunk.toString();
        if (raw.includes("\r\n\r\n")) {
          socket.off("data", onData);
          socket.off("end", onEnd);
          socket.off("error", onError);
          resolve();
        }
      };
      const onEnd = () => {
        socket.off("data", onData);
        socket.off("end", onEnd);
        socket.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        socket.off("data", onData);
        socket.off("end", onEnd);
        socket.off("error", onError);
        reject(err);
      };
      socket.on("data", onData);
      socket.on("end", onEnd);
      socket.on("error", onError);
    });

    if (!raw.includes("\r\n\r\n")) return;

    const parsed = parseHttpRequest(raw);
    if (!parsed) {
      await writeResponse(socket, 400, "Bad Request", {}).catch(() => {});
      return;
    }

    const result = await authorize(paths, parsed.headers, parsed.method);

    const responseHeaders: Record<string, string> = {
      ...result.extraHeaders,
    };
    if (result.challenge) {
      responseHeaders["Proxy-Authenticate"] = 'Basic realm="nas"';
    }
    await writeResponse(
      socket,
      result.status,
      result.message,
      responseHeaders,
    ).catch(() => {
      /* peer closed early (BrokenPipe) — ignore */
    });
  } finally {
    try {
      socket.destroy();
    } catch {
      /* already closed */
    }
  }
}

interface ParsedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

function parseHttpRequest(raw: string): ParsedRequest | null {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const headerSection = raw.slice(0, headerEnd);
  const lines = headerSection.split("\r\n");
  if (lines.length === 0) return null;

  const requestLine = lines[0];
  const parts = requestLine.split(" ");
  if (parts.length < 2) return null;

  const method = parts[0];
  const requestPath = parts[1];
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx <= 0) continue;
    const key = lines[i].slice(0, colonIdx).trim().toLowerCase();
    const value = lines[i].slice(colonIdx + 1).trim();
    headers[key] = value;
  }

  return { method, path: requestPath, headers };
}

function writeResponse(
  socket: Socket,
  status: number,
  body: string,
  headers: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const statusText = HTTP_STATUS_TEXT[status] ?? "Unknown";
    const bodyBytes = new TextEncoder().encode(body);
    const allHeaders: Record<string, string> = {
      "content-type": "text/plain",
      "content-length": String(bodyBytes.length),
      connection: "close",
      ...headers,
    };
    let response = `HTTP/1.1 ${status} ${statusText}\r\n`;
    for (const [key, value] of Object.entries(allHeaders)) {
      response += `${key}: ${value}\r\n`;
    }
    response += `\r\n`;
    const headerBytes = new TextEncoder().encode(response);
    const fullResponse = new Uint8Array(headerBytes.length + bodyBytes.length);
    fullResponse.set(headerBytes);
    fullResponse.set(bodyBytes, headerBytes.length);
    socket.write(fullResponse, (err) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPIPE" || code === "ECONNRESET") {
          resolve();
          return;
        }
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

const HTTP_STATUS_TEXT: Record<number, string> = {
  200: "OK",
  400: "Bad Request",
  403: "Forbidden",
  407: "Proxy Authentication Required",
};

interface AuthResult {
  status: number;
  message: string;
  challenge: boolean;
  extraHeaders: Record<string, string>;
}

async function authorize(
  paths: NetworkRuntimePaths,
  headers: Record<string, string>,
  requestMethod: string,
): Promise<AuthResult> {
  const proxyAuthorization = headers["proxy-authorization"] ?? null;
  const credentials = decodeProxyAuthorization(proxyAuthorization);
  if (!credentials) {
    return {
      status: 407,
      message: "missing proxy credentials",
      challenge: true,
      extraHeaders: {},
    };
  }

  const session = await readSessionRegistry(paths, credentials.sessionId);
  if (!session) {
    return {
      status: 403,
      message: "stale-session",
      challenge: false,
      extraHeaders: {},
    };
  }

  const tokenHash = await hashToken(credentials.token);
  if (tokenHash !== session.tokenHash) {
    return {
      status: 407,
      message: "invalid proxy credentials",
      challenge: true,
      extraHeaders: {},
    };
  }

  const method =
    headers["x-nas-original-method"] ??
    headers["x-forwarded-method"] ??
    requestMethod;
  const authority = headers["x-nas-original-authority"] ?? headers["host"];
  const url = headers["x-nas-original-url"];
  const hostHeader = headers["host"];

  let target;
  try {
    target = normalizeTarget({
      method,
      authority: authority ?? null,
      url: url ?? null,
      hostHeader: hostHeader ?? null,
    });
  } catch (error) {
    return {
      status: 403,
      message: (error as Error).message,
      challenge: false,
      extraHeaders: {},
    };
  }

  const authorizeReq: AuthorizeRequest = {
    version: 1,
    type: "authorize",
    requestId: headers["x-request-id"] ?? generateSessionId(),
    sessionId: session.sessionId,
    target,
    method,
    requestKind: method.toUpperCase() === "CONNECT" ? "connect" : "forward",
    observedAt: new Date().toISOString(),
  };

  let brokerDecision: DecisionResponse;
  try {
    brokerDecision = await sendBrokerRequest<DecisionResponse>(
      session.brokerSocket,
      authorizeReq,
    );
  } catch (error) {
    return {
      status: 403,
      message: `broker-unavailable: ${(error as Error).message}`,
      challenge: false,
      extraHeaders: {},
    };
  }

  if (brokerDecision.decision === "allow") {
    return {
      status: 200,
      message: "",
      challenge: false,
      extraHeaders: {
        "x-envoy-auth-headers-to-remove": "proxy-authorization",
      },
    };
  }
  return {
    status: 403,
    message: brokerDecision.message ?? brokerDecision.reason,
    challenge: false,
    extraHeaders: {},
  };
}

async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await canConnect(socketPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for auth-router socket");
}

async function canConnect(socketPath: string): Promise<boolean> {
  try {
    const socket = await connectUnix(socketPath);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

async function removeSocketIfExists(socketPath: string): Promise<void> {
  await rm(socketPath, { force: true });
}
