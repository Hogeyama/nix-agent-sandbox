/**
 * DindStage 統合テスト
 *
 * Unit tests (Docker 不要) と Integration tests (実 Docker 使用) を含む。
 * DinD rootless は --privileged と user namespace サポートが必要なため、
 * 対応していない環境では統合テストを自動スキップする。
 */

import { assertEquals } from "@std/assert";
import { DEFAULT_NETWORK_CONFIG } from "../src/config/types.ts";
import { buildDindSidecarArgs, DindStage } from "../src/stages/dind.ts";
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

async function canRunDocker(): Promise<boolean> {
  try {
    const result = await new Deno.Command("docker", {
      args: ["version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return result.success;
  } catch {
    return false;
  }
}

// 起動時に一度だけチェック
const dockerAvailable = await canRunDocker();
const dindAvailable = await canRunDindRootless();

function makeStage(): DindStage {
  return new DindStage({
    disableCache: true,
    readinessTimeoutMs: 20_000,
  });
}

// ============================================================
// Unit tests (Docker 不要)
// ============================================================

Deno.test("DindStage: skip when disabled", async () => {
  const profile = makeProfile({ docker: { enable: false, shared: false } });
  const ctx = makeCtx(profile);
  const stage = new DindStage();
  const result = await stage.execute(ctx);
  assertEquals(result, ctx);
  assertEquals(result.dockerArgs, []);
  assertEquals(result.envVars, {});
});

Deno.test("buildDindSidecarArgs: cache enabled keeps both volume specs valid", () => {
  assertEquals(
    buildDindSidecarArgs("nas-dind-shared-tmp"),
    [
      "--privileged",
      "-v",
      "nas-docker-cache:/home/rootless/.local/share/docker",
      "-v",
      "nas-dind-shared-tmp:/tmp/nas-shared",
    ],
  );
});

Deno.test("buildDindSidecarArgs: cache disabled only mounts shared tmp", () => {
  assertEquals(
    buildDindSidecarArgs("nas-dind-shared-tmp", { disableCache: true }),
    [
      "--privileged",
      "-v",
      "nas-dind-shared-tmp:/tmp/nas-shared",
    ],
  );
});

// ============================================================
// Integration tests (実 Docker 使用, DinD rootless 必須)
// ============================================================

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

async function isSharedSidecarReusable(
  containerName: string,
): Promise<boolean> {
  if (!await dockerIsRunning(containerName)) {
    return false;
  }
  const result = await new Deno.Command("docker", {
    args: [
      "exec",
      containerName,
      "docker",
      "-H",
      "tcp://127.0.0.1:2375",
      "info",
    ],
    stdout: "null",
    stderr: "null",
  }).output();
  return result.success;
}

async function startSharedReuseStub(
  containerName: string,
  volumeName: string,
): Promise<void> {
  await new Deno.Command("docker", {
    args: [
      "run",
      "-d",
      "--name",
      containerName,
      "-v",
      `${volumeName}:/tmp/nas-shared`,
      "alpine:latest",
      "sleep",
      "300",
    ],
    stdout: "null",
    stderr: "null",
  }).output();
}

Deno.test({
  name:
    "DindStage: non-shared execute sets DOCKER_HOST and teardown removes resources",
  ignore: !dindAvailable,
  fn: async () => {
    const profile = makeProfile({ docker: { enable: true, shared: false } });
    const ctx = makeCtx(profile);
    const stage = makeStage();
    let containerName: string | undefined;

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

      const match = result.envVars["DOCKER_HOST"].match(
        /tcp:\/\/([^:]+):2375/,
      );
      containerName = match?.[1];
      assertEquals(typeof containerName, "string");

      const running = await dockerIsRunning(containerName!);
      assertEquals(running, true);
    } catch (e) {
      if (containerName) {
        await dockerStop(containerName, { timeoutSeconds: 0 }).catch(() => {});
        await dockerRm(containerName).catch(() => {});
      }
      throw e;
    } finally {
      await stage.teardown(ctx);
      if (containerName) {
        const afterRunning = await dockerIsRunning(containerName);
        assertEquals(afterRunning, false);
      }
    }
  },
});

Deno.test({
  name:
    "DindStage: shared mode uses fixed name, reuses sidecar, and keeps it on teardown",
  ignore: !dockerAvailable,
  fn: async () => {
    const containerName = "nas-dind-shared";
    const networkName = "nas-dind-shared";
    const volumeName = "nas-dind-shared-tmp";

    if (!await isSharedSidecarReusable(containerName)) {
      await forceCleanup(containerName, networkName, volumeName);
      await startSharedReuseStub(containerName, volumeName);
    }

    const profile = makeProfile({ docker: { enable: true, shared: true } });
    const ctx = makeCtx(profile);
    const stage1 = makeStage();
    const stage2 = makeStage();

    try {
      const result1 = await stage1.execute(ctx);

      assertEquals(
        result1.envVars["DOCKER_HOST"],
        "tcp://nas-dind-shared:2375",
      );
      assertEquals(
        result1.envVars["NAS_DIND_CONTAINER_NAME"],
        "nas-dind-shared",
      );

      const networkIdx = result1.dockerArgs.indexOf("--network");
      assertEquals(result1.dockerArgs[networkIdx + 1], "nas-dind-shared");

      const result2 = await stage2.execute(ctx);
      assertEquals(
        result2.envVars["DOCKER_HOST"],
        "tcp://nas-dind-shared:2375",
      );

      const running = await dockerIsRunning(containerName);
      assertEquals(running, true);
      await stage1.teardown(ctx);

      const runningAfterTeardown = await dockerIsRunning(containerName);
      assertEquals(runningAfterTeardown, true);
    } finally {
      await forceCleanup(containerName, networkName, volumeName);
    }
  },
});
