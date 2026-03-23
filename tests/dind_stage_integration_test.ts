/**
 * DindStage integration テスト（実 Docker 使用, DinD rootless 必須）
 *
 * DinD rootless は --privileged と user namespace サポートが必要なため、
 * 対応していない環境では自動スキップする。
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_NETWORK_CONFIG,
} from "../src/config/types.ts";
import { DindStage } from "../src/stages/dind.ts";
import { createContext } from "../src/pipeline/context.ts";
import type { Config, Profile } from "../src/config/types.ts";
import type { ExecutionContext } from "../src/pipeline/context.ts";
import {
  dockerIsRunning,
  dockerNetworkRemove,
  dockerRm,
  dockerStop,
  dockerVolumeRemove,
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
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
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

/**
 * DinD rootless が動作可能か事前チェック。
 * コンテナを起動して数秒待ち、まだ running なら OK。
 */
async function canRunDindRootless(): Promise<boolean> {
  const name = "nas-test-dind-probe";
  try {
    const cmd = new Deno.Command("docker", {
      args: [
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
      stdout: "null",
      stderr: "null",
    });
    const result = await cmd.output();
    if (!result.success) return false;

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

const RUNNING_ON_HOST_DOCKER = !Deno.env.get("DOCKER_HOST");
const dindAvailable = await canRunDindRootless();

function makeStage(): DindStage {
  return new DindStage({
    disableCache: true,
    readinessTimeoutMs: 20_000,
  });
}

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

Deno.test({
  name:
    "DindStage: non-shared execute sets DOCKER_HOST and teardown removes resources",
  ignore: !dindAvailable || !RUNNING_ON_HOST_DOCKER,
  fn: async () => {
    const profile = makeProfile({ docker: { enable: true, shared: false } });
    const ctx = makeCtx(profile);
    const stage = makeStage();

    try {
      const result = await stage.execute(ctx);

      assertEquals(typeof result.envVars["DOCKER_HOST"], "string");
      assertEquals(result.envVars["DOCKER_HOST"].startsWith("tcp://"), true);
      assertEquals(result.envVars["DOCKER_HOST"].endsWith(":2375"), true);
      assertEquals(
        typeof result.envVars["NAS_DIND_CONTAINER_NAME"],
        "string",
      );
      assertEquals(
        result.envVars["DOCKER_HOST"].includes(
          result.envVars["NAS_DIND_CONTAINER_NAME"],
        ),
        true,
      );

      assertEquals(typeof result.envVars["NAS_DIND_SHARED_TMP"], "string");

      const networkIdx = result.dockerArgs.indexOf("--network");
      assertEquals(networkIdx !== -1, true);
      const networkName = result.dockerArgs[networkIdx + 1];
      assertEquals(networkName.startsWith("nas-dind-"), true);

      const containerName = stage.getContainerName();
      assertEquals(containerName !== null, true);

      const running = await dockerIsRunning(containerName!);
      assertEquals(running, true);
    } finally {
      const containerName = stage.getContainerName();
      await stage.teardown(ctx);
      if (containerName) {
        const afterRunning = await dockerIsRunning(containerName);
        assertEquals(afterRunning, false);
      }
    }
  },
});
