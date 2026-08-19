import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { queryAuditLogs } from "../../audit/store.ts";
import type { ResolvedDocument } from "../../network/authz/resolve.ts";
import {
  documentWithScopes,
  resolvedDocument,
} from "../../network/authz/testing.ts";
import { SessionBroker, sendBrokerRequest } from "../../network/broker.ts";
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
 * 選ぶ。実在サービスへは絶対にルーティングされない予約範囲なので、
 * 使い捨て docker network の upstream アドレスとして安全に割り当てられる。
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

function webSocketEchoServerScript(port: number): string {
  return [
    "import base64, hashlib, socket",
    "def recv_exact(conn, size):",
    '    data = b""',
    "    while len(data) < size:",
    "        chunk = conn.recv(size - len(data))",
    "        if not chunk:",
    "            return None",
    "        data += chunk",
    "    return data",
    "srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
    "srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
    `srv.bind(("0.0.0.0", ${port}))`,
    "srv.listen(8)",
    "while True:",
    "    conn, _ = srv.accept()",
    `    conn.settimeout(${WEBSOCKET_TARGET_IDLE_TIMEOUT_SECONDS})`,
    '    request = b""',
    "    try:",
    '        while b"\\r\\n\\r\\n" not in request and len(request) <= 16384:',
    "            chunk = conn.recv(4096)",
    "            if not chunk:",
    "                break",
    "            request += chunk",
    '        if b"\\r\\n\\r\\n" not in request:',
    "            conn.close()",
    "            continue",
    '        lines = request.split(b"\\r\\n\\r\\n", 1)[0].decode("latin1").split("\\r\\n")',
    '        headers = {line.split(":", 1)[0].strip().lower(): line.split(":", 1)[1].strip() for line in lines[1:] if ":" in line}',
    '        key = headers.get("sec-websocket-key")',
    '        if headers.get("upgrade", "").lower() != "websocket" or not key:',
    "            conn.close()",
    "            continue",
    '        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()',
    '        conn.sendall(("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n").encode())',
    '        print("HANDSHAKE", flush=True)',
    "        while True:",
    "            head = recv_exact(conn, 2)",
    "            if head is None:",
    "                break",
    "            if head[0] != 0x81 or not (head[1] & 0x80) or (head[1] & 0x7f) > 125:",
    "                break",
    "            length = head[1] & 0x7f",
    "            mask = recv_exact(conn, 4)",
    "            payload = recv_exact(conn, length)",
    "            if mask is None or payload is None:",
    "                break",
    "            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))",
    '            print("MESSAGE " + payload.decode("utf-8", "replace"), flush=True)',
    "            conn.sendall(bytes((0x81, len(payload))) + payload)",
    "    except (OSError, ValueError):",
    "        pass",
    "    finally:",
    "        conn.close()",
  ].join("\n");
}

function rawByteServerScript(port: number): string {
  return [
    "import socket",
    "srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
    "srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
    `srv.bind(("0.0.0.0", ${port}))`,
    "srv.listen(8)",
    "while True:",
    "    conn, _ = srv.accept()",
    "    conn.settimeout(5)",
    "    try:",
    "        data = conn.recv(65536)",
    "        if data:",
    '            print(data.decode("utf-8", "replace"), flush=True)',
    '            conn.sendall(b"RAW-ECHO:" + data)',
    "    except OSError:",
    "        pass",
    "    finally:",
    "        conn.close()",
  ].join("\n");
}

class BoundedSocketReader {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private readonly waiters = new Set<() => void>();

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.wake();
  };
  private readonly onEnd = (): void => {
    this.ended = true;
    this.wake();
  };

  constructor(private readonly socket: net.Socket) {
    socket.on("data", this.onData);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
    socket.on("error", this.onEnd);
  }

  async readUntil(delimiter: Buffer, maxBytes: number): Promise<Buffer> {
    const deadline = Date.now() + 5_000;
    while (true) {
      const index = this.buffer.indexOf(delimiter);
      if (index !== -1) {
        const end = index + delimiter.length;
        const result = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        return result;
      }
      if (this.buffer.length > maxBytes) {
        throw new Error("socket response exceeded test limit");
      }
      await this.waitForData(deadline);
    }
  }

  async readExact(length: number): Promise<Buffer> {
    const deadline = Date.now() + 5_000;
    while (this.buffer.length < length) {
      await this.waitForData(deadline);
    }
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }

  dispose(): void {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onEnd);
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  private async waitForData(deadline: number): Promise<void> {
    if (this.ended) throw new Error("socket closed before read completed");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("timed out waiting for socket data");
    await new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        reject(new Error("timed out waiting for socket data"));
      }, remaining);
      this.waiters.add(wake);
    });
  }
}

function encodeClientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length > 125) throw new Error("test frame exceeds 125 bytes");
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  Buffer.from(mask).copy(frame, 2);
  for (let i = 0; i < payload.length; i++) {
    frame[6 + i] = payload[i]! ^ mask[i % 4]!;
  }
  return frame;
}

interface ProxyWebSocket {
  socket: net.Socket;
  responseHeaders: string;
  sendText(text: string): void;
  readText(): Promise<string>;
  close(): void;
}

