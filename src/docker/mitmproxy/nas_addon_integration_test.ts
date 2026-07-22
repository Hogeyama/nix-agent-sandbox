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
  dockerContainerIpOnNetwork,
  dockerLogs,
  dockerNetworkRemove,
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

async function waitForContainerTcp(
  containerName: string,
  port: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const proc = Bun.spawn(
      [
        "docker",
        "exec",
        containerName,
        "python3",
        "-c",
        `import socket; socket.create_connection(("127.0.0.1", ${port}), 0.2).close()`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await proc.exited) === 0) return;
    await Bun.sleep(250);
  }
  const logs = await dockerLogs(containerName);
  throw new Error(
    `timed out waiting for ${containerName}:${port}\n` +
      `--- container logs ---\n${logs}`,
  );
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

interface ProxyRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

async function sendProxyRequest(
  proxyPort: number,
  targetUrl: string,
  credentials: string,
  options: ProxyRequestOptions = {},
): Promise<string> {
  const method = options.method ?? "GET";
  const body = options.body;
  return await new Promise((resolve, reject) => {
    let response = "";
    const socket = net.createConnection({ host: "127.0.0.1", port: proxyPort });
    socket.setTimeout(5_000, () => {
      socket.destroy(new Error("timed out waiting for proxy response"));
    });
    socket.once("connect", () => {
      const lines = [
        `${method} ${targetUrl} HTTP/1.1`,
        `Host: ${new URL(targetUrl).host}`,
        `Proxy-Authorization: Basic ${btoa(credentials)}`,
      ];
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        lines.push(`${name}: ${value}`);
      }
      if (body !== undefined) {
        lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      }
      lines.push("Connection: close", "", "");
      socket.write(lines.join("\r\n") + (body ?? ""));
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(response));
  });
}

/**
 * `docker network create` に無い `--subnet` オプション付きでカスタム
 * bridge network を作る（既存 `dockerNetworkCreateWithLabels` はサブネット
 * 指定に対応していないため、このテストファイル内だけのローカルヘルパとして
 * 直接 docker CLI を呼ぶ）。
 */
async function dockerNetworkCreateWithSubnet(
  name: string,
  subnet: string,
): Promise<void> {
  const proc = Bun.spawn(
    ["docker", "network", "create", "--subnet", subnet, name],
    { stdout: "ignore", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `docker network create --subnet ${subnet} ${name} failed: ${stderr.trim()}`,
    );
  }
}

/**
 * RFC 2544 ベンチマーク用に予約された 198.18.0.0/15 内からランダムな /24 を
 * 選ぶ。この範囲は nas_addon.py の DENIED_IPV4_NETWORKS
 * (private/loopback/link-local/CGN のみ) に含まれないため、
 * "denied ではない" upstream アドレスとして使い捨て docker network に
 * 割り当てられる。実在サービスへは絶対にルーティングされない予約範囲であり、
 * かつ private ではないので `_denied_ip_classification` を通過する。
 */
function randomBenchmarkSubnet(): string {
  const secondOctet = 18 + Math.floor(Math.random() * 2); // 18 or 19
  const thirdOctet = Math.floor(Math.random() * 256);
  return `198.${secondOctet}.${thirdOctet}.0/24`;
}

/**
 * `randomBenchmarkSubnet()` は 198.18.0.0/15 内の /24 を一様ランダムに
 * 選ぶだけなので、既存の docker network（並行実行中の別テストや、前回の
 * 異常終了で残った leftover）とサブネットが衝突する可能性がゼロではない。
 * 衝突時は `docker network create --subnet` がエラーになるだけでテスト
 * 全体が failure になってしまうため、衝突するたびに新しい乱数サブネットで
 * 数回だけ retry する。
 */
async function createBenchmarkNetworkWithRetry(
  name: string,
  maxAttempts = 5,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await dockerNetworkCreateWithSubnet(name, randomBenchmarkSubnet());
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`failed to create benchmark network ${name}: ${lastError}`);
}

/**
 * mitmproxy が転送してきた生の HTTP リクエストを1本受け取り、標準出力に
 * そのまま印字して 200 OK を返す python3 ワンショットサーバのスクリプト。
 * 標準出力は `docker logs` 経由でテストから読み取り、転送されたボディを
 * 検証するのに使う。
 *
 * `waitForContainerTcp` の readiness probe（バイトを送らずに接続して
 * すぐ閉じるだけの接続）が最初の `accept()` を消費してしまうと、単発
 * `accept()` のサーバでは probe を実リクエストと誤認して
 * `recv() == b""` で抜け、閉じられた peer に `sendall` して
 * `BrokenPipeError` で丸ごと落ちる。そのため accept はループで回し、
 * 完全な HTTP リクエスト（ヘッダ終端 + Content-Length 分のボディ）を
 * 受け取った接続だけに応答して、それを最後に終了する。
 */
