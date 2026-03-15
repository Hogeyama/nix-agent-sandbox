/**
 * DindStage 統合テスト
 *
 * Unit tests (Docker 不要) と Integration tests (実 Docker 使用) を含む。
 * DinD rootless は --privileged と user namespace サポートが必要なため、
 * 対応していない環境では統合テストを自動スキップする。
 */

import { assertEquals } from "@std/assert";
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

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    network: { allowlist: [] },
    extraMounts: [],
    env: [],
    ...overrides,
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

    // rootlesskit の起動に少し時間がかかるので待つ
    await new Promise((r) => setTimeout(r, 3000));
    const running = await dockerIsRunning(name);
    return running;
  } catch {
    return false;
  } finally {
    await dockerStop(name).catch(() => {});
    await dockerRm(name).catch(() => {});
  }
}

// 起動時に一度だけチェック
const dindAvailable = await canRunDindRootless();

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

// ============================================================
// Integration tests (実 Docker 使用, DinD rootless 必須)
// ============================================================

async function forceCleanup(
  containerName: string,
  networkName: string,
  volumeName: string,
): Promise<void> {
  await dockerStop(containerName).catch(() => {});
  await dockerRm(containerName).catch(() => {});
  await dockerNetworkRemove(networkName).catch(() => {});
  await dockerVolumeRemove(volumeName).catch(() => {});
}

Deno.test({
  name: "DindStage: non-shared execute sets DOCKER_HOST and network",
  ignore: !dindAvailable,
  fn: async () => {
    const profile = makeProfile({ docker: { enable: true, shared: false } });
    const ctx = makeCtx(profile);
    const stage = new DindStage();

    try {
      const result = await stage.execute(ctx);

      assertEquals(typeof result.envVars["DOCKER_HOST"], "string");
      assertEquals(result.envVars["DOCKER_HOST"].startsWith("tcp://"), true);
      assertEquals(result.envVars["DOCKER_HOST"].endsWith(":2375"), true);

      assertEquals(typeof result.envVars["NAS_DIND_SHARED_TMP"], "string");

      const networkIdx = result.dockerArgs.indexOf("--network");
      assertEquals(networkIdx !== -1, true);
      const networkName = result.dockerArgs[networkIdx + 1];
      assertEquals(networkName.startsWith("nas-dind-"), true);
    } finally {
      await stage.teardown(ctx);
    }
  },
});

Deno.test({
  name: "DindStage: non-shared teardown removes resources",
  ignore: !dindAvailable,
  fn: async () => {
    const profile = makeProfile({ docker: { enable: true, shared: false } });
    const ctx = makeCtx(profile);
    const stage = new DindStage();

    let containerName: string | undefined;

    try {
      const result = await stage.execute(ctx);

      const match = result.envVars["DOCKER_HOST"].match(
        /tcp:\/\/([^:]+):2375/,
      );
      containerName = match?.[1];
      assertEquals(typeof containerName, "string");

      const running = await dockerIsRunning(containerName!);
      assertEquals(running, true);

      await stage.teardown(ctx);

      const afterRunning = await dockerIsRunning(containerName!);
      assertEquals(afterRunning, false);
    } catch (e) {
      if (containerName) {
        await dockerStop(containerName).catch(() => {});
        await dockerRm(containerName).catch(() => {});
      }
      throw e;
    }
  },
});

Deno.test({
  name: "DindStage: shared execute uses fixed name nas-dind-shared",
  ignore: !dindAvailable,
  fn: async () => {
    const containerName = "nas-dind-shared";
    const networkName = "nas-dind-shared";
    const volumeName = "nas-dind-shared-tmp";

    await forceCleanup(containerName, networkName, volumeName);

    const profile = makeProfile({ docker: { enable: true, shared: true } });
    const ctx = makeCtx(profile);
    const stage = new DindStage();

    try {
      const result = await stage.execute(ctx);

      assertEquals(
        result.envVars["DOCKER_HOST"],
        "tcp://nas-dind-shared:2375",
      );

      const networkIdx = result.dockerArgs.indexOf("--network");
      assertEquals(result.dockerArgs[networkIdx + 1], "nas-dind-shared");

      const running = await dockerIsRunning(containerName);
      assertEquals(running, true);
    } finally {
      await forceCleanup(containerName, networkName, volumeName);
    }
  },
});

Deno.test({
  name: "DindStage: shared reuse existing sidecar",
  ignore: !dindAvailable,
  fn: async () => {
    const containerName = "nas-dind-shared";
    const networkName = "nas-dind-shared";
    const volumeName = "nas-dind-shared-tmp";

    await forceCleanup(containerName, networkName, volumeName);

    const profile = makeProfile({ docker: { enable: true, shared: true } });
    const ctx = makeCtx(profile);
    const stage1 = new DindStage();
    const stage2 = new DindStage();

    try {
      const result1 = await stage1.execute(ctx);
      assertEquals(
        result1.envVars["DOCKER_HOST"],
        "tcp://nas-dind-shared:2375",
      );

      const result2 = await stage2.execute(ctx);
      assertEquals(
        result2.envVars["DOCKER_HOST"],
        "tcp://nas-dind-shared:2375",
      );

      const running = await dockerIsRunning(containerName);
      assertEquals(running, true);
    } finally {
      await forceCleanup(containerName, networkName, volumeName);
    }
  },
});

Deno.test({
  name: "DindStage: shared teardown does not remove sidecar",
  ignore: !dindAvailable,
  fn: async () => {
    const containerName = "nas-dind-shared";
    const networkName = "nas-dind-shared";
    const volumeName = "nas-dind-shared-tmp";

    await forceCleanup(containerName, networkName, volumeName);

    const profile = makeProfile({ docker: { enable: true, shared: true } });
    const ctx = makeCtx(profile);
    const stage = new DindStage();

    try {
      await stage.execute(ctx);

      await stage.teardown(ctx);

      const running = await dockerIsRunning(containerName);
      assertEquals(running, true);
    } finally {
      await forceCleanup(containerName, networkName, volumeName);
    }
  },
});
