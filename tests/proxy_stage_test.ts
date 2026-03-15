import { assertEquals, assertMatch } from "@std/assert";
import {
  parseDindContainerName,
  ProxyStage,
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

const DEFAULT_PROMPT = {
  enable: false,
  timeoutSeconds: 300,
  defaultScope: "host-port" as const,
  notify: "auto" as const,
};

function makeProfile(
  overrides: Partial<Omit<Profile, "network">> & {
    network?: Partial<Profile["network"]> & {
      prompt?: Partial<Profile["network"]["prompt"]>;
    };
  } = {},
): Profile {
  const networkOverrides = overrides.network ?? {};
  const { network: _ignored, ...rest } = overrides;
  const network: Profile["network"] = {
    allowlist: networkOverrides.allowlist
      ? [...networkOverrides.allowlist]
      : [],
    prompt: {
      ...DEFAULT_PROMPT,
      ...(networkOverrides.prompt ?? {}),
    },
  };
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    network,
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

Deno.test("ProxyStage: skip when allowlist and prompt are disabled", async () => {
  const profile = makeProfile();
  const ctx = makeCtx(profile);
  const stage = new ProxyStage();
  const result = await stage.execute(ctx);
  assertEquals(result, ctx);
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

Deno.test("parseDindContainerName: prefers explicit env var", () => {
  const name = parseDindContainerName({
    NAS_DIND_CONTAINER_NAME: "nas-dind-explicit",
    DOCKER_HOST: "tcp://nas-dind-abc12345:2375",
  });
  assertEquals(name, "nas-dind-explicit");
});

Deno.test("parseDindContainerName: returns null for invalid format", () => {
  const name = parseDindContainerName({
    DOCKER_HOST: "unix:///var/run/docker.sock",
  });
  assertEquals(name, null);
});

async function canRunProxy(): Promise<boolean> {
  try {
    const result = await new Deno.Command("docker", {
      args: ["info"],
      stdout: "null",
      stderr: "null",
    }).output();
    return result.success;
  } catch {
    return false;
  }
}

const proxyAvailable = await canRunProxy();

Deno.test({
  name: "ProxyStage: starts shared Envoy and injects credentialed proxy env",
  ignore: !proxyAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const runtimeRoot = await Deno.makeTempDir({
      prefix: "nas-proxy-runtime-",
    });
    const runtimeDir = `${runtimeRoot}/nas/network`;
    const oldRuntimeDir = Deno.env.get("XDG_RUNTIME_DIR");
    Deno.env.set("XDG_RUNTIME_DIR", runtimeRoot);

    const profile = makeProfile({
      network: {
        allowlist: ["example.com"],
      },
    });
    const ctx = makeCtx(profile);
    const stage = new ProxyStage();

    try {
      await Deno.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(`${runtimeDir}/envoy.yaml`, "# stale\n", {
        create: true,
        mode: 0o600,
      });

      const result = await stage.execute(ctx);
      assertMatch(
        result.envVars["http_proxy"],
        /^http:\/\/sess_[a-f0-9]{12}:[A-Za-z0-9_-]+@nas-envoy:15001$/,
      );
      assertEquals(result.envVars["https_proxy"], result.envVars["http_proxy"]);
      assertEquals(result.networkBrokerSocket !== null, true);
      assertEquals(result.networkRuntimeDir?.startsWith(runtimeRoot), true);
      assertEquals(
        result.dockerArgs.includes(`nas-session-net-${ctx.sessionId}`),
        true,
      );
      assertEquals(((await Deno.stat(runtimeDir)).mode ?? 0) & 0o777, 0o755);
      assertEquals(
        ((await Deno.stat(`${runtimeDir}/envoy.yaml`)).mode ?? 0) & 0o777,
        0o644,
      );
      assertEquals(await dockerIsRunning("nas-envoy-shared"), true);
    } finally {
      await stage.teardown(ctx);
      await cleanupRuntime(runtimeRoot);
      if (oldRuntimeDir) {
        Deno.env.set("XDG_RUNTIME_DIR", oldRuntimeDir);
      } else {
        Deno.env.delete("XDG_RUNTIME_DIR");
      }
    }
  },
});

async function cleanupRuntime(runtimeRoot: string): Promise<void> {
  const networkDir = `${runtimeRoot}/nas/network`;
  const pidFile = `${networkDir}/auth-router.pid`;
  try {
    const pid = Number((await Deno.readTextFile(pidFile)).trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== Deno.pid) {
      await new Deno.Command("kill", {
        args: [String(pid)],
        stdout: "null",
        stderr: "null",
      }).output();
    }
  } catch {
    // noop
  }
  await dockerStop("nas-envoy-shared").catch(() => {});
  await dockerRm("nas-envoy-shared").catch(() => {});
  for (const sessionId of await listSessionNetworks(networkDir)) {
    await dockerNetworkRemove(`nas-session-net-${sessionId}`).catch(() => {});
  }
  await Deno.remove(runtimeRoot, { recursive: true }).catch(() => {});
}

async function listSessionNetworks(networkDir: string): Promise<string[]> {
  try {
    const sessionsDir = `${networkDir}/sessions`;
    const ids: string[] = [];
    for await (const entry of Deno.readDir(sessionsDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      ids.push(entry.name.replace(/\.json$/, ""));
    }
    return ids;
  } catch {
    return [];
  }
}
