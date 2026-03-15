/**
 * Forward Proxy サイドカーステージ
 *
 * Squid forward proxy を使って、エージェントコンテナからの外部通信を
 * allowlist で制御する。
 *
 * ネットワーク構成:
 * - internal network (--internal): 外部アクセス不可
 *   - Agent container (http_proxy → proxy:3128)
 *   - Proxy container (bridge にも接続 → 外部アクセス可)
 *   - DinD sidecar (bridge にも接続 → image pull 可)
 *
 * 共有方式:
 * - allowlist の内容に基づいてハッシュを計算し、同じ allowlist なら同じ proxy を再利用
 * - コンテナ名/ネットワーク名: nas-proxy-{allowlistHash}
 *
 * DinD との共存:
 * - DindStage が先に実行され、ctx に --network nas-dind-xxx と DOCKER_HOST が設定される
 * - ProxyStage は DOCKER_HOST から DinD コンテナ名を取得し、internal network に接続する
 * - ctx.dockerArgs の --network を DinD のネットワークから internal に置換する
 *   → DindStage が作った custom network (nas-dind-xxx) は agent から使われなくなるが、
 *     DindStage の teardown で削除される
 * - Agent は internal network のみに所属し、DinD には internal 経由で到達可能
 * - DinD の bridge 接続はそのまま残る → image pull は proxy を経由せず直接外部へ
 *
 * Teardown の方針:
 * - proxy コンテナは allowlist ハッシュベースで共有 → 他セッションが使用中の可能性 → 残す
 * - DinD は disconnect しない:
 *   - shared DinD: 他セッションが同じ internal network 経由でアクセス中の可能性
 *   - 非 shared DinD: DindStage の teardown でコンテナごと消えるので不要
 */

import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import {
  dockerExec,
  dockerIsRunning,
  dockerNetworkConnect,
  dockerNetworkCreateWithLabels,
  dockerRm,
  dockerRunDetached,
} from "../docker/client.ts";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import {
  NAS_KIND_LABEL,
  NAS_KIND_PROXY,
  NAS_KIND_PROXY_NETWORK,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "../docker/nas_resources.ts";

const PROXY_IMAGE = "ubuntu/squid";
const PROXY_PORT = 3128;
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_INTERVAL_MS = 500;

export class ProxyStage implements Stage {
  name = "ProxyStage";
  private networkName: string | null = null;
  private containerName: string | null = null;

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    const allowlist = ctx.profile.network.allowlist;
    if (allowlist.length === 0) {
      console.log("[nas] Proxy: skipped (no allowlist configured)");
      return ctx;
    }

    const hash = await computeAllowlistHash(allowlist);
    this.networkName = `nas-proxy-${hash}`;
    this.containerName = `nas-proxy-${hash}`;

    const isReusing = await dockerIsRunning(this.containerName);

    if (isReusing) {
      console.log(
        `[nas] Proxy: reusing proxy for this allowlist (${this.containerName})`,
      );
    } else {
      // 停止済みコンテナが残っている場合は削除
      await dockerRm(this.containerName).catch(() => {});

      // 1. internal ネットワーク作成
      await ensureInternalNetwork(this.networkName);
      // 2. squid コンテナを bridge で起動
      await startProxySidecar(this.containerName);
      // 3. squid を internal ネットワークに接続
      await dockerNetworkConnect(this.networkName, this.containerName).catch(
        () => {},
      );
      // 4. readiness 待機
      await waitForReady(this.containerName);
      // 5. squid 設定書き込み + reconfigure
      await writeSquidConfig(this.containerName, allowlist);
    }

    // DinD が有効なら internal ネットワークに接続
    const dindContainerName = parseDindContainerName(ctx.envVars);
    if (dindContainerName) {
      await dockerNetworkConnect(this.networkName, dindContainerName).catch(
        () => {},
      );
    }

    // ctx.dockerArgs の --network を置き換え
    const args = replaceNetwork(ctx.dockerArgs, this.networkName);

    // proxy 環境変数
    const proxyUrl = `http://${this.containerName}:${PROXY_PORT}`;
    const noProxyEntries = ["localhost", "127.0.0.1"];
    if (dindContainerName) {
      noProxyEntries.push(dindContainerName);
    }
    const envVars = {
      ...ctx.envVars,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      no_proxy: noProxyEntries.join(","),
      NO_PROXY: noProxyEntries.join(","),
    };

    return { ...ctx, dockerArgs: args, envVars };
  }

  teardown(_ctx: ExecutionContext): Promise<void> {
    if (!this.containerName) return Promise.resolve();

    // DinD は internal network から disconnect しない:
    // - shared DinD: 他セッションが同じ internal network 経由で
    //   DinD にアクセスしている可能性がある。disconnect すると壊れる。
    // - 非 shared DinD: DindStage の teardown でコンテナごと消えるので
    //   network からの disconnect は不要。

    // proxy コンテナは allowlist ハッシュベースで共有されるため、
    // 他セッションが同じ proxy を使用中の可能性がある → 残す
    console.log(`[nas] Proxy: keeping proxy (${this.containerName})`);
    return Promise.resolve();
  }
}

