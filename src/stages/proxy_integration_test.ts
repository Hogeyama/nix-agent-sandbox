import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
/**
 * ProxyStage integration テスト（実 Docker daemon 必要）
 *
 * Envoy コンテナ起動とプロキシ設定の注入を検証する。
 * unit テスト（skip 判定, replaceNetwork, parseDindContainerName）は
 * proxy_stage_test.ts を参照。
 */

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
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
    const exitCode = await Bun.spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

const proxyAvailable = await canRunProxy();
const canBindMount = process.env["NAS_DIND_SHARED_TMP"] !== undefined ||
  !process.env["DOCKER_HOST"];

async function makeDockerBindableTempDir(prefix: string): Promise<string> {
  const base = process.env["NAS_DIND_SHARED_TMP"] ?? "/tmp";
  const dir = `${base}/${prefix}${crypto.randomUUID().slice(0, 8)}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.env["NAS_DIND_SHARED_TMP"]) {
    await chmod(dir, 0o1777);
  }
  return dir;
}

test.skipIf(!proxyAvailable || !canBindMount)(
  "ProxyStage: starts shared Envoy and injects credentialed proxy env",
  async () => {
    const envoyContainerName = `nas-envoy-test-${
      crypto.randomUUID().slice(0, 8)
    }`;
    const runtimeRoot = await makeDockerBindableTempDir("nas-proxy-runtime-");
    const oldRuntimeDir = process.env["XDG_RUNTIME_DIR"];
    process.env["XDG_RUNTIME_DIR"] = runtimeRoot;

    const profile = makeProfile({
      network: {
        allowlist: ["example.com"],
      },
    });
    const config = makeConfig(profile);
    const sessionId = `sess_${crypto.randomUUID().slice(0, 12)}`;

    const hostEnv: HostEnv = {
      home: process.env["HOME"] ?? "/home/test",
      user: process.env["USER"] ?? "test",
      uid: (process.getuid?.() ?? 1000),
      gid: (process.getgid?.() ?? 1000),
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
    expect(plan !== null).toEqual(true);

    const runtimePaths = buildNetworkRuntimePaths(hostEnv);

    const handles = [];
    try {
      // Ensure runtime dir exists for envoy config bind mount
      await mkdir(runtimePaths.runtimeDir, {
        recursive: true,
        mode: 0o755,
      });
      await mkdir(runtimePaths.sessionsDir, {
        recursive: true,
        mode: 0o700,
      });
      await mkdir(runtimePaths.pendingDir, {
        recursive: true,
        mode: 0o700,
      });
      await mkdir(runtimePaths.brokersDir, {
        recursive: true,
        mode: 0o700,
      });

      // Write a stale envoy.yaml to verify it gets overwritten
      await writeFile(runtimePaths.envoyConfigFile, "# stale\n", {
        mode: 0o600,
      });

      handles.push(...await executePlan(plan!));

      // http_proxy / https_proxy should point to local proxy
      expect(plan!.envVars["http_proxy"]).toEqual("http://127.0.0.1:18080");
      expect(plan!.envVars["https_proxy"]).toEqual("http://127.0.0.1:18080");
      // NAS_UPSTREAM_PROXY should contain the credentialed upstream URL
      expect(plan!.envVars["NAS_UPSTREAM_PROXY"]).toMatch(
        /^http:\/\/sess_[a-f0-9-]{12}:[A-Za-z0-9_-]+@nas-envoy:15001$/,
      );
      expect(typeof plan!.outputOverrides.networkBrokerSocket).toEqual(
        "string",
      );
      expect(plan!.outputOverrides.networkRuntimeDir?.startsWith(runtimeRoot))
        .toEqual(true);
      expect(plan!.dockerArgs.includes(`nas-session-net-${sessionId}`)).toEqual(
        true,
      );
      expect(((await stat(runtimePaths.runtimeDir)).mode ?? 0) & 0o777).toEqual(
        0o755,
      );
      expect(((await stat(runtimePaths.envoyConfigFile)).mode ?? 0) & 0o777)
        .toEqual(0o644);
      expect(await dockerIsRunning(envoyContainerName)).toEqual(true);
    } finally {
      await teardownHandles(handles).catch(() => {});
      await cleanupRuntime(runtimeRoot, envoyContainerName);
      if (oldRuntimeDir) {
        process.env["XDG_RUNTIME_DIR"] = oldRuntimeDir;
      } else {
        delete process.env["XDG_RUNTIME_DIR"];
      }
    }
  },
  30_000,
);

async function cleanupRuntime(
  runtimeRoot: string,
  envoyContainerName: string,
): Promise<void> {
  const networkDir = `${runtimeRoot}/nas/network`;
  const pidFile = `${networkDir}/auth-router.pid`;
  try {
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      await Bun.spawn(["kill", String(pid)], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    }
  } catch {
    // noop
  }
  await dockerStop(envoyContainerName).catch(() => {});
  await dockerRm(envoyContainerName).catch(() => {});
  for (const sessionId of await listSessionNetworks(networkDir)) {
    await dockerNetworkRemove(`nas-session-net-${sessionId}`).catch(() => {});
  }
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}

async function listSessionNetworks(networkDir: string): Promise<string[]> {
  try {
    const sessionsDir = `${networkDir}/sessions`;
    const ids: string[] = [];
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      ids.push(entry.name.replace(/\.json$/, ""));
    }
    return ids;
  } catch {
    return [];
  }
}