async function openWebSocketThroughProxy(
  proxyPort: number,
  targetUrl: string,
  credentials: string,
): Promise<ProxyWebSocket> {
  const target = new URL(targetUrl);
  const socket = net.createConnection({ host: "127.0.0.1", port: proxyPort });
  const reader = new BoundedSocketReader(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out connecting to proxy"));
    }, 5_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new Error("failed to connect to proxy"));
    });
  });
  socket.write(
    [
      `GET ${targetUrl} HTTP/1.1`,
      `Host: ${target.host}`,
      `Proxy-Authorization: Basic ${btoa(credentials)}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "",
      "",
    ].join("\r\n"),
  );
  const responseHeaders = (
    await reader.readUntil(Buffer.from("\r\n\r\n"), 32_768)
  ).toString("latin1");
  const upgraded = /^HTTP\/1\.[01] 101\b/.test(responseHeaders);
  if (!upgraded) socket.destroy();

  return {
    socket,
    responseHeaders,
    sendText(text: string): void {
      if (!upgraded || socket.destroyed) {
        throw new Error("WebSocket is not open");
      }
      socket.write(encodeClientTextFrame(text));
    },
    async readText(): Promise<string> {
      if (!upgraded) throw new Error("WebSocket upgrade was rejected");
      const head = await reader.readExact(2);
      if (head[0] !== 0x81) {
        throw new Error("expected a complete text WebSocket frame");
      }
      if ((head[1]! & 0x80) !== 0) {
        throw new Error("server WebSocket frame must be unmasked");
      }
      const length = head[1]! & 0x7f;
      if (length > 125) {
        throw new Error("server WebSocket frame used an extended length");
      }
      return (await reader.readExact(length)).toString("utf8");
    },
    close(): void {
      reader.dispose();
      socket.destroy();
    },
  };
}

async function expectNoWebSocketEcho(websocket: ProxyWebSocket): Promise<void> {
  await expect(websocket.readText()).rejects.toThrow(
    "timed out waiting for socket data",
  );
}

async function openConnectTunnel(
  proxyPort: number,
  target: string,
  credentials: string,
): Promise<net.Socket> {
  const socket = net.createConnection({ host: "127.0.0.1", port: proxyPort });
  const reader = new BoundedSocketReader(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out connecting to proxy"));
    }, 5_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new Error("failed to connect to proxy"));
    });
  });
  socket.write(
    [
      `CONNECT ${target} HTTP/1.1`,
      `Host: ${target}`,
      `Proxy-Authorization: Basic ${btoa(credentials)}`,
      "",
      "",
    ].join("\r\n"),
  );
  const responseHeaders = (
    await reader.readUntil(Buffer.from("\r\n\r\n"), 32_768)
  ).toString("latin1");
  reader.dispose();
  socket.on("error", () => {});
  if (!/^HTTP\/1\.[01] 200\b/.test(responseHeaders)) {
    socket.destroy();
    throw new Error("CONNECT tunnel was rejected");
  }
  return socket;
}

interface ProtocolResources {
  networkName: string;
  proxyName: string;
  targetName: string;
  networkCreated: boolean;
}

function protocolResources(prefix: string): ProtocolResources {
  const suffix = crypto.randomUUID().slice(0, 8);
  return {
    networkName: `${prefix}-net-${suffix}`,
    proxyName: `${prefix}-proxy-${suffix}`,
    targetName: `${prefix}-target-${suffix}`,
    networkCreated: false,
  };
}

async function startProtocolContainers(
  resources: ProtocolResources,
  fixture: AddonFixture,
  targetHost: string,
  targetPort: number,
  targetScript: string,
): Promise<number> {
  await createBenchmarkNetworkWithRetry(resources.networkName);
  resources.networkCreated = true;
  await dockerRunDetached({
    name: resources.targetName,
    image: "mitmproxy/mitmproxy:11",
    args: [],
    envVars: {},
    network: resources.networkName,
    entrypoint: "python3",
    command: ["-c", targetScript],
  });
  await waitForContainerTcp(resources.targetName, targetPort);
  const targetIp = await dockerContainerIpOnNetwork(
    resources.targetName,
    resources.networkName,
  );
  if (!targetIp) throw new Error("could not determine fake target IP");

  await dockerRunDetached({
    name: resources.proxyName,
    image: "mitmproxy/mitmproxy:11",
    args: [`--add-host=${targetHost}:${targetIp}`],
    envVars: {},
    network: resources.networkName,
    mounts: [
      { source: fixture.runtimeDir, target: "/nas-network", mode: "rw" },
    ],
    publishedPorts: ["127.0.0.1::8080"],
    command: [
      "mitmdump",
      "--mode",
      "regular@8080",
      "--set",
      "connection_strategy=lazy",
      "--set",
      "rawtcp=false",
      "--set",
      "websocket=true",
      "--set",
      "confdir=/nas-network/mitmproxy-ca",
      "--ssl-insecure",
      "-s",
      "/nas-network/nas_addon.py",
    ],
  });
  const proxyPort = await publishedPort(resources.proxyName);
  await waitForContainerTcp(resources.proxyName, 8080);
  await waitForTcp(proxyPort);
  return proxyPort;
}

async function cleanupProtocolResources(
  resources: ProtocolResources,
): Promise<void> {
  await dockerStop(resources.proxyName, { timeoutSeconds: 0 }).catch(() => {});
  await dockerRm(resources.proxyName).catch(() => {});
  await dockerStop(resources.targetName, { timeoutSeconds: 0 }).catch(() => {});
  await dockerRm(resources.targetName).catch(() => {});
  if (resources.networkCreated) {
    await dockerNetworkRemove(resources.networkName).catch(() => {});
  }
}

async function waitForPendingItem(fixture: AddonFixture) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pending = (await fixture.broker.listPending())[0];
    if (pending) return pending;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for pending WebSocket handshake");
}

async function waitForContainerLog(
  containerName: string,
  marker: string,
): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const logs = await dockerLogs(containerName);
    if (logs.includes(marker)) return logs;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for container log marker: ${marker}`);
}

