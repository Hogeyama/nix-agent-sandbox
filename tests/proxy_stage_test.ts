/**
 * ProxyStage テスト
 *
 * Unit tests (Docker 不要) と Integration tests (実 Docker 使用) を含む。
 */

import { assertEquals } from "@std/assert";
import { DEFAULT_NETWORK_CONFIG } from "../src/config/types.ts";
import { ProxyStage } from "../src/stages/proxy.ts";
import {
  computeAllowlistHash,
  generateSquidConfig,
  parseDindContainerName,
  replaceNetwork,
} from "../src/stages/proxy.ts";
import { createContext } from "../src/pipeline/context.ts";
import type { Config, Profile } from "../src/config/types.ts";
import type { ExecutionContext } from "../src/pipeline/context.ts";
import {
  dockerIsRunning,
  dockerNetworkRemove,
  dockerRm,
  dockerStop,
} from "../src/docker/client.ts";

type NetworkOverrides = Partial<Omit<Profile["network"], "prompt">> & {
  prompt?: Partial<Profile["network"]["prompt"]>;
};

type ProfileOverrides = Omit<Partial<Profile>, "network"> & {
  network?: NetworkOverrides;
};

function makeProfile(overrides: ProfileOverrides = {}): Profile {
  const baseNetwork = structuredClone(DEFAULT_NETWORK_CONFIG);
  const { network, ...rest } = overrides;
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    network: {
      ...baseNetwork,
      ...network,
      prompt: {
        ...baseNetwork.prompt,
        ...network?.prompt,
      },
    },
    extraMounts: [],
    env: [],
    ...rest,
  };
}

function makeConfig(profile: Profile): Config {
  return { profiles: { default: profile } };
}

function makeCtx(profile: Profile): ExecutionContext {
  return createContext(makeConfig(profile), profile, "default", "/tmp");
}

// ============================================================
// Unit tests (Docker 不要)
// ============================================================

Deno.test("ProxyStage: skip when allowlist is empty", async () => {
  const profile = makeProfile({ network: { allowlist: [] } });
  const ctx = makeCtx(profile);
  const stage = new ProxyStage();
  const result = await stage.execute(ctx);
  assertEquals(result, ctx);
  assertEquals(result.dockerArgs, []);
  assertEquals(result.envVars, {});
});

Deno.test("generateSquidConfig: exact domain produces exact match ACL", () => {
  const config = generateSquidConfig(["github.com", "api.anthropic.com"]);
  assertEquals(
    config.includes("dstdomain github.com api.anthropic.com"),
    true,
  );
  assertEquals(config.includes("http_port 3128"), true);
  assertEquals(
    config.includes("http_access allow CONNECT allowed_domains"),
    true,
  );
  assertEquals(config.includes("http_access allow allowed_domains"), true);
  assertEquals(config.includes("http_access deny all"), true);
  assertEquals(config.includes("cache deny all"), true);
});

Deno.test("generateSquidConfig: wildcard domain produces leading-dot ACL", () => {
  const config = generateSquidConfig(["*.github.com", "api.anthropic.com"]);
  assertEquals(
    config.includes("dstdomain .github.com api.anthropic.com"),
    true,
  );
});

Deno.test("computeAllowlistHash: same list same hash", async () => {
  const hash1 = await computeAllowlistHash(["a.com", "b.com"]);
  const hash2 = await computeAllowlistHash(["b.com", "a.com"]);
  assertEquals(hash1, hash2);
});

Deno.test("computeAllowlistHash: different list different hash", async () => {
  const hash1 = await computeAllowlistHash(["a.com"]);
  const hash2 = await computeAllowlistHash(["b.com"]);
  assertEquals(hash1 !== hash2, true);
});

Deno.test("replaceNetwork: replaces existing --network", () => {
  const args = ["--rm", "--network", "old-net", "-v", "/tmp:/tmp"];
  const result = replaceNetwork(args, "new-net");
  assertEquals(result, ["--rm", "--network", "new-net", "-v", "/tmp:/tmp"]);
});

Deno.test("replaceNetwork: appends when no --network", () => {
  const args = ["--rm", "-v", "/tmp:/tmp"];
  const result = replaceNetwork(args, "new-net");
  assertEquals(result, ["--rm", "-v", "/tmp:/tmp", "--network", "new-net"]);
});

Deno.test("parseDindContainerName: extracts from DOCKER_HOST", () => {
  const name = parseDindContainerName({
    DOCKER_HOST: "tcp://nas-dind-abc12345:2375",
  });
  assertEquals(name, "nas-dind-abc12345");
});

Deno.test("parseDindContainerName: returns null when no DOCKER_HOST", () => {
  const name = parseDindContainerName({});
  assertEquals(name, null);
});

Deno.test("parseDindContainerName: returns null for invalid format", () => {
  const name = parseDindContainerName({
    DOCKER_HOST: "unix:///var/run/docker.sock",
  });
  assertEquals(name, null);
});

// ============================================================
// Integration tests (実 Docker 使用)
// ============================================================