function rawEchoServerScript(port: number): string {
  return [
    "import re, socket",
    "srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
    "srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
    `srv.bind(("0.0.0.0", ${port}))`,
    "srv.listen(8)",
    "while True:",
    "    conn, _ = srv.accept()",
    '    data = b""',
    "    complete = False",
    "    while True:",
    "        chunk = conn.recv(65536)",
    "        if not chunk:",
    "            break",
    "        data += chunk",
    '        sep = data.find(b"\\r\\n\\r\\n")',
    "        if sep == -1:",
    "            continue",
    '        headers = data[:sep].decode("latin1")',
    '        m = re.search(r"Content-Length:\\s*(\\d+)", headers, re.IGNORECASE)',
    "        body_len = int(m.group(1)) if m else 0",
    "        if len(data) - sep - 4 >= body_len:",
    "            complete = True",
    "            break",
    "    if complete:",
    '        print(data.decode("utf-8", "replace"), flush=True)',
    "        try:",
    '            conn.sendall(b"HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok")',
    "        finally:",
    "            conn.close()",
    "        break",
    "    conn.close()",
  ].join("\n");
}

/** fake broker: 常に allow + maskValues:["SECRET123"] を返す。 */
async function startAllowMaskBroker(socketPath: string): Promise<net.Server> {
  const broker = net.createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      socket.end(
        `${JSON.stringify({
          version: 1,
          type: "decision",
          requestId: request.requestId,
          decision: "allow",
          maskValues: ["SECRET123"],
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    broker.once("error", reject);
    broker.listen(socketPath, resolve);
  });
  return broker;
}

interface AnthropicFixture {
  runtimeDir: string;
  paths: Awaited<ReturnType<typeof resolveNetworkRuntimePaths>>;
  sessionId: string;
  token: string;
  broker: net.Server;
}

/**
 * `anthropicEgress: true` を書いたセッションレジストリ + fake broker
 * (allow + maskValues:["SECRET123"]) を用意する共通セットアップ。
 * 3つの anthropic 統合テストで共有する。
 */
async function setupAnthropicFixture(
  dirPrefix: string,
): Promise<AnthropicFixture> {
  const base = SHARED_TMP ?? "/tmp";
  const runtimeDir = await mkdtemp(path.join(base, dirPrefix));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const sessionId = `sess_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const token = "integration-token";
  const socketPath = brokerSocketPath(paths, sessionId);

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
    anthropicEgress: true,
  });
  await chmod(paths.sessionsDir, 0o755);
  await chmod(sessionRegistryPath(paths, sessionId), 0o644);

  const broker = await startAllowMaskBroker(socketPath);
  await chmod(socketPath, 0o666);

  return { runtimeDir, paths, sessionId, token, broker };
}

test.skipIf(!dockerAvailable || !canBindMount)(
  "nas_addon: DNS resolving to host gateway is blocked before connect",
  async () => {
    const base = SHARED_TMP ?? "/tmp";
    const runtimeDir = await mkdtemp(path.join(base, "nas-addon-dns-"));
    const containerName = `nas-addon-test-${crypto.randomUUID().slice(0, 8)}`;
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
      await waitForContainerTcp(containerName, 8080);
      await waitForTcp(proxyPort);

      const response = await sendProxyRequest(
        proxyPort,
        `http://rebind.test:${targetPort}/`,
        `${sessionId}:${token}`,
      );
      const logs = await dockerLogs(containerName);

      expect(response).toContain("502 Bad Gateway");
      expect(response).toContain("all resolved upstream IPs were denied");
      expect(hostConnections).toEqual(0);
      expect(logs).toContain("DNS-BLOCKED");
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      if (broker?.listening) await closeServer(broker);
      if (target?.listening) await closeServer(target);
      await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    }
  },
  60_000,
);

const ANTHROPIC_TARGET_PORT = 8090;