/** allowlist からソート済みハッシュを計算して共有キーを生成 */
export async function computeAllowlistHash(
  allowlist: string[],
): Promise<string> {
  const sorted = [...allowlist].sort();
  const data = new TextEncoder().encode(sorted.join("\n"));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return encodeHex(new Uint8Array(hashBuffer)).slice(0, 8);
}

/**
 * Squid 設定を生成
 *
 * 注意: access_log stdio:/dev/stdout を入れてはいけない。
 * squid はデーモンモードで起動し、起動時に access_log のファイルハンドルを開く。
 * reconfigure で stdio:/dev/stdout に切り替えようとすると、
 * デーモンモードの既存ハンドルと衝突して squid がクラッシュする。
 */
export function generateSquidConfig(allowlist: string[]): string {
  const domains = allowlist.map((d) => `.${d}`).join(" ");
  return `http_port ${PROXY_PORT}
acl allowed_domains dstdomain ${domains}
acl CONNECT method CONNECT
acl SSL_ports port 443
http_access deny CONNECT !SSL_ports
http_access allow CONNECT allowed_domains
http_access allow allowed_domains
http_access deny all
cache deny all
coredump_dir /var/spool/squid
`;
}

/** --network を探して置換、なければ追加 */
export function replaceNetwork(
  dockerArgs: string[],
  newNetwork: string,
): string[] {
  const args = [...dockerArgs];
  const idx = args.indexOf("--network");
  if (idx !== -1 && idx + 1 < args.length) {
    args[idx + 1] = newNetwork;
  } else {
    args.push("--network", newNetwork);
  }
  return args;
}

/** DOCKER_HOST から tcp://<name>:<port> をパースしてコンテナ名を抽出 */
export function parseDindContainerName(
  envVars: Record<string, string>,
): string | null {
  const dockerHost = envVars["DOCKER_HOST"];
  if (!dockerHost) return null;
  const match = dockerHost.match(/^tcp:\/\/([^:]+):\d+$/);
  return match ? match[1] : null;
}

/** internal ネットワークを作成（既存ならスキップ） */
async function ensureInternalNetwork(networkName: string): Promise<void> {
  try {
    await dockerNetworkCreateWithLabels(networkName, {
      internal: true,
      labels: {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_PROXY_NETWORK,
      },
    });
    console.log(`[nas] Proxy: created internal network ${networkName}`);
  } catch {
    // 既に存在する場合は無視
  }
}

/** Squid プロキシコンテナをデフォルト bridge で起動 */
async function startProxySidecar(containerName: string): Promise<void> {
  console.log(`[nas] Proxy: starting proxy sidecar (${PROXY_IMAGE})`);
  await dockerRunDetached({
    name: containerName,
    image: PROXY_IMAGE,
    args: [],
    envVars: {},
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_PROXY,
    },
  });
}

/** Squid の readiness をポーリングで確認 */
async function waitForReady(containerName: string): Promise<void> {
  console.log("[nas] Proxy: waiting for squid to be ready...");
  const start = Date.now();
  while (Date.now() - start < READINESS_TIMEOUT_MS) {
    const result = await dockerExec(containerName, [
      "squid",
      "-k",
      "check",
    ]);
    if (result.code === 0) {
      console.log("[nas] Proxy: squid is ready");
      return;
    }
    await new Promise((r) => setTimeout(r, READINESS_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Squid proxy failed to become ready within ${READINESS_TIMEOUT_MS / 1000}s`,
  );
}

/** Squid 設定をコンテナに書き込み、reconfigure でリロード */
async function writeSquidConfig(
  containerName: string,
  allowlist: string[],
): Promise<void> {
  const config = generateSquidConfig(allowlist);
  const result = await dockerExec(containerName, [
    "sh",
    "-c",
    `cat > /etc/squid/squid.conf << 'SQUID_EOF'\n${config}SQUID_EOF`,
  ]);
  if (result.code !== 0) {
    throw new Error("Failed to write squid config");
  }
  const reconfigure = await dockerExec(containerName, [
    "squid",
    "-k",
    "reconfigure",
  ]);
  if (reconfigure.code !== 0) {
    throw new Error("Failed to reconfigure squid");
  }
  console.log("[nas] Proxy: squid configured with allowlist");
}