async function canRunProxy(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("docker", {
      args: ["image", "inspect", "ubuntu/squid"],
      stdout: "null",
      stderr: "null",
    });
    const result = await cmd.output();
    return result.success;
  } catch {
    return false;
  }
}

const proxyAvailable = await canRunProxy();

async function forceCleanup(hash: string): Promise<void> {
  const containerName = `nas-proxy-${hash}`;
  const networkName = `nas-proxy-${hash}`;
  await dockerStop(containerName).catch(() => {});
  await dockerRm(containerName).catch(() => {});
  await dockerNetworkRemove(networkName).catch(() => {});
}

Deno.test({
  name: "ProxyStage: starts proxy and sets env vars",
  ignore: !proxyAvailable,
  fn: async () => {
    const allowlist = ["github.com", "api.anthropic.com"];
    const hash = await computeAllowlistHash(allowlist);

    await forceCleanup(hash);

    const profile = makeProfile({ network: { allowlist } });
    const ctx = makeCtx(profile);
    const stage = new ProxyStage();

    try {
      const result = await stage.execute(ctx);

      const containerName = `nas-proxy-${hash}`;
      const running = await dockerIsRunning(containerName);
      assertEquals(running, true);

      assertEquals(
        result.envVars["http_proxy"],
        `http://${containerName}:3128`,
      );
      assertEquals(
        result.envVars["https_proxy"],
        `http://${containerName}:3128`,
      );
      assertEquals(
        result.envVars["HTTP_PROXY"],
        `http://${containerName}:3128`,
      );
      assertEquals(
        result.envVars["HTTPS_PROXY"],
        `http://${containerName}:3128`,
      );
      assertEquals(result.envVars["no_proxy"], "localhost,127.0.0.1");
      assertEquals(result.envVars["NO_PROXY"], "localhost,127.0.0.1");

      const networkIdx = result.dockerArgs.indexOf("--network");
      assertEquals(networkIdx !== -1, true);
      assertEquals(result.dockerArgs[networkIdx + 1], `nas-proxy-${hash}`);
    } finally {
      await stage.teardown(ctx);
      await forceCleanup(hash);
    }
  },
});

Deno.test({
  name: "ProxyStage: reuses existing proxy with same allowlist",
  ignore: !proxyAvailable,
  fn: async () => {
    const allowlist = ["example.com"];
    const hash = await computeAllowlistHash(allowlist);

    await forceCleanup(hash);

    const profile = makeProfile({ network: { allowlist } });
    const ctx = makeCtx(profile);
    const stage1 = new ProxyStage();
    const stage2 = new ProxyStage();

    try {
      await stage1.execute(ctx);
      const result2 = await stage2.execute(ctx);

      const containerName = `nas-proxy-${hash}`;
      const running = await dockerIsRunning(containerName);
      assertEquals(running, true);
      assertEquals(
        result2.envVars["http_proxy"],
        `http://${containerName}:3128`,
      );
    } finally {
      await stage1.teardown(ctx);
      await stage2.teardown(ctx);
      await forceCleanup(hash);
    }
  },
});

Deno.test({
  name: "ProxyStage: sets no_proxy with DinD container name",
  ignore: !proxyAvailable,
  fn: async () => {
    const allowlist = ["github.com"];
    const hash = await computeAllowlistHash(allowlist);

    await forceCleanup(hash);

    const profile = makeProfile({ network: { allowlist } });
    const baseCtx = makeCtx(profile);
    // Simulate DinD stage having set DOCKER_HOST
    const ctx: ExecutionContext = {
      ...baseCtx,
      envVars: {
        ...baseCtx.envVars,
        DOCKER_HOST: "tcp://nas-dind-abc12345:2375",
      },
      dockerArgs: ["--network", "nas-dind-abc12345"],
    };
    const stage = new ProxyStage();

    try {
      const result = await stage.execute(ctx);

      assertEquals(
        result.envVars["no_proxy"],
        "localhost,127.0.0.1,nas-dind-abc12345",
      );
      assertEquals(
        result.envVars["NO_PROXY"],
        "localhost,127.0.0.1,nas-dind-abc12345",
      );
      // --network should be replaced from dind network to proxy network
      const networkIdx = result.dockerArgs.indexOf("--network");
      assertEquals(result.dockerArgs[networkIdx + 1], `nas-proxy-${hash}`);
    } finally {
      await stage.teardown(ctx);
      await forceCleanup(hash);
    }
  },
});

// ============================================================
// Additional unit tests
// ============================================================

Deno.test("computeAllowlistHash: returns 8 character hex string", async () => {
  const hash = await computeAllowlistHash(["example.com"]);
  assertEquals(hash.length, 8);
  assertEquals(/^[0-9a-f]{8}$/.test(hash), true);
});

Deno.test("generateSquidConfig: denies CONNECT to non-SSL ports", () => {
  const config = generateSquidConfig(["example.com"]);
  assertEquals(config.includes("acl SSL_ports port 443"), true);
  assertEquals(config.includes("http_access deny CONNECT !SSL_ports"), true);
});
