import { expect, test } from "bun:test";

/**
 * DindStage integration テスト（実 Docker 使用, DinD rootless 必須）
 *
 * DinD rootless は --privileged と user namespace サポートが必要なため、
 * 対応していない環境では自動スキップする。
 */

import { Effect, Exit, Scope } from "effect";
import type { Config, Profile } from "../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import {
  dockerIsRunning,
  dockerNetworkRemove,
  dockerRm,
  dockerStop,
  dockerVolumeRemove,
} from "../docker/client.ts";
import type { HostEnv, ProbeResults, StageInput } from "../pipeline/types.ts";
import { DindServiceLive } from "../services/dind.ts";
import { createDindStage, planDind } from "./dind.ts";

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
    session: DEFAULT_SESSION_CONFIG,
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: {
      ...baseNetwork,
      ...network,
      prompt: {
        ...baseNetwork.prompt,
        ...network?.prompt,
      },
    },
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
    ...rest,
  };
}

function makeConfig(profile: Profile): Config {
  return { profiles: { default: profile }, ui: DEFAULT_UI_CONFIG };
}

function makeStageInput(
  profile: Profile,
  sessionId = "test-session-1234",
): StageInput {
  const config = makeConfig(profile);
  const hostEnv: HostEnv = {
    home: "/home/test",
    user: "test",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map(),
  };
  const probes: ProbeResults = {
    hasHostNix: false,
    xdgDbusProxyPath: null,
    dbusSessionAddress: null,
    gpgAgentSocket: null,
    auditDir: "/tmp/audit",
  };
  return {
    config,
    profile,
    profileName: "default",
    sessionId,
    host: hostEnv,
    probes,
    prior: {
      dockerArgs: [],
      envVars: {},
      workDir: "/tmp",
      nixEnabled: false,
      imageName: "nas:latest",
      agentCommand: ["claude"],
      networkPromptEnabled: false,
      dbusProxyEnabled: false,
    },
  };
}

/**
 * DinD rootless が動作可能か事前チェック。
 * コンテナを起動して数秒待ち、まだ running なら OK。
 */
async function canRunDindRootless(): Promise<boolean> {
  const name = "nas-test-dind-probe";
  try {
    const exitCode = await Bun.spawn(
      [
        "docker",
        "run",
        "-d",
        "--rm",
        "--privileged",
        "--name",
        name,
        "-e",
        "DOCKER_TLS_CERTDIR=",
        "docker:dind-rootless",
      ],
      { stdout: "ignore", stderr: "ignore" },
    ).exited;
    if (exitCode !== 0) return false;

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const running = await dockerIsRunning(name);
      if (running) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  } catch {
    return false;
  } finally {
    await dockerStop(name, { timeoutSeconds: 0 }).catch(() => {});
    await dockerRm(name).catch(() => {});
  }
}

const RUNNING_ON_HOST_DOCKER = !process.env.DOCKER_HOST;
const dindAvailable = await canRunDindRootless();

async function forceCleanup(
  containerName: string,
  networkName: string,
  volumeName: string,
): Promise<void> {
  await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
  await dockerRm(containerName).catch(() => {});
  await dockerNetworkRemove(networkName).catch(() => {});
  await dockerVolumeRemove(volumeName).catch(() => {});
}

void forceCleanup; // suppress unused warning (available for manual cleanup)

test.skipIf(!dindAvailable || !RUNNING_ON_HOST_DOCKER)(
  "DindStage: non-shared execute sets DOCKER_HOST and teardown removes resources",
  async () => {
    const profile = makeProfile({ docker: { enable: true, shared: false } });
    const input = makeStageInput(profile);
    const plan = planDind(input, {
      disableCache: true,
      readinessTimeoutMs: 20_000,
    });
    expect(plan).not.toBeNull();

    const containerName = plan!.containerName;

    const scope = Effect.runSync(Scope.make());
    try {
      const stage = createDindStage({
        disableCache: true,
        readinessTimeoutMs: 20_000,
      });
      const result = await Effect.runPromise(
        stage
          .run(input)
          .pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provide(DindServiceLive),
          ),
      );

      expect(result.envVars!.DOCKER_HOST.startsWith("tcp://")).toEqual(true);
      expect(result.envVars!.DOCKER_HOST.endsWith(":2375")).toEqual(true);
      expect(typeof result.envVars!.NAS_DIND_CONTAINER_NAME).toEqual("string");
      expect(typeof result.envVars!.NAS_DIND_SHARED_TMP).toEqual("string");

      const networkIdx = result.dockerArgs!.indexOf("--network");
      expect(networkIdx !== -1).toEqual(true);
      expect(
        result.dockerArgs![networkIdx + 1].startsWith("nas-dind-"),
      ).toEqual(true);

      const running = await dockerIsRunning(containerName);
      expect(running).toEqual(true);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      const afterRunning = await dockerIsRunning(containerName);
      expect(afterRunning).toEqual(false);
    }
  },
  30_000,
);
