/**
 * ProxyStage integration テスト（実 Docker daemon 必要）
 *
 * Envoy コンテナ起動とプロキシ設定の注入を検証する。
 * unit テスト（skip 判定, replaceNetwork, parseDindContainerName）は
 * proxy_stage_test.ts を参照。
 */

import { assertEquals, assertMatch } from "@std/assert";
import { buildNetworkRuntimePaths, createProxyStage } from "./proxy.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import type { Config, Profile } from "../config/types.ts";
import type {
  HostEnv,
  PriorStageOutputs,
  ProbeResults,
  StageInput,
} from "../pipeline/types.ts";
import { executePlan, teardownHandles } from "../pipeline/effects.ts";
import {
  dockerIsRunning,
  dockerNetworkRemove,
  dockerRm,
  dockerStop,
} from "../docker/client.ts";

const DEFAULT_PROMPT = {
  enable: false,
  denylist: [] as string[],
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
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network,
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    extraMounts: [],
    env: [],
    ...rest,
  };
}

function makeConfig(profile: Profile): Config {
  return { profiles: { default: profile }, ui: DEFAULT_UI_CONFIG };
}

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
const canBindMount = Deno.env.get("NAS_DIND_SHARED_TMP") !== undefined ||
  !Deno.env.get("DOCKER_HOST");

async function makeDockerBindableTempDir(prefix: string): Promise<string> {
  const base = Deno.env.get("NAS_DIND_SHARED_TMP") ?? "/tmp";
  const dir = `${base}/${prefix}${crypto.randomUUID().slice(0, 8)}`;
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  if (Deno.env.get("NAS_DIND_SHARED_TMP")) {
    await Deno.chmod(dir, 0o1777);
  }
  return dir;
}

Deno.test({
  name: "ProxyStage: starts shared Envoy and injects credentialed proxy env",
  ignore: !proxyAvailable || !canBindMount,
  // sanitizer 無効化: Envoy コンテナのライフサイクルが Deno の
  // resource/op tracking と干渉するため
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const envoyContainerName = `nas-envoy-test-${
      crypto.randomUUID().slice(0, 8)
    }`;
    const runtimeRoot = await makeDockerBindableTempDir("nas-proxy-runtime-");
    const oldRuntimeDir = Deno.env.get("XDG_RUNTIME_DIR");
    Deno.env.set("XDG_RUNTIME_DIR", runtimeRoot);

    const profile = makeProfile({
      network: {
        allowlist: ["example.com"],
      },
    });
    const config = makeConfig(profile);
    const sessionId = `sess_${crypto.randomUUID().slice(0, 12)}`;

    const hostEnv: HostEnv = {
      home: Deno.env.get("HOME") ?? "/home/test",
      user: Deno.env.get("USER") ?? "test",
      uid: typeof Deno.uid === "function" ? Deno.uid() : 1000,
      gid: typeof Deno.gid === "function" ? Deno.gid() : 1000,
      isWSL: false,
      env: new Map([["XDG_RUNTIME_DIR", runtimeRoot]]),
    };
    const probes: ProbeResults = {
      hasHostNix: false,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: `${runtimeRoot}/audit`,
    };
    const prior: PriorStageOutputs = {
      dockerArgs: [],
      envVars: {},
      workDir: "/tmp",
      nixEnabled: false,
      imageName: "test-image",
      agentCommand: ["claude"],
      networkPromptEnabled: false,
      dbusProxyEnabled: false,
    };

    const input: StageInput = {
      config,
      profile,
      profileName: "default",
      sessionId,
      host: hostEnv,
      probes,
      prior,
    };

    const stage = createProxyStage({ envoyContainerName });
    const plan = stage.plan(input);
    assertEquals(plan !== null, true);

    const runtimePaths = buildNetworkRuntimePaths(hostEnv);

    const handles = [];
    try {
      // Ensure runtime dir exists for envoy config bind mount
      await Deno.mkdir(runtimePaths.runtimeDir, {
        recursive: true,
        mode: 0o755,
      });
      await Deno.mkdir(runtimePaths.sessionsDir, {
        recursive: true,
        mode: 0o700,
      });
      await Deno.mkdir(runtimePaths.pendingDir, {
        recursive: true,
        mode: 0o700,
      });
      await Deno.mkdir(runtimePaths.brokersDir, {
        recursive: true,
        mode: 0o700,
      });

      // Write a stale envoy.yaml to verify it gets overwritten
      await Deno.writeTextFile(runtimePaths.envoyConfigFile, "# stale\n", {
        create: true,
        mode: 0o600,
      });

      handles.push(...await executePlan(plan!));

      // http_proxy / https_proxy should point to local proxy
      assertEquals(plan!.envVars["http_proxy"], "http://127.0.0.1:18080");
      assertEquals(plan!.envVars["https_proxy"], "http://127.0.0.1:18080");
      // NAS_UPSTREAM_PROXY should contain the credentialed upstream URL
      assertMatch(
        plan!.envVars["NAS_UPSTREAM_PROXY"],
        /^http:\/\/sess_[a-f0-9-]{12}:[A-Za-z0-9_-]+@nas-envoy:15001$/,
      );
      assertEquals(
        typeof plan!.outputOverrides.networkBrokerSocket,
        "string",
      );
      assertEquals(
        plan!.outputOverrides.networkRuntimeDir?.startsWith(runtimeRoot),
        true,
      );
      assertEquals(
        plan!.dockerArgs.includes(`nas-session-net-${sessionId}`),
        true,
      );
      assertEquals(
        ((await Deno.stat(runtimePaths.runtimeDir)).mode ?? 0) & 0o777,
        0o755,
      );
      assertEquals(
        ((await Deno.stat(runtimePaths.envoyConfigFile)).mode ?? 0) & 0o777,
        0o644,
      );
      assertEquals(await dockerIsRunning(envoyContainerName), true);
    } finally {
      await teardownHandles(handles).catch(() => {});
      await cleanupRuntime(runtimeRoot, envoyContainerName);
      if (oldRuntimeDir) {
        Deno.env.set("XDG_RUNTIME_DIR", oldRuntimeDir);
      } else {
        Deno.env.delete("XDG_RUNTIME_DIR");
      }
    }
  },
});

async function cleanupRuntime(
  runtimeRoot: string,
  envoyContainerName: string,
): Promise<void> {
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
  await dockerStop(envoyContainerName).catch(() => {});
  await dockerRm(envoyContainerName).catch(() => {});
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
