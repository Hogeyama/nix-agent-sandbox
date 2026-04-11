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
 * DindStage unit テスト（Docker 不要）
 *
 * PlanStage 化された DindStage の plan() メソッドの検証と、引数生成の検証を行う。
 * 実 Docker を使う integration テストは dind_stage_integration_test.ts を参照。
 */

import type { Config, Profile } from "../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../config/types.ts";
import type {
  DindSidecarEffect,
  HostEnv,
  ProbeResults,
  StageInput,
} from "../pipeline/types.ts";
import { buildDindSidecarArgs, createDindStage } from "./dind.ts";

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

test("DindStage: skip when disabled (plan returns null)", () => {
  const profile = makeProfile({ docker: { enable: false, shared: false } });
  const input = makeStageInput(profile);
  const stage = createDindStage();
  const plan = stage.plan(input);
  expect(plan).toEqual(null);
});

test("DindStage: shared mode uses fixed names", () => {
  const profile = makeProfile({ docker: { enable: true, shared: true } });
  const input = makeStageInput(profile);
  const stage = createDindStage({
    disableCache: true,
    readinessTimeoutMs: 20_000,
  });
  const plan = stage.plan(input);

  expect(plan !== null).toEqual(true);
  expect(plan!.effects.length).toEqual(1);

  const effect = plan!.effects[0] as DindSidecarEffect;
  expect(effect.kind).toEqual("dind-sidecar");
  expect(effect.containerName).toEqual("nas-dind-shared");
  expect(effect.networkName).toEqual("nas-dind-shared");
  expect(effect.sharedTmpVolume).toEqual("nas-dind-shared-tmp");
  expect(effect.shared).toEqual(true);
  expect(effect.disableCache).toEqual(true);
  expect(effect.readinessTimeoutMs).toEqual(20_000);

  // dockerArgs should contain --network and -v
  expect(plan!.dockerArgs).toEqual([
    "--network",
    "nas-dind-shared",
    "-v",
    "nas-dind-shared-tmp:/tmp/nas-shared",
  ]);

  // envVars
  expect(plan!.envVars["DOCKER_HOST"]).toEqual("tcp://nas-dind-shared:2375");
  expect(plan!.envVars["NAS_DIND_CONTAINER_NAME"]).toEqual("nas-dind-shared");
  expect(plan!.envVars["NAS_DIND_SHARED_TMP"]).toEqual("/tmp/nas-shared");

  // outputOverrides
  expect(plan!.outputOverrides.dindContainerName).toEqual("nas-dind-shared");
  expect(plan!.outputOverrides.networkName).toEqual("nas-dind-shared");
});

test("DindStage: non-shared mode uses session-based names", () => {
  const profile = makeProfile({ docker: { enable: true, shared: false } });
  const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
  const input = makeStageInput(profile, sessionId);
  const stage = createDindStage();
  const plan = stage.plan(input);

  expect(plan !== null).toEqual(true);

  const effect = plan!.effects[0] as DindSidecarEffect;
  expect(effect.kind).toEqual("dind-sidecar");
  // sessionId の先頭 8 文字を使う
  expect(effect.containerName).toEqual("nas-dind-abcdef12");
  expect(effect.networkName).toEqual("nas-dind-abcdef12");
  expect(effect.sharedTmpVolume).toEqual("nas-dind-tmp-abcdef12");
  expect(effect.shared).toEqual(false);

  expect(plan!.dockerArgs[1]).toEqual("nas-dind-abcdef12");
  expect(plan!.envVars["DOCKER_HOST"]).toEqual("tcp://nas-dind-abcdef12:2375");
});

test("DindStage: default options", () => {
  const profile = makeProfile({ docker: { enable: true, shared: false } });
  const input = makeStageInput(profile);
  const stage = createDindStage();
  const plan = stage.plan(input);

  const effect = plan!.effects[0] as DindSidecarEffect;
  expect(effect.disableCache).toEqual(false);
  expect(effect.readinessTimeoutMs).toEqual(30_000);
});

test("buildDindSidecarArgs: cache enabled keeps both volume specs valid", () => {
  expect(buildDindSidecarArgs("nas-dind-shared-tmp")).toEqual([
    "--privileged",
    "-v",
    "nas-docker-cache:/home/rootless/.local/share/docker",
    "-v",
    "nas-dind-shared-tmp:/tmp/nas-shared",
  ]);
});

test("buildDindSidecarArgs: cache disabled only mounts shared tmp", () => {
  expect(
    buildDindSidecarArgs("nas-dind-shared-tmp", { disableCache: true }),
  ).toEqual(["--privileged", "-v", "nas-dind-shared-tmp:/tmp/nas-shared"]);
});
