/**
 * DindStage unit テスト（Docker 不要）
 *
 * PlanStage 化された DindStage の plan() メソッドの検証と、引数生成の検証を行う。
 * 実 Docker を使う integration テストは dind_stage_integration_test.ts を参照。
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../src/config/types.ts";
import { buildDindSidecarArgs, createDindStage } from "../src/stages/dind.ts";
import type { Config, Profile } from "../src/config/types.ts";
import type {
  DindSidecarEffect,
  HostEnv,
  ProbeResults,
  StageInput,
} from "../src/pipeline/types.ts";

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

// ============================================================
// Unit tests (Docker 不要)
// ============================================================

Deno.test("DindStage: skip when disabled (plan returns null)", () => {
  const profile = makeProfile({ docker: { enable: false, shared: false } });
  const input = makeStageInput(profile);
  const stage = createDindStage();
  const plan = stage.plan(input);
  assertEquals(plan, null);
});

Deno.test("DindStage: shared mode uses fixed names", () => {
  const profile = makeProfile({ docker: { enable: true, shared: true } });
  const input = makeStageInput(profile);
  const stage = createDindStage({
    disableCache: true,
    readinessTimeoutMs: 20_000,
  });
  const plan = stage.plan(input);

  assertEquals(plan !== null, true);
  assertEquals(plan!.effects.length, 1);

  const effect = plan!.effects[0] as DindSidecarEffect;
  assertEquals(effect.kind, "dind-sidecar");
  assertEquals(effect.containerName, "nas-dind-shared");
  assertEquals(effect.networkName, "nas-dind-shared");
  assertEquals(effect.sharedTmpVolume, "nas-dind-shared-tmp");
  assertEquals(effect.shared, true);
  assertEquals(effect.disableCache, true);
  assertEquals(effect.readinessTimeoutMs, 20_000);

  // dockerArgs should contain --network and -v
  assertEquals(plan!.dockerArgs, [
    "--network",
    "nas-dind-shared",
    "-v",
    "nas-dind-shared-tmp:/tmp/nas-shared",
  ]);

  // envVars
  assertEquals(plan!.envVars["DOCKER_HOST"], "tcp://nas-dind-shared:2375");
  assertEquals(plan!.envVars["NAS_DIND_CONTAINER_NAME"], "nas-dind-shared");
  assertEquals(plan!.envVars["NAS_DIND_SHARED_TMP"], "/tmp/nas-shared");

  // outputOverrides
  assertEquals(plan!.outputOverrides.dindContainerName, "nas-dind-shared");
  assertEquals(plan!.outputOverrides.networkName, "nas-dind-shared");
});

Deno.test("DindStage: non-shared mode uses session-based names", () => {
  const profile = makeProfile({ docker: { enable: true, shared: false } });
  const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
  const input = makeStageInput(profile, sessionId);
  const stage = createDindStage();
  const plan = stage.plan(input);

  assertEquals(plan !== null, true);

  const effect = plan!.effects[0] as DindSidecarEffect;
  assertEquals(effect.kind, "dind-sidecar");
  // sessionId の先頭 8 文字を使う
  assertEquals(effect.containerName, "nas-dind-abcdef12");
  assertEquals(effect.networkName, "nas-dind-abcdef12");
  assertEquals(effect.sharedTmpVolume, "nas-dind-tmp-abcdef12");
  assertEquals(effect.shared, false);

  assertEquals(plan!.dockerArgs[1], "nas-dind-abcdef12");
  assertEquals(plan!.envVars["DOCKER_HOST"], "tcp://nas-dind-abcdef12:2375");
});

Deno.test("DindStage: default options", () => {
  const profile = makeProfile({ docker: { enable: true, shared: false } });
  const input = makeStageInput(profile);
  const stage = createDindStage();
  const plan = stage.plan(input);

  const effect = plan!.effects[0] as DindSidecarEffect;
  assertEquals(effect.disableCache, false);
  assertEquals(effect.readinessTimeoutMs, 30_000);
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