test.skipIf(!dockerAvailable || !canBindMount)(
  "anthropic /v1/messages: masks secret in JSON body before forwarding",
  async () => {
    // `api.anthropic.com` を denied-IP 判定に引っかからない upstream に
    // 向けるため、専用の docker network を RFC2544 ベンチマーク予約範囲
    // (198.18.0.0/15 の中からランダムな /24) で作り、fake upstream
    // コンテナをそこに static に置く。--add-host で host-gateway (private
    // range = denied) にマップする既存 DNS ブロックテストの手法は使えない
    // ため、ここだけ別経路を取る。
    const networkName = `nas-addon-net-${crypto.randomUUID().slice(0, 8)}`;
    const containerName = `nas-addon-test-${crypto.randomUUID().slice(0, 8)}`;
    const targetName = `nas-addon-upstream-${crypto.randomUUID().slice(0, 8)}`;
    let fixture: AnthropicFixture | undefined;
    let networkCreated = false;

    try {
      fixture = await setupAnthropicFixture("nas-addon-mask-");
      const { runtimeDir, sessionId, token } = fixture;

      // 衝突時は新しい乱数サブネットで数回だけ retry する
      // (createBenchmarkNetworkWithRetry 参照)。作成に成功した
      // networkName のみ finally で cleanup する。
      await createBenchmarkNetworkWithRetry(networkName);
      networkCreated = true;

      await dockerRunDetached({
        name: targetName,
        image: "mitmproxy/mitmproxy:11",
        args: [],
        envVars: {},
        network: networkName,
        entrypoint: "python3",
        command: ["-c", rawEchoServerScript(ANTHROPIC_TARGET_PORT)],
      });
      await waitForContainerTcp(targetName, ANTHROPIC_TARGET_PORT);
      const targetIp = await dockerContainerIpOnNetwork(
        targetName,
        networkName,
      );
      if (!targetIp) {
        throw new Error(
          `could not determine ${targetName} IP on network ${networkName}`,
        );
      }

      await dockerRunDetached({
        name: containerName,
        image: "mitmproxy/mitmproxy:11",
        args: [`--add-host=api.anthropic.com:${targetIp}`],
        envVars: {},
        network: networkName,
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
      await waitForContainerTcp(containerName, 8080);
      await waitForTcp(proxyPort);

      const requestBody = JSON.stringify({
        model: "claude-opus-4-8",
        messages: [
          { role: "user", content: [{ type: "text", text: "k=SECRET123" }] },
        ],
      });
      const response = await sendProxyRequest(
        proxyPort,
        `http://api.anthropic.com:${ANTHROPIC_TARGET_PORT}/v1/messages`,
        `${sessionId}:${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
        },
      );
      const upstreamLogs = await dockerLogs(targetName);

      expect(response).toContain("200 OK");
      expect(upstreamLogs).not.toContain("SECRET123");
      expect(upstreamLogs).toContain("****");
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      await dockerStop(targetName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(targetName).catch(() => {});
      if (networkCreated) {
        await dockerNetworkRemove(networkName).catch(() => {});
      }
      if (fixture?.broker.listening) await closeServer(fixture.broker);
      if (fixture) {
        await rm(fixture.runtimeDir, { recursive: true, force: true }).catch(
          () => {},
        );
      }
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "anthropic: unknown content block type is failed closed (403)",
  async () => {
    // 未知の content block type は request() 内の schema チェックで
    // upstream への connect より前に 403 を返すため、fake upstream や
    // DNS 到達性は不要（既存の DNS ブロックテストと違い target server 自体
    // を用意する必要がない）。
    const containerName = `nas-addon-test-${crypto.randomUUID().slice(0, 8)}`;
    let fixture: AnthropicFixture | undefined;

    try {
      fixture = await setupAnthropicFixture("nas-addon-block-type-");
      const { runtimeDir, sessionId, token } = fixture;

      await dockerRunDetached({
        name: containerName,
        image: "mitmproxy/mitmproxy:11",
        args: [],
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
      await waitForContainerTcp(containerName, 8080);
      await waitForTcp(proxyPort);

      const requestBody = JSON.stringify({
        model: "claude-opus-4-8",
        messages: [
          { role: "user", content: [{ type: "quantum_payload", data: "x" }] },
        ],
      });
      const response = await sendProxyRequest(
        proxyPort,
        "http://api.anthropic.com/v1/messages",
        `${sessionId}:${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
        },
      );

      expect(response).toContain("403");
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      if (fixture?.broker.listening) await closeServer(fixture.broker);
      if (fixture) {
        await rm(fixture.runtimeDir, { recursive: true, force: true }).catch(
          () => {},
        );
      }
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "anthropic: unknown path is failed closed (403)",
  async () => {
    // /v1/files は allowlist にない未知パスなので、これも upstream connect
    // より前に 403 で fail-closed する（target server 不要）。
    const containerName = `nas-addon-test-${crypto.randomUUID().slice(0, 8)}`;
    let fixture: AnthropicFixture | undefined;

    try {
      fixture = await setupAnthropicFixture("nas-addon-unknown-path-");
      const { runtimeDir, sessionId, token } = fixture;

      await dockerRunDetached({
        name: containerName,
        image: "mitmproxy/mitmproxy:11",
        args: [],
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
      await waitForContainerTcp(containerName, 8080);
      await waitForTcp(proxyPort);

      const response = await sendProxyRequest(
        proxyPort,
        "http://api.anthropic.com/v1/files",
        `${sessionId}:${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );

      expect(response).toContain("403");
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      if (fixture?.broker.listening) await closeServer(fixture.broker);
      if (fixture) {
        await rm(fixture.runtimeDir, { recursive: true, force: true }).catch(
          () => {},
        );
      }
    }
  },
  60_000,
);