/**
 * addon が読む解決済みドキュメントと、broker が権威として使うルールは
 * **同一の出荷物**でなければならない。片方だけを手書きすると、両者が
 * 食い違ったまま緑になり、ちょうどこのタスクが塞いだ穴 (broker が承認した
 * のとは別のポリシーが走る) を検出できなくなる。
 */
const RESOLVED_DOCUMENT = JSON.parse(
  readFileSync(
    new URL("../../network/fixtures/authz/anthropic-v1.json", import.meta.url),
    "utf8",
  ),
) as ResolvedDocument;

const DENIED_WEBSOCKET_DOCUMENT = documentWithScopes({
  chatgpt: {
    targets: ["chatgpt.test:8091"],
    rules: {
      ws: { match: { methods: ["GET"], paths: ["/ws"] }, onMatch: "allow" },
    },
  },
});

const REVIEWED_WEBSOCKET_DOCUMENT = documentWithScopes({
  chatgpt: {
    targets: ["chatgpt.test:8091"],
    webSocket: "allow",
    fallback: "deny",
    rules: {
      ws: {
        match: { methods: ["GET"], paths: ["/ws"] },
        onMatch: "review",
      },
    },
  },
});

const PROTECTED_WEBSOCKET_DOCUMENT = resolvedDocument({
  secrets: {
    masking: { from: "env:MASKING" },
    blocking: { from: "env:BLOCKING" },
  },
  mask: { proxy: true, apply: ["masking"] },
  network: {
    scopes: {
      chatgpt: {
        targets: ["chatgpt.test:8091"],
        webSocket: "allow",
        secrets: { masking: "mask", blocking: "forbid" },
        rules: {
          ws: {
            match: { methods: ["GET"], paths: ["/ws"] },
            onMatch: "allow",
            limits: { maxBodyBytes: 64 },
          },
        },
      },
    },
  },
});

interface AddonFixture {
  runtimeDir: string;
  auditDir: string;
  paths: Awaited<ReturnType<typeof resolveNetworkRuntimePaths>>;
  sessionId: string;
  token: string;
  broker: SessionBroker;
}

interface AddonFixtureSetupOptions {
  afterBrokerStarted?: (partial: {
    runtimeDir: string;
    broker: SessionBroker;
  }) => Promise<void>;
}

interface ExpectedPolicyOutcome {
  ruleId: string;
  requestPolicyResult: "pass" | "rewrite" | "block";
  reason: string;
}

/**
 * 監査ログから request-policy 行を1本だけ取り出して照合する。
 *
 * 結果を fake broker が受け取ったメッセージではなく監査から読むのは、
 * broker が addon の申告を鵜呑みにせず自分の解決済みルールから method や
 * route を導き直す設計になっているため。監査を見れば、その導出まで含めて
 * 期待どおりかを確認できる。
 */
/**
 * コンテナログのうち addon が書いた行だけを返す。mitmproxy 本体はどの要求に
 * ついても要求行をそのまま出すので、addon の出力を評価したいときに混ぜない。
 */
function addonLogLines(containerLogs: string): string {
  return containerLogs
    .split("\n")
    .filter((line) => line.includes("[nas-addon]"))
    .join("\n");
}

async function readPolicyOutcomes(
  auditDir: string,
): Promise<Record<string, unknown>[]> {
  const logs = await queryAuditLogs({ domain: "network" }, auditDir);
  return logs.filter(
    (entry) => entry.phase === "request-policy",
  ) as unknown as Record<string, unknown>[];
}

async function expectSinglePolicyOutcome(
  auditDir: string,
  expected: ExpectedPolicyOutcome,
  assertionName: string,
): Promise<Record<string, unknown>> {
  const logs = await queryAuditLogs({ domain: "network" }, auditDir);
  const outcomes = logs.filter((entry) => entry.phase === "request-policy");
  expect(outcomes, `${assertionName}: outcome count`).toHaveLength(1);
  const outcome = outcomes[0] as unknown as Record<string, unknown>;
  const authorizations = logs.filter(
    (entry) => entry.phase === "authorization",
  );
  expect(
    authorizations.length,
    `${assertionName}: authorization row`,
  ).toBeGreaterThan(0);
  expect(outcome.requestId, `${assertionName}: correlated requestId`).toBe(
    authorizations[0]?.requestId,
  );
  for (const [field, value] of Object.entries(expected)) {
    expect(outcome[field], `${assertionName}: ${field}`).toBe(value);
  }
  return outcome;
}

/**
 * セッションレジストリ + fake broker (allow + maskValues:["SECRET123"])
 * を用意する共通セットアップ。
 */
