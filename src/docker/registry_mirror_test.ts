import { expect, test } from "bun:test";
import {
  buildRegistryMirrorRunOptions,
  REGISTRY_CACHE_VOLUME,
  REGISTRY_DATA_DIR,
  REGISTRY_MIRROR_IMAGE,
  registryMirrorUrl,
  startRegistryMirror,
} from "./registry_mirror.ts";

const params = {
  containerName: "nas-registry-mirror-session-a",
  cacheVolumeName: REGISTRY_CACHE_VOLUME,
  networkName: "nas-session-net-session-a",
  proxyEndpoint: "http://session-a:secret-token@nas-proxy:8080",
  caCertPath: "/run/nas/mitmproxy-ca/mitmproxy-ca-cert.pem",
  readinessTimeoutMs: 5_000,
};

test("buildRegistryMirrorRunOptions: confines the mirror to the session network", () => {
  const opts = buildRegistryMirrorRunOptions(params);

  expect(opts.image).toBe(REGISTRY_MIRROR_IMAGE);
  expect(opts.network).toBe(params.networkName);
  expect(opts.publishedPorts).toBeUndefined();
  expect(opts.args).toEqual([]);
});

test("buildRegistryMirrorRunOptions: shares only registry storage and the CA certificate", () => {
  const opts = buildRegistryMirrorRunOptions(params);

  expect(opts.mounts).toEqual([
    {
      source: params.cacheVolumeName,
      target: REGISTRY_DATA_DIR,
      type: "volume",
    },
    {
      source: params.caCertPath,
      target: "/etc/nas-ca/nas-proxy.crt",
      mode: "ro",
      type: "bind",
    },
  ]);
  expect(
    opts.mounts?.some(
      (mount) =>
        typeof mount !== "string" && mount.source === "/run/nas/mitmproxy-ca",
    ),
  ).toBe(false);
});

test("buildRegistryMirrorRunOptions: configures anonymous Docker Hub pull-through cache", () => {
  const env = buildRegistryMirrorRunOptions(params).envVars;

  expect(env.REGISTRY_PROXY_REMOTEURL).toBe("https://registry-1.docker.io");
  expect(env.REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY).toBe(REGISTRY_DATA_DIR);
  expect(env.HTTP_PROXY).toBe(params.proxyEndpoint);
  expect(env.HTTPS_PROXY).toBe(params.proxyEndpoint);
  expect(env.SSL_CERT_DIR).toBe("/etc/nas-ca");
  expect(env.REGISTRY_PROXY_USERNAME).toBeUndefined();
  expect(env.REGISTRY_PROXY_PASSWORD).toBeUndefined();
});

test("registryMirrorUrl: returns the internal plaintext endpoint", () => {
  expect(registryMirrorUrl(params.containerName)).toBe(
    "http://nas-registry-mirror-session-a:5000",
  );
});

test("startRegistryMirror: labels the cache and waits for the listener", async () => {
  const calls: string[] = [];
  const deps = {
    volumeCreate: async (name: string, labels: Record<string, string>) => {
      calls.push(`volume:${name}:${labels["nas.kind"]}`);
    },
    runDetached: async () => {
      calls.push("run");
    },
    isRunning: async () => true,
    containerIpOnNetwork: async () => "172.30.0.3",
    logs: async () => "",
    canConnectTcp: async () => true,
    sleep: async () => {},
  };

  await startRegistryMirror(params, deps);

  expect(calls).toEqual([
    `volume:${REGISTRY_CACHE_VOLUME}:registry-cache`,
    "run",
  ]);
});
