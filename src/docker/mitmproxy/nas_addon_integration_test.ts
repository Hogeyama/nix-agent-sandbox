import { expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { hashToken } from "../../network/protocol.ts";
import {
  brokerSocketPath,
  resolveNetworkRuntimePaths,
  sessionRegistryPath,
  writeSessionRegistry,
} from "../../network/registry.ts";
import {
  dockerLogs,
  dockerRm,
  dockerRunDetached,
  dockerStop,
} from "../client.ts";

const SHARED_TMP = process.env.NAS_DIND_SHARED_TMP;
const canBindMount = SHARED_TMP !== undefined || !process.env.DOCKER_HOST;
const dockerAvailable = (() => {
  try {
    return Bun.spawnSync(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    }).success;
  } catch {
    return false;
  }
})();

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitForTcp(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error(`timed out waiting for proxy port ${port}`);
}

async function publishedPort(containerName: string): Promise<number> {
  const proc = Bun.spawn(["docker", "port", containerName, "8080/tcp"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr.trim());
  const match = stdout.trim().match(/:(\d+)$/);
  if (!match) throw new Error(`unexpected docker port output: ${stdout}`);
  return Number(match[1]);
}

async function sendProxyRequest(
  proxyPort: number,
  targetUrl: string,
  credentials: string,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: proxyPort });
    socket.setTimeout(5_000, () => socket.destroy());
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${targetUrl} HTTP/1.1`,
          `Host: ${new URL(targetUrl).host}`,
          `Proxy-Authorization: Basic ${btoa(credentials)}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", () => {});
    socket.once("error", () => resolve());
    socket.once("close", () => resolve());
  });
}

test.skipIf(!dockerAvailable || !canBindMount)(
  "nas_addon: DNS resolving to host gateway is blocked before connect",
  async () => {
    const base = SHARED_TMP ?? "/tmp";
    const runtimeDir = await mkdtemp(path.join(base, "nas-addon-dns-"));
    const containerName = `nas-addon-test-${crypto.randomUUID().slice(0, 8)}`;
    let brokerRequests = 0;
    let hostConnections = 0;
    let targetPort = 0;
    let target: net.Server | undefined;
    let broker: net.Server | undefined;

    try {
      const paths = await resolveNetworkRuntimePaths(runtimeDir);
      const sessionId = `sess_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const token = "integration-token";
      const socketPath = brokerSocketPath(paths, sessionId);

      const targetServer = net.createServer((socket) => {
        hostConnections += 1;
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\nhost reached");
      });
      target = targetServer;

      const brokerServer = net.createServer((socket) => {
        let input = "";
        socket.on("data", (chunk) => {
          input += chunk.toString();
          const newline = input.indexOf("\n");
          if (newline < 0) return;
          const request = JSON.parse(input.slice(0, newline));
          brokerRequests += 1;
          socket.end(
            `${JSON.stringify({
              version: 1,
              type: "decision",
              requestId: request.requestId,
              decision: "allow",
              reason: "integration-test",
            })}\n`,
          );
        });
      });
      broker = brokerServer;

      await new Promise<void>((resolve, reject) => {
        targetServer.once("error", reject);
        targetServer.listen(0, "0.0.0.0", resolve);
      });
      targetPort = (targetServer.address() as AddressInfo).port;
      await chmod(runtimeDir, 0o755);
      await chmod(paths.caCertDir, 0o777);
      await chmod(paths.brokersDir, 0o755);
      await chmod(paths.reviewRulesDir, 0o755);
      await mkdir(path.dirname(socketPath), { recursive: true });
      await chmod(path.dirname(socketPath), 0o755);
      await copyFile(
        new URL("./nas_addon.py", import.meta.url).pathname,
        paths.addonScriptPath,
      );
      await writeFile(`${paths.reviewRulesDir}/${sessionId}.json`, "[]");
      await writeSessionRegistry(paths, {
        version: 1,
        sessionId,
        tokenHash: await hashToken(token),
        brokerSocket: socketPath,
        profileName: "integration-test",
        createdAt: new Date().toISOString(),
        pid: process.pid,
      });
      await chmod(paths.sessionsDir, 0o755);
      await chmod(sessionRegistryPath(paths, sessionId), 0o644);
      await new Promise<void>((resolve, reject) => {
        brokerServer.once("error", reject);
        brokerServer.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o666);

      await dockerRunDetached({
        name: containerName,
        image: "mitmproxy/mitmproxy:11",
        args: ["--add-host=rebind.test:host-gateway"],
        envVars: {},
        mounts: [{ source: runtimeDir, target: "/nas-network", mode: "rw" }],
        publishedPorts: ["127.0.0.1::8080"],
        command: [
          "mitmdump",
          "--mode",
          "regular@8080",
          "--set",
          "connection_strategy=lazy",
          "--set",
          "confdir=/nas-network/mitmproxy-ca",
          "--ssl-insecure",
          "-s",
          "/nas-network/nas_addon.py",
        ],
      });
      const proxyPort = await publishedPort(containerName);
      await waitForTcp(proxyPort);

      await sendProxyRequest(
        proxyPort,
        `http://rebind.test:${targetPort}/`,
        `${sessionId}:${token}`,
      );
      await Bun.sleep(100);

      expect(brokerRequests).toEqual(1);
      expect(hostConnections).toEqual(0);
      expect(await dockerLogs(containerName)).toContain("DNS-BLOCKED");
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      if (broker?.listening) await closeServer(broker);
      if (target?.listening) await closeServer(target);
      await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);
