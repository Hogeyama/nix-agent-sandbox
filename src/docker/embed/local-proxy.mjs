#!/usr/bin/env bun
// local-proxy.mjs — Container-local forward proxy that adds Proxy-Authorization
// to an upstream authenticated proxy.
//
// Usage:
//   NAS_UPSTREAM_PROXY=http://session:token@nas-envoy:15001 node local-proxy.mjs
//
// Listens on 127.0.0.1:18080 (no auth required).
// Forwards HTTP requests and CONNECT tunnels to the upstream proxy with auth.

import { createServer, request as httpRequest } from "node:http";
import {
  createServer as createTcpServer,
  connect as netConnect,
} from "node:net";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = Number(process.env.NAS_LOCAL_PROXY_PORT) || 18080;

const upstreamUrl = process.env.NAS_UPSTREAM_PROXY;
if (!upstreamUrl) {
  console.error("[local-proxy] NAS_UPSTREAM_PROXY is not set");
  process.exit(1);
}

const upstream = new URL(upstreamUrl);
const upstreamHost = upstream.hostname;
const upstreamPort = Number(upstream.port) || 80;
const upstreamAuth =
  upstream.username && upstream.password
    ? "Basic " +
      Buffer.from(
        `${decodeURIComponent(upstream.username)}:${decodeURIComponent(
          upstream.password,
        )}`,
      ).toString("base64")
    : null;

const server = createServer((clientReq, clientRes) => {
  // HTTP forward proxy: relay request to upstream proxy
  const opts = {
    hostname: upstreamHost,
    port: upstreamPort,
    method: clientReq.method,
    path: clientReq.url,
    headers: { ...clientReq.headers },
  };
  if (upstreamAuth) {
    opts.headers["proxy-authorization"] = upstreamAuth;
  }
  // Remove hop-by-hop proxy-authorization from client (should not have one, but be safe)
  delete opts.headers["proxy-connection"];

  const proxyReq = httpRequest(opts, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes, { end: true });
  });
  proxyReq.on("error", (err) => {
    console.error(`[local-proxy] HTTP upstream error: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "text/plain" });
    }
    clientRes.end("502 Bad Gateway\n");
  });
  clientReq.pipe(proxyReq, { end: true });
});

server.on("connect", (clientReq, clientSocket, head) => {
  // HTTPS CONNECT tunnel: establish tunnel through upstream proxy
  const upstreamSocket = netConnect(upstreamPort, upstreamHost, () => {
    let connectReq = `CONNECT ${clientReq.url} HTTP/1.1\r\nHost: ${clientReq.url}\r\n`;
    if (upstreamAuth) {
      connectReq += `Proxy-Authorization: ${upstreamAuth}\r\n`;
    }
    connectReq += "\r\n";
    upstreamSocket.write(connectReq);
  });

  let responseBuffer = Buffer.alloc(0);

  const onData = (chunk) => {
    responseBuffer = Buffer.concat([responseBuffer, chunk]);
    const headerEnd = responseBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    upstreamSocket.removeListener("data", onData);

    const headerStr = responseBuffer.subarray(0, headerEnd).toString();
    const statusLine = headerStr.split("\r\n")[0];
    const statusCode = parseInt(statusLine.split(" ")[1], 10);

    if (statusCode === 200) {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }
      const remainder = responseBuffer.subarray(headerEnd + 4);
      if (remainder.length > 0) {
        clientSocket.write(remainder);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    } else {
      clientSocket.write(`HTTP/1.1 ${statusCode} Connection Failed\r\n\r\n`);
      clientSocket.end();
      upstreamSocket.end();
    }
  };
  upstreamSocket.on("data", onData);

  upstreamSocket.on("error", (err) => {
    console.error(`[local-proxy] CONNECT upstream error: ${err.message}`);
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.end();
  });

  clientSocket.on("error", () => {
    upstreamSocket.destroy();
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {});

// ---------------------------------------------------------------------------
// TCP port forwarding — forward localhost:<port> to host via CONNECT tunnel
// ---------------------------------------------------------------------------

const forwardPorts = (process.env.NAS_FORWARD_PORTS || "")
  .split(",")
  .map(Number)
  .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);

for (const port of forwardPorts) {
  const tcpServer = createTcpServer((clientSocket) => {
    const bufferedClientChunks = [];
    const onClientData = (chunk) => {
      bufferedClientChunks.push(chunk);
    };
    const cleanupBufferedClientData = () => {
      clientSocket.removeListener("data", onClientData);
      bufferedClientChunks.length = 0;
    };
    clientSocket.on("data", onClientData);

    const proxySocket = netConnect(upstreamPort, upstreamHost, () => {
      let connectReq = `CONNECT host.docker.internal:${port} HTTP/1.1\r\n`;
      connectReq += `Host: host.docker.internal:${port}\r\n`;
      if (upstreamAuth) {
        connectReq += `Proxy-Authorization: ${upstreamAuth}\r\n`;
      }
      connectReq += "\r\n";
      proxySocket.write(connectReq);
    });

    let responseBuffer = Buffer.alloc(0);

    const onData = (chunk) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      proxySocket.removeListener("data", onData);

      const headerStr = responseBuffer.subarray(0, headerEnd).toString();
      const statusLine = headerStr.split("\r\n")[0];
      const statusCode = parseInt(statusLine.split(" ")[1], 10);

      if (statusCode === 200) {
        clientSocket.removeListener("data", onClientData);
        clientSocket.pause();
        for (let i = bufferedClientChunks.length - 1; i >= 0; i -= 1) {
          clientSocket.unshift(bufferedClientChunks[i]);
        }
        bufferedClientChunks.length = 0;
        const remainder = responseBuffer.subarray(headerEnd + 4);
        if (remainder.length > 0) {
          clientSocket.write(remainder);
        }
        proxySocket.pipe(clientSocket);
        clientSocket.pipe(proxySocket);
        clientSocket.resume();
      } else {
        cleanupBufferedClientData();
        console.error(
          `[local-proxy] TCP forward port ${port}: CONNECT failed with ${statusCode}`,
        );
        clientSocket.destroy();
        proxySocket.destroy();
      }
    };
    proxySocket.on("data", onData);

    proxySocket.on("error", (err) => {
      cleanupBufferedClientData();
      console.error(
        `[local-proxy] TCP forward port ${port}: upstream error: ${err.message}`,
      );
      clientSocket.destroy();
    });

    clientSocket.on("error", () => {
      cleanupBufferedClientData();
      proxySocket.destroy();
    });
  });

  tcpServer.on("error", (err) => {
    console.error(
      `[local-proxy] TCP forward port ${port}: listen error: ${err.message}`,
    );
  });

  tcpServer.listen(port, LISTEN_HOST, () => {});
}