async function setupAddonFixture(
  dirPrefix: string,
  document: ResolvedDocument = RESOLVED_DOCUMENT,
  secretValues: Readonly<Record<string, readonly string[]>> = {
    workspace: ["SECRET123"],
  },
  options: AddonFixtureSetupOptions = {},
): Promise<AddonFixture> {
  const base = SHARED_TMP ?? "/tmp";
  const runtimeDir = await mkdtemp(path.join(base, dirPrefix));
  const auditDir = await mkdtemp(path.join(base, `${dirPrefix}audit-`));
  let broker: SessionBroker | undefined;

  try {
    const paths = await resolveNetworkRuntimePaths(runtimeDir);
    const sessionId = `sess_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const token = "integration-token";
    const socketPath = brokerSocketPath(paths, sessionId);

    await chmod(runtimeDir, 0o755);
    await chmod(paths.caCertDir, 0o777);
    await chmod(paths.brokersDir, 0o755);
    await chmod(paths.authzDir, 0o755);
    await mkdir(path.dirname(socketPath), { recursive: true });
    await chmod(path.dirname(socketPath), 0o755);
    await copyFile(
      new URL("./nas_addon.py", import.meta.url).pathname,
      paths.addonScriptPath,
    );
    await writeFile(
      `${paths.authzDir}/${sessionId}.json`,
      JSON.stringify(document),
    );
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

    broker = new SessionBroker({
      paths,
      sessionId,
      document,
      pendingTimeoutSeconds: 30,
      pendingNotify: "off",
      secretValues,
      auditDir,
    });
    await broker.start(socketPath);
    await options.afterBrokerStarted?.({ runtimeDir, broker });
    await chmod(socketPath, 0o666);

    return { runtimeDir, auditDir, paths, sessionId, token, broker };
  } catch (error) {
    await broker?.close().catch(() => {});
    await Promise.allSettled([
      rm(runtimeDir, { recursive: true, force: true }),
      rm(auditDir, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

/** テスト終了時のフィクスチャ解体。broker を閉じ、一時ディレクトリを消す。 */
async function teardownFixture(fixture?: AddonFixture): Promise<void> {
  if (!fixture) return;
  await fixture.broker.close().catch(() => {});
  await rm(fixture.runtimeDir, { recursive: true, force: true }).catch(
    () => {},
  );
  await rm(fixture.auditDir, { recursive: true, force: true }).catch(() => {});
}

test("setupAddonFixture cleans partial state when setup fails after broker start", async () => {
  const setupError = new Error("injected post-broker setup failure");
  let partial: { runtimeDir: string; broker: SessionBroker } | undefined;
  let thrown: unknown;

  try {
    try {
      await setupAddonFixture(
        "nas-addon-partial-setup-",
        RESOLVED_DOCUMENT,
        { workspace: ["SECRET123"] },
        {
          afterBrokerStarted: async (state) => {
            partial = state;
            throw setupError;
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(setupError);
    expect(partial).toBeDefined();
    expect(existsSync(partial?.runtimeDir ?? "")).toBe(false);
  } finally {
    if (partial) {
      await partial.broker.close().catch(() => {});
      await rm(partial.runtimeDir, { recursive: true, force: true });
    }
  }
});

test("setupAddonFixture installs the shipped resolved document", async () => {
  const fixture = await setupAddonFixture("nas-addon-review-rule-");
  try {
    const document = await Bun.file(
      `${fixture.paths.authzDir}/${fixture.sessionId}.json`,
    ).json();

    // addon が読むファイルと broker が握るルールが同一であることが、
    // このスイートの前提そのもの。
    expect(document).toEqual(RESOLVED_DOCUMENT);
    expect(document.contractVersion).toBe(1);
  } finally {
    await teardownFixture(fixture);
  }
});

const WEBSOCKET_TARGET_PORT = 8091;
const RAW_TARGET_PORT = 8092;
const WEBSOCKET_TARGET_IDLE_TIMEOUT_SECONDS = 15;

test.skipIf(!dockerAvailable || !canBindMount)(
  "websocket: default-denied scope returns 403 before upstream handshake",
  async () => {
    const resources = protocolResources("nas-ws-denied");
    let fixture: AddonFixture | undefined;
    let websocket: ProxyWebSocket | undefined;
    try {
      fixture = await setupAddonFixture(
        "nas-addon-ws-denied-",
        DENIED_WEBSOCKET_DOCUMENT,
        {},
      );
      const proxyPort = await startProtocolContainers(
        resources,
        fixture,
        "chatgpt.test",
        WEBSOCKET_TARGET_PORT,
        webSocketEchoServerScript(WEBSOCKET_TARGET_PORT),
      );

      websocket = await openWebSocketThroughProxy(
        proxyPort,
        `http://chatgpt.test:${WEBSOCKET_TARGET_PORT}/ws`,
        `${fixture.sessionId}:${fixture.token}`,
      );

      expect(websocket.responseHeaders).toContain(" 403 ");
      expect(await fixture.broker.listPending()).toEqual([]);
      const upstreamLogs = await dockerLogs(resources.targetName);
      expect(upstreamLogs.includes("HANDSHAKE")).toBe(false);
    } finally {
      websocket?.close();
      await cleanupProtocolResources(resources);
      await teardownFixture(fixture);
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "websocket: one handshake approval releases multiple messages without another pending item",
  async () => {
    const resources = protocolResources("nas-ws-review");
    let fixture: AddonFixture | undefined;
    let websocket: ProxyWebSocket | undefined;
    try {
      fixture = await setupAddonFixture(
        "nas-addon-ws-review-",
        REVIEWED_WEBSOCKET_DOCUMENT,
        {},
      );
      const proxyPort = await startProtocolContainers(
        resources,
        fixture,
        "chatgpt.test",
        WEBSOCKET_TARGET_PORT,
        webSocketEchoServerScript(WEBSOCKET_TARGET_PORT),
      );

      const websocketPromise = openWebSocketThroughProxy(
        proxyPort,
        `http://chatgpt.test:${WEBSOCKET_TARGET_PORT}/ws`,
        `${fixture.sessionId}:${fixture.token}`,
      );
      const pending = await waitForPendingItem(fixture);
      expect(await fixture.broker.listPending()).toHaveLength(1);
      await sendBrokerRequest(
        brokerSocketPath(fixture.paths, fixture.sessionId),
        { type: "approve", requestId: pending.requestId, scope: "once" },
      );
      websocket = await websocketPromise;

      expect(websocket.responseHeaders).toContain(" 101 ");
      websocket.sendText("first-message");
      expect(await websocket.readText()).toBe("first-message");
      websocket.sendText("second-message");
      expect(await websocket.readText()).toBe("second-message");
      expect(await fixture.broker.listPending()).toEqual([]);
      const upstreamLogs = await waitForContainerLog(
        resources.targetName,
        "MESSAGE second-message",
      );
      expect(upstreamLogs.match(/^HANDSHAKE$/gm)).toHaveLength(1);
      expect(upstreamLogs.match(/^MESSAGE /gm)).toHaveLength(2);
    } finally {
      websocket?.close();
      await cleanupProtocolResources(resources);
      await teardownFixture(fixture);
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "websocket: masks an authorized client message before upstream echo",
  async () => {
    const resources = protocolResources("nas-ws-mask");
    const maskingSecret = "MASKME123";
    let fixture: AddonFixture | undefined;
    let websocket: ProxyWebSocket | undefined;
    try {
      fixture = await setupAddonFixture(
        "nas-addon-ws-mask-",
        PROTECTED_WEBSOCKET_DOCUMENT,
        { masking: [maskingSecret], blocking: ["BLOCKME123"] },
      );
      const proxyPort = await startProtocolContainers(
        resources,
        fixture,
        "chatgpt.test",
        WEBSOCKET_TARGET_PORT,
        webSocketEchoServerScript(WEBSOCKET_TARGET_PORT),
      );
      websocket = await openWebSocketThroughProxy(
        proxyPort,
        `http://chatgpt.test:${WEBSOCKET_TARGET_PORT}/ws`,
        `${fixture.sessionId}:${fixture.token}`,
      );

      expect(websocket.responseHeaders).toContain(" 101 ");
      websocket.sendText(`hello ${maskingSecret}`);
      const echoed = await websocket.readText();
      expect(echoed === "hello ****").toBe(true);
      expect(echoed.includes(maskingSecret)).toBe(false);
      const upstreamLogs = await waitForContainerLog(
        resources.targetName,
        "MESSAGE hello ****",
      );
      const proxyLogs = await dockerLogs(resources.proxyName);
      expect(upstreamLogs.includes(maskingSecret)).toBe(false);
      expect(addonLogLines(proxyLogs).includes(maskingSecret)).toBe(false);
    } finally {
      websocket?.close();
      await cleanupProtocolResources(resources);
      await teardownFixture(fixture);
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "websocket: forbidden secret is never delivered and leaves the session fail-closed",
  async () => {
    const resources = protocolResources("nas-ws-forbid");
    const blockingSecret = "BLOCKME123";
    let fixture: AddonFixture | undefined;
    let websocket: ProxyWebSocket | undefined;
    try {
      fixture = await setupAddonFixture(
        "nas-addon-ws-forbid-",
        PROTECTED_WEBSOCKET_DOCUMENT,
        { masking: ["MASKME123"], blocking: [blockingSecret] },
      );
      const proxyPort = await startProtocolContainers(
        resources,
        fixture,
        "chatgpt.test",
        WEBSOCKET_TARGET_PORT,
        webSocketEchoServerScript(WEBSOCKET_TARGET_PORT),
      );
      websocket = await openWebSocketThroughProxy(
        proxyPort,
        `http://chatgpt.test:${WEBSOCKET_TARGET_PORT}/ws`,
        `${fixture.sessionId}:${fixture.token}`,
      );

      expect(websocket.responseHeaders).toContain(" 101 ");
      await waitForContainerLog(resources.targetName, "HANDSHAKE");
      websocket.sendText(blockingSecret);
      await waitForContainerLog(resources.proxyName, "reason=forbidden-secret");
      await expectNoWebSocketEcho(websocket);
      let upstreamLogs = await dockerLogs(resources.targetName);
      const proxyLogs = await dockerLogs(resources.proxyName);
      expect(upstreamLogs.includes("HANDSHAKE")).toBe(true);
      expect(upstreamLogs.includes("MESSAGE ")).toBe(false);
      expect(upstreamLogs.includes(blockingSecret)).toBe(false);
      expect(addonLogLines(proxyLogs).includes(blockingSecret)).toBe(false);

      websocket.sendText("benign-after-forbidden");
      await waitForContainerLog(resources.proxyName, "reason=missing-state");
      await expectNoWebSocketEcho(websocket);
      upstreamLogs = await dockerLogs(resources.targetName);
      expect(upstreamLogs.includes("MESSAGE benign-after-forbidden")).toBe(
        false,
      );
    } finally {
      websocket?.close();
      await cleanupProtocolResources(resources);
      await teardownFixture(fixture);
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "websocket: over-budget message is never delivered and leaves the session fail-closed",
  async () => {
    const resources = protocolResources("nas-ws-budget");
    let fixture: AddonFixture | undefined;
    let websocket: ProxyWebSocket | undefined;
    try {
      fixture = await setupAddonFixture(
        "nas-addon-ws-budget-",
        PROTECTED_WEBSOCKET_DOCUMENT,
        { masking: ["MASKME123"], blocking: ["BLOCKME123"] },
      );
      const proxyPort = await startProtocolContainers(
        resources,
        fixture,
        "chatgpt.test",
        WEBSOCKET_TARGET_PORT,
        webSocketEchoServerScript(WEBSOCKET_TARGET_PORT),
      );
      websocket = await openWebSocketThroughProxy(
        proxyPort,
        `http://chatgpt.test:${WEBSOCKET_TARGET_PORT}/ws`,
        `${fixture.sessionId}:${fixture.token}`,
      );

      expect(websocket.responseHeaders).toContain(" 101 ");
      await waitForContainerLog(resources.targetName, "HANDSHAKE");
      websocket.sendText("x".repeat(65));
      await waitForContainerLog(resources.proxyName, "reason=resource-limit");
      await expectNoWebSocketEcho(websocket);
      let upstreamLogs = await dockerLogs(resources.targetName);
      expect(upstreamLogs.includes("HANDSHAKE")).toBe(true);
      expect(upstreamLogs.includes("MESSAGE ")).toBe(false);

      websocket.sendText("benign-after-budget");
      await waitForContainerLog(resources.proxyName, "reason=missing-state");
      await expectNoWebSocketEcho(websocket);
      upstreamLogs = await dockerLogs(resources.targetName);
      expect(upstreamLogs.includes("MESSAGE benign-after-budget")).toBe(false);
    } finally {
      websocket?.close();
      await cleanupProtocolResources(resources);
      await teardownFixture(fixture);
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "websocket: stale session message is never delivered and leaves the session fail-closed",
  async () => {
    const resources = protocolResources("nas-ws-stale");
    let fixture: AddonFixture | undefined;
    let websocket: ProxyWebSocket | undefined;
    try {
      fixture = await setupAddonFixture(
        "nas-addon-ws-stale-",
        PROTECTED_WEBSOCKET_DOCUMENT,
        { masking: ["MASKME123"], blocking: ["BLOCKME123"] },
      );
      const proxyPort = await startProtocolContainers(
        resources,
        fixture,
        "chatgpt.test",
        WEBSOCKET_TARGET_PORT,
        webSocketEchoServerScript(WEBSOCKET_TARGET_PORT),
      );
      websocket = await openWebSocketThroughProxy(
        proxyPort,
        `http://chatgpt.test:${WEBSOCKET_TARGET_PORT}/ws`,
        `${fixture.sessionId}:${fixture.token}`,
      );

      expect(websocket.responseHeaders).toContain(" 101 ");
      await waitForContainerLog(resources.targetName, "HANDSHAKE");
      await rm(sessionRegistryPath(fixture.paths, fixture.sessionId), {
        force: true,
      });
      websocket.sendText("after-session-expiry");
      await waitForContainerLog(resources.proxyName, "reason=stale-session");
      await expectNoWebSocketEcho(websocket);
      let upstreamLogs = await dockerLogs(resources.targetName);
      expect(upstreamLogs.includes("HANDSHAKE")).toBe(true);
      expect(upstreamLogs.includes("MESSAGE ")).toBe(false);

      websocket.sendText("benign-after-stale-session");
      await waitForContainerLog(resources.proxyName, "reason=missing-state");
      await expectNoWebSocketEcho(websocket);
      upstreamLogs = await dockerLogs(resources.targetName);
      expect(upstreamLogs.includes("MESSAGE benign-after-stale-session")).toBe(
        false,
      );
    } finally {
      websocket?.close();
      await cleanupProtocolResources(resources);
      await teardownFixture(fixture);
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "raw CONNECT: authenticated non-HTTP bytes never reach upstream",
  async () => {
    const resources = protocolResources("nas-raw-connect");
    let fixture: AddonFixture | undefined;
    let tunnel: net.Socket | undefined;
    try {
      fixture = await setupAddonFixture("nas-addon-raw-connect-");
      const proxyPort = await startProtocolContainers(
        resources,
        fixture,
        "raw.test",
        RAW_TARGET_PORT,
        rawByteServerScript(RAW_TARGET_PORT),
      );

      tunnel = await openConnectTunnel(
        proxyPort,
        `raw.test:${RAW_TARGET_PORT}`,
        `${fixture.sessionId}:${fixture.token}`,
      );
      let responseBytes = 0;
      tunnel.on("data", (chunk) => {
        responseBytes += chunk.length;
      });
      tunnel.write("SSH-2.0-nas-raw-probe\r\n");
      await Bun.sleep(2_000);
      const upstreamLogs = await dockerLogs(resources.targetName);
      expect(upstreamLogs.includes("nas-raw-probe")).toBe(false);
      expect(responseBytes).toBe(0);
    } finally {
      tunnel?.destroy();
      await cleanupProtocolResources(resources);
      await teardownFixture(fixture);
    }
  },
  60_000,
);

const ANTHROPIC_TARGET_PORT = 8090;

test.skipIf(!dockerAvailable || !canBindMount)(
  "anthropic bodyless GET: masks URL and headers before forwarding",
  async () => {
    const networkName = `nas-addon-net-${crypto.randomUUID().slice(0, 8)}`;
    const containerName = `nas-addon-test-${crypto.randomUUID().slice(0, 8)}`;
    const targetName = `nas-addon-upstream-${crypto.randomUUID().slice(0, 8)}`;
    let fixture: AddonFixture | undefined;
    let networkCreated = false;

    try {
      fixture = await setupAddonFixture("nas-addon-bodyless-");
      const { runtimeDir, sessionId, token } = fixture;

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
          "rawtcp=false",
          "--set",
          "websocket=true",
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
        `http://api.anthropic.com:${ANTHROPIC_TARGET_PORT}/api/claude_cli/bootstrap?entrypoint=cli&model=SECRET123`,
        `${sessionId}:${token}`,
        { headers: { "X-Test-Secret": "SECRET123" } },
      );
      const upstreamLogs = await dockerLogs(targetName);
      const proxyLogs = await dockerLogs(containerName);
      const outcome = await expectSinglePolicyOutcome(
        fixture.auditDir,
        {
          ruleId: "anthropic.bootstrap",
          requestPolicyResult: "pass",
          reason: "empty-body",
        },
        "bodyless GET",
      );

      expect(response).toContain("200 OK");
      expect(upstreamLogs).not.toContain("SECRET123");
      expect(upstreamLogs).toContain(
        "GET /api/claude_cli/bootstrap?entrypoint=cli&model=**** HTTP/1.1",
      );
      expect(upstreamLogs.toLowerCase()).toContain("x-test-secret: ****");
      // bodyless ポリシーなのでヘッダ終端の後ろに何も続いてはならない。
      // 「終端で終わる」ことを正規表現で見てはいけない: dockerLogs は末尾を
      // trim するので \r\n\r\n 自体が消え、ボディが**ある**ときだけ通る反転
      // した条件になる。終端より後ろに残るバイトを見る。
      const [, ...afterHeaders] = upstreamLogs.split("\r\n\r\n");
      expect(afterHeaders.join("\r\n\r\n").trim()).toBe("");
      expect(JSON.stringify(outcome)).not.toContain("SECRET123");
      expect(proxyLogs).not.toContain(
        "request policy outcome audit unavailable",
      );
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      await dockerStop(targetName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(targetName).catch(() => {});
      if (networkCreated) {
        await dockerNetworkRemove(networkName).catch(() => {});
      }
      await teardownFixture(fixture);
    }
  },
  60_000,
);

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
    let fixture: AddonFixture | undefined;
    let networkCreated = false;

    try {
      fixture = await setupAddonFixture("nas-addon-mask-");
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
          "rawtcp=false",
          "--set",
          "websocket=true",
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
      const outcome = await expectSinglePolicyOutcome(
        fixture.auditDir,
        {
          ruleId: "anthropic.messages",
          requestPolicyResult: "rewrite",
          reason: "masked-json",
        },
        "messages forwarding",
      );

      expect(response).toContain("200 OK");
      expect(upstreamLogs).not.toContain("SECRET123");
      expect(upstreamLogs).toContain("****");
      expect(JSON.stringify(outcome)).not.toContain("SECRET123");
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      await dockerStop(targetName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(targetName).catch(() => {});
      if (networkCreated) {
        await dockerNetworkRemove(networkName).catch(() => {});
      }
      await teardownFixture(fixture);
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "anthropic: unknown content block is held for review and denied closed",
  async () => {
    // 未知の content block type は upstream connect より前に review へ回る。
    // 明示的に deny するまで応答が保留され、deny 後は 403 で閉じることを確認する。
    // fake upstream や DNS 到達性は不要。
    const containerName = `nas-addon-test-${crypto.randomUUID().slice(0, 8)}`;
    let fixture: AddonFixture | undefined;

    try {
      fixture = await setupAddonFixture("nas-addon-block-type-");
      const { runtimeDir, sessionId, token } = fixture;

      await dockerRunDetached({
        name: containerName,
        image: "mitmproxy/mitmproxy:11",
        // containment backstop: 正しい実装では 403 は request() 内で
        // upstream connect より前に返るのでこの mapping は参照されない。
        // fail-closed ロジックが regress した場合でも、実在の
        // api.anthropic.com には絶対に届かせず、loopback (denied range)
        // でローカルに失敗させる。
        args: ["--add-host=api.anthropic.com:127.0.0.1"],
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
          "rawtcp=false",
          "--set",
          "websocket=true",
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
      const responsePromise = sendProxyRequest(
        proxyPort,
        "http://api.anthropic.com/v1/messages",
        `${sessionId}:${token}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
        },
      );

      const pendingDeadline = Date.now() + 5_000;
      let pending = (await fixture.broker.listPending())[0];
      while (!pending && Date.now() < pendingDeadline) {
        await Bun.sleep(25);
        pending = (await fixture.broker.listPending())[0];
      }
      expect(pending).toMatchObject({
        ruleId: "anthropic.messages",
        state: "pending",
        violations: [{ value: "quantum_payload" }],
      });

      await sendBrokerRequest(
        brokerSocketPath(fixture.paths, fixture.sessionId),
        { type: "deny", requestId: pending!.requestId },
      );
      const response = await responsePromise;
      const outcomes = await readPolicyOutcomes(fixture.auditDir);
      expect(outcomes).toHaveLength(2);
      const deniedReview = outcomes.find(
        (entry) => entry.requestPolicyResult === undefined,
      );
      const blockedOutcome = outcomes.find(
        (entry) => entry.requestPolicyResult === "block",
      );
      expect(deniedReview).toMatchObject({
        ruleId: "anthropic.messages",
        decision: "deny",
        reason: "denied-by-user",
      });
      expect(blockedOutcome).toMatchObject({
        ruleId: "anthropic.messages",
        decision: "deny",
        requestPolicyResult: "block",
        reason: "violations-denied",
      });
      expect(blockedOutcome?.requestId).toBe(deniedReview?.requestId);

      expect(response).toContain("403");
      expect(JSON.stringify(outcomes)).not.toContain("SECRET123");
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      await teardownFixture(fixture);
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable || !canBindMount)(
  "anthropic: blocked endpoint policy is enforced before upstream connect",
  async () => {
    const containerName = `nas-addon-test-${crypto.randomUUID().slice(0, 8)}`;
    let fixture: AddonFixture | undefined;

    try {
      fixture = await setupAddonFixture("nas-addon-blocked-policy-");
      const { runtimeDir, sessionId, token } = fixture;

      await dockerRunDetached({
        name: containerName,
        image: "mitmproxy/mitmproxy:11",
        // containment backstop: 正しい実装では 403 は request() 内で
        // upstream connect より前に返るのでこの mapping は参照されない。
        // fail-closed ロジックが regress した場合でも、実在の
        // api.anthropic.com には絶対に届かせず、loopback (denied range)
        // でローカルに失敗させる。
        args: ["--add-host=api.anthropic.com:127.0.0.1"],
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
          "rawtcp=false",
          "--set",
          "websocket=true",
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

      // 承認されたルールのポリシーが弾く経路。固定 403 と request-policy
      // の監査行が1本ずつ出る。
      const policyBlocks = [
        {
          name: "bodyless endpoint with a body",
          path: "/api/claude_code/settings",
          method: "GET",
          body: "x",
          ruleId: "anthropic.bootstrap",
          reason: "unexpected-body",
        },
        {
          name: "bodyless endpoint with undecodable body",
          path: "/api/claude_code/settings",
          method: "GET",
          headers: { "Content-Encoding": "unsupported" },
          body: "x",
          ruleId: "anthropic.bootstrap",
          reason: "body-unavailable",
        },
      ];

      // どの allow ルールにも当たらない経路。broker 側の default-deny が
      // 認可の時点で落とすので、ポリシーは一度も走らない。
      const authorizationDenials = [
        {
          name: "unsupported method on a known route",
          path: "/api/claude_code/metrics",
          method: "POST",
        },
        { name: "file upload", path: "/v1/files", method: "POST", body: "{}" },
        {
          name: "unknown secret-bearing route",
          path: "/unknown/SECRET123?token=SECRET123",
          method: "GET",
        },
      ];

      let seenOutcomes = 0;
      for (const testCase of policyBlocks) {
        const response = await sendProxyRequest(
          proxyPort,
          `http://api.anthropic.com${testCase.path}`,
          `${sessionId}:${token}`,
          {
            method: testCase.method,
            headers: testCase.headers,
            body: testCase.body,
          },
        );
        const outcomes = await readPolicyOutcomes(fixture.auditDir);
        const fresh = outcomes.slice(seenOutcomes);
        seenOutcomes = outcomes.length;
        const proxyLogs = await dockerLogs(containerName);

        expect(fresh, `${testCase.name}: outcome count`).toHaveLength(1);
        expect(fresh[0]?.ruleId, testCase.name).toBe(testCase.ruleId);
        expect(fresh[0]?.requestPolicyResult, testCase.name).toBe("block");
        expect(fresh[0]?.reason, testCase.name).toBe(testCase.reason);
        expect(response, testCase.name).toContain("403 Forbidden");
        expect(response, testCase.name).toContain("blocked: request policy");
        expect(JSON.stringify(fresh), testCase.name).not.toContain("SECRET123");
        expect(proxyLogs, testCase.name).not.toContain("SECRET123");
      }

      for (const testCase of authorizationDenials) {
        const response = await sendProxyRequest(
          proxyPort,
          `http://api.anthropic.com${testCase.path}`,
          `${sessionId}:${token}`,
          { method: testCase.method, body: testCase.body },
        );
        const outcomes = await readPolicyOutcomes(fixture.auditDir);
        const proxyLogs = await dockerLogs(containerName);

        expect(response, testCase.name).toContain("403");
        expect(outcomes.length, `${testCase.name}: no policy ran`).toBe(
          seenOutcomes,
        );
        // ここだけ addon 自身の行に絞る。マスク値は broker の allow 決定に
        // しか乗らないので、認可の時点で落ちる要求はマスクを適用する機会が
        // 来る前に mitmproxy 本体のフローログへ生の URL が出る。addon が
        // 秘密を漏らさないことは、addon が書いた行で判定する。
        expect(addonLogLines(proxyLogs), testCase.name).not.toContain(
          "SECRET123",
        );
      }
    } finally {
      await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
      await dockerRm(containerName).catch(() => {});
      await teardownFixture(fixture);
    }
  },
  60_000,
);
