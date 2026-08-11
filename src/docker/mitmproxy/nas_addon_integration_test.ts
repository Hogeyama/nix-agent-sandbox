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
import { SessionBroker } from "../../network/broker.ts";
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

interface AnthropicFixture {
  runtimeDir: string;
  auditDir: string;
  paths: Awaited<ReturnType<typeof resolveNetworkRuntimePaths>>;
  sessionId: string;
  token: string;
  broker: SessionBroker;
}

interface AnthropicFixtureSetupOptions {
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
async function setupAnthropicFixture(
  dirPrefix: string,
  options: AnthropicFixtureSetupOptions = {},
): Promise<AnthropicFixture> {
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
      JSON.stringify(RESOLVED_DOCUMENT),
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
      document: RESOLVED_DOCUMENT,
      pendingTimeoutSeconds: 30,
      pendingNotify: "off",
      secretValues: { workspace: ["SECRET123"] },
      auditDir,
    });
    await broker.start(socketPath);
    await options.afterBrokerStarted?.({ runtimeDir, broker });
    await chmod(socketPath, 0o666);

    return { runtimeDir, auditDir, paths, sessionId, token, broker };
  } catch (error) {
    await Promise.allSettled([
      broker ? broker.close() : Promise.resolve(),
      rm(runtimeDir, { recursive: true, force: true }),
      rm(auditDir, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

/** テスト終了時のフィクスチャ解体。broker を閉じ、一時ディレクトリを消す。 */
async function teardownFixture(fixture?: AnthropicFixture): Promise<void> {
  if (!fixture) return;
  await fixture.broker.close().catch(() => {});
  await rm(fixture.runtimeDir, { recursive: true, force: true }).catch(
    () => {},
  );
  await rm(fixture.auditDir, { recursive: true, force: true }).catch(() => {});
}

test("setupAnthropicFixture cleans partial state when setup fails after broker start", async () => {
  const setupError = new Error("injected post-broker setup failure");
  let partial: { runtimeDir: string; broker: SessionBroker } | undefined;
  let thrown: unknown;

  try {
    try {
      await setupAnthropicFixture("nas-addon-partial-setup-", {
        afterBrokerStarted: async (state) => {
          partial = state;
          throw setupError;
        },
      });
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

test("setupAnthropicFixture installs the shipped resolved document", async () => {
  const fixture = await setupAnthropicFixture("nas-addon-review-rule-");
  try {
    const document = await Bun.file(
      `${fixture.paths.authzDir}/${fixture.sessionId}.json`,
    ).json();

    // addon が読むファイルと broker が握るルールが同一であることが、
    // このスイートの前提そのもの。
    expect(document).toEqual(RESOLVED_DOCUMENT);
    expect(document.contractVersion).toBe(2);
  } finally {
    await teardownFixture(fixture);
  }
});
const ANTHROPIC_TARGET_PORT = 8090;

test.skipIf(!dockerAvailable || !canBindMount)(
  "anthropic bodyless GET: masks URL and headers before forwarding",
  async () => {
    const networkName = `nas-addon-net-${crypto.randomUUID().slice(0, 8)}`;
    const containerName = `nas-addon-test-${crypto.randomUUID().slice(0, 8)}`;
    const targetName = `nas-addon-upstream-${crypto.randomUUID().slice(0, 8)}`;
    let fixture: AnthropicFixture | undefined;
    let networkCreated = false;

    try {
      fixture = await setupAnthropicFixture("nas-addon-bodyless-");
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
      const outcome = await expectSinglePolicyOutcome(
        fixture.auditDir,
        {
          ruleId: "anthropic.messages",
          requestPolicyResult: "block",
          // 未知の判別子は tagged union のガードに弾かれる。
          reason: "schema-mismatch",
        },
        "unknown content block",
      );

      expect(response).toContain("403");
      expect(JSON.stringify(outcome)).not.toContain("SECRET123");
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
    let fixture: AnthropicFixture | undefined;

    try {
      fixture = await setupAnthropicFixture("nas-addon-blocked-policy-");
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
