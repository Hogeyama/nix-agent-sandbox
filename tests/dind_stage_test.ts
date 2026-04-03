/**
 * DindStage unit テスト（Docker 不要）
 *
 * fake docker script を使った共有モードテストと、引数生成の検証を行う。
 * 実 Docker を使う integration テストは dind_stage_integration_test.ts を参照。
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../src/config/types.ts";
import { buildDindSidecarArgs, DindStage } from "../src/stages/dind.ts";
import { createContext } from "../src/pipeline/context.ts";
import type { Config, Profile } from "../src/config/types.ts";
import type { ExecutionContext } from "../src/pipeline/context.ts";

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
    extraMounts: [],
    env: [],
    ...rest,
  };
}

function makeConfig(profile: Profile): Config {
  return { profiles: { default: profile }, ui: DEFAULT_UI_CONFIG };
}

function makeCtx(profile: Profile): ExecutionContext {
  return createContext(makeConfig(profile), profile, "default", "/tmp");
}

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

async function withFakeDockerForDind(
  fn: (paths: { dir: string; logPath: string }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "nas-dind-test-" });
  const logPath = `${dir}/docker.log`;
  const originalPath = Deno.env.get("PATH") ?? "";

  try {
    // fake docker: inspect は running 状態を返し、その他は成功する
    await Deno.writeTextFile(
      `${dir}/docker`,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${logPath}"
if [[ "\$1" == "inspect" ]]; then
  # dockerIsRunning: --format={{.State.Running}}
  if [[ "\$*" == *"State.Running"* ]]; then
    printf 'true\\n'
    exit 0
  fi
  # dockerContainerIp: --format=...IPAddress...
  if [[ "\$*" == *"IPAddress"* ]]; then
    printf '172.17.0.2\\n'
    exit 0
  fi
  exit 0
fi
# exec, network create, network connect, volume create など全て成功
exit 0
`,
    );
    await Deno.chmod(`${dir}/docker`, 0o755);
    Deno.env.set("PATH", `${dir}:${originalPath}`);
    await fn({ dir, logPath });
  } finally {
    Deno.env.set("PATH", originalPath);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test(
  "DindStage: shared mode uses fixed name, reuses sidecar, and keeps it on teardown",
  async () => {
    await withFakeDockerForDind(async ({ logPath }) => {
      const profile = makeProfile({ docker: { enable: true, shared: true } });
      const ctx = makeCtx(profile);
      const stage1 = makeStage();
      const stage2 = makeStage();

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

      // teardown 前のログを記録し、teardown 後に docker stop/rm が追加されていないことを確認
      const logBeforeTeardown = await Deno.readTextFile(logPath);
      await stage1.teardown(ctx);
      const logAfterTeardown = await Deno.readTextFile(logPath);
      assertEquals(logBeforeTeardown, logAfterTeardown);
    });
  },
);
