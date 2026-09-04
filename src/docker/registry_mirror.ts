import { createConnection } from "node:net";
import type { DockerRunDetachedOptions } from "./client.ts";
import {
  dockerContainerIpOnNetwork,
  dockerIsRunning,
  dockerLogs,
  dockerRunDetached,
  dockerVolumeCreate,
} from "./client.ts";
import {
  NAS_KIND_LABEL,
  NAS_KIND_REGISTRY_CACHE,
  NAS_KIND_REGISTRY_MIRROR,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "./nas_resources.ts";
import { PROXY_CA_MOUNT_DIR, proxyCaCertMount } from "./proxy_ca_mount.ts";

export const REGISTRY_MIRROR_IMAGE = "registry:2";
export const REGISTRY_CACHE_VOLUME = "nas-registry-cache";
export const REGISTRY_DATA_DIR = "/var/lib/registry";
export const REGISTRY_MIRROR_PORT = 5000;

export interface RegistryMirrorStartParams {
  readonly containerName: string;
  readonly cacheVolumeName: string;
  readonly networkName: string;
  readonly proxyEndpoint: string;
  readonly caCertPath: string;
  readonly readinessTimeoutMs: number;
}

export function registryMirrorUrl(containerName: string): string {
  return `http://${containerName}:${REGISTRY_MIRROR_PORT}`;
}

export function buildRegistryMirrorRunOptions(
  params: RegistryMirrorStartParams,
): DockerRunDetachedOptions {
  return {
    name: params.containerName,
    image: REGISTRY_MIRROR_IMAGE,
    args: [],
    envVars: {
      REGISTRY_PROXY_REMOTEURL: "https://registry-1.docker.io",
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: REGISTRY_DATA_DIR,
      HTTP_PROXY: params.proxyEndpoint,
      HTTPS_PROXY: params.proxyEndpoint,
      NO_PROXY: `localhost,127.0.0.1,${params.containerName}`,
      SSL_CERT_DIR: PROXY_CA_MOUNT_DIR,
    },
    network: params.networkName,
    mounts: [
      {
        source: params.cacheVolumeName,
        target: REGISTRY_DATA_DIR,
        type: "volume",
      },
      proxyCaCertMount(params.caCertPath),
    ],
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_REGISTRY_MIRROR,
    },
  };
}

export interface RegistryMirrorDeps {
  readonly volumeCreate: (
    name: string,
    labels: Record<string, string>,
  ) => Promise<void>;
  readonly runDetached: (opts: DockerRunDetachedOptions) => Promise<void>;
  readonly isRunning: (name: string) => Promise<boolean>;
  readonly containerIpOnNetwork: (
    container: string,
    network: string,
  ) => Promise<string | null>;
  readonly logs: (name: string) => Promise<string>;
  readonly canConnectTcp: (host: string, port: number) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
}

const liveRegistryMirrorDeps: RegistryMirrorDeps = {
  volumeCreate: (name, labels) => dockerVolumeCreate(name, labels),
  runDetached: dockerRunDetached,
  isRunning: dockerIsRunning,
  containerIpOnNetwork: dockerContainerIpOnNetwork,
  logs: (name) => dockerLogs(name, { tail: 50 }),
  canConnectTcp: (host, port) =>
    new Promise((resolve) => {
      const socket = createConnection({ host, port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function startRegistryMirror(
  params: RegistryMirrorStartParams,
  deps: RegistryMirrorDeps = liveRegistryMirrorDeps,
): Promise<void> {
  await deps.volumeCreate(params.cacheVolumeName, {
    [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
    [NAS_KIND_LABEL]: NAS_KIND_REGISTRY_CACHE,
  });
  await deps.runDetached(buildRegistryMirrorRunOptions(params));

  const started = Date.now();
  let ip: string | null = null;
  while (Date.now() - started < params.readinessTimeoutMs) {
    if (!(await deps.isRunning(params.containerName))) {
      const logs = await deps.logs(params.containerName);
      throw new Error(`Registry mirror exited before readiness:\n${logs}`);
    }
    ip ??= await deps.containerIpOnNetwork(
      params.containerName,
      params.networkName,
    );
    if (ip && (await deps.canConnectTcp(ip, REGISTRY_MIRROR_PORT))) return;
    await deps.sleep(200);
  }
  const logs = await deps.logs(params.containerName);
  throw new Error(`Registry mirror readiness timed out:\n${logs}`);
}
