import { expect, test } from "bun:test";

/**
 * DindStage unit テスト（Docker 不要）
 *
 * EffectStage 化された DindStage の plan/run の検証と、引数生成の検証を行う。
 * 実 Docker を使う integration テストは dind_stage_integration_test.ts を参照。
 */

import { Effect, Exit, Scope } from "effect";
import type { Config, Profile } from "../../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../../config/types.ts";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { PipelineState } from "../../pipeline/state.ts";
import type {
  HostEnv,
  ProbeResults,
  StageInput,
} from "../../pipeline/types.ts";
import { type DindSidecarOpts, makeDindServiceFake } from "./dind_service.ts";
import {
  buildDindSidecarArgs,
  createDindStage,
  createDindStageWithOptions,
  type DindPlan,
  planDind,
} from "./stage.ts";

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
    network: {
      ...baseNetwork,
      ...network,
      prompt: {
        ...baseNetwork.prompt,
        ...network?.prompt,
      },
    },
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
    ...rest,
  };
}

function makeConfig(profile: Profile): Config {
  return { profiles: { default: profile }, ui: DEFAULT_UI_CONFIG };
}

function makeSharedInput(
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
  };
}

function makeStageState(
  overrides: Partial<Pick<PipelineState, "workspace" | "container">> = {},
): Pick<PipelineState, "workspace" | "container"> {
  const workspace = overrides.workspace ?? {
    workDir: "/tmp",
    imageName: "nas:latest",
  };
  const container = overrides.container ?? {
    ...emptyContainerPlan(workspace.imageName, workspace.workDir),
    command: { agentCommand: ["claude"], extraArgs: [] },
  };
  return { workspace, container };
}

// ============================================================
// planDind tests
// ============================================================

test("DindStage: skip when disabled (plan returns null)", () => {
  const profile = makeProfile({ docker: { enable: false, shared: false } });
  const input = { ...makeSharedInput(profile), ...makeStageState() };
  const plan = planDind(input);
  expect(plan).toEqual(null);
});

test("DindStage: shared mode uses fixed names", () => {
  const profile = makeProfile({ docker: { enable: true, shared: true } });
  const input = { ...makeSharedInput(profile), ...makeStageState() };
  const plan = planDind(input, {
    disableCache: true,
    readinessTimeoutMs: 20_000,
  });

  expect(plan).not.toBeNull();
  const p = plan as DindPlan;
  expect(p.containerName).toEqual("nas-dind-shared");
  expect(p.networkName).toEqual("nas-dind-shared");
  expect(p.sharedTmpVolume).toEqual("nas-dind-shared-tmp");
  expect(p.shared).toEqual(true);
  expect(p.disableCache).toEqual(true);
  expect(p.readinessTimeoutMs).toEqual(20_000);

  expect(p.outputOverrides.dind).toEqual({
    containerName: "nas-dind-shared",
  });
  expect(p.outputOverrides.container).toEqual({
    image: "nas:latest",
    workDir: "/tmp",
    mounts: [],
    env: {
      static: {
        DOCKER_HOST: "tcp://nas-dind-shared:2375",
        NAS_DIND_CONTAINER_NAME: "nas-dind-shared",
        NAS_DIND_SHARED_TMP: "/tmp/nas-shared",
      },
      dynamicOps: [],
    },
    network: { name: "nas-dind-shared" },
    extraRunArgs: ["-v", "nas-dind-shared-tmp:/tmp/nas-shared"],
    command: { agentCommand: ["claude"], extraArgs: [] },
    labels: {},
  });
});

test("DindStage: non-shared mode uses session-based names", () => {
  const profile = makeProfile({ docker: { enable: true, shared: false } });
  const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
  const input = {
    ...makeSharedInput(profile, sessionId),
    ...makeStageState(),
  };
  const plan = planDind(input);

  expect(plan).not.toBeNull();
  const p = plan as DindPlan;
  expect(p.containerName).toEqual("nas-dind-abcdef12");
  expect(p.networkName).toEqual("nas-dind-abcdef12");
  expect(p.sharedTmpVolume).toEqual("nas-dind-tmp-abcdef12");
  expect(p.shared).toEqual(false);

  expect(p.outputOverrides.container?.network).toEqual({
    name: "nas-dind-abcdef12",
  });
  expect(p.outputOverrides.container?.env.static.DOCKER_HOST).toEqual(
    "tcp://nas-dind-abcdef12:2375",
  );
});

test("DindStage: default options", () => {
  const profile = makeProfile({ docker: { enable: true, shared: false } });
  const input = { ...makeSharedInput(profile), ...makeStageState() };
  const plan = planDind(input);

  expect(plan).not.toBeNull();
  const p = plan as DindPlan;
  expect(p.disableCache).toEqual(false);
  expect(p.readinessTimeoutMs).toEqual(30_000);
});

test("DindStage: planner merges into existing container slice and replaces stale network attachment", () => {
  const profile = makeProfile({ docker: { enable: true, shared: false } });
  const input = {
    ...makeSharedInput(profile, "abcdef12-3456-7890-abcd-ef1234567890"),
    ...makeStageState({
      workspace: {
        workDir: "/slice-workdir",
        imageName: "slice-image",
      },
      container: {
        ...emptyContainerPlan("slice-image", "/slice-workdir"),
        env: { static: { EXISTING_ENV: "1" }, dynamicOps: [] },
        extraRunArgs: ["--shm-size", "2g"],
        network: { name: "stale-net" },
        command: { agentCommand: ["copilot"], extraArgs: ["--safe"] },
        labels: { "nas.managed": "true" },
      },
    }),
  };

  const plan = planDind(input);
  expect(plan).not.toBeNull();

  expect(plan!.outputOverrides.container).toEqual({
    image: "slice-image",
    workDir: "/slice-workdir",
    mounts: [],
    env: {
      static: {
        EXISTING_ENV: "1",
        DOCKER_HOST: "tcp://nas-dind-abcdef12:2375",
        NAS_DIND_CONTAINER_NAME: "nas-dind-abcdef12",
        NAS_DIND_SHARED_TMP: "/tmp/nas-shared",
      },
      dynamicOps: [],
    },
    extraRunArgs: [
      "--shm-size",
      "2g",
      "-v",
      "nas-dind-tmp-abcdef12:/tmp/nas-shared",
    ],
    network: { name: "nas-dind-abcdef12" },
    command: { agentCommand: ["copilot"], extraArgs: ["--safe"] },
    labels: { "nas.managed": "true" },
  });
});

// ============================================================
// EffectStage run() tests
// ============================================================

test("DindStage: run returns empty when disabled", async () => {
  const profile = makeProfile({ docker: { enable: false, shared: false } });
  const sharedInput = makeSharedInput(profile);
  const stageState = makeStageState();
  const stage = createDindStage(sharedInput);
  const fakeLayer = makeDindServiceFake();

  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run(stageState)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(fakeLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(result).toEqual({});
});

test("DindStage: run calls ensureSidecar and teardownSidecar via DindService", async () => {
  const ensureCalls: DindSidecarOpts[] = [];
  const teardownCalls: Array<{
    containerName: string;
    networkName: string;
    sharedTmpVolume: string;
    shared: boolean;
  }> = [];

  const fakeLayer = makeDindServiceFake({
    ensureSidecar: (opts) => {
      ensureCalls.push(opts);
      return Effect.void;
    },
    teardownSidecar: (opts) => {
      teardownCalls.push(opts);
      return Effect.void;
    },
  });

  const profile = makeProfile({ docker: { enable: true, shared: true } });
  const sharedInput = makeSharedInput(profile);
  const stageState = makeStageState();
  const stage = createDindStageWithOptions(sharedInput, {
    disableCache: true,
    readinessTimeoutMs: 5000,
  });

  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run(stageState)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(fakeLayer),
      ),
  );

  expect(ensureCalls.length).toEqual(1);
  expect(ensureCalls[0].containerName).toEqual("nas-dind-shared");
  expect(ensureCalls[0].networkName).toEqual("nas-dind-shared");
  expect(ensureCalls[0].sharedTmpVolume).toEqual("nas-dind-shared-tmp");
  expect(ensureCalls[0].shared).toEqual(true);
  expect(ensureCalls[0].disableCache).toEqual(true);
  expect(ensureCalls[0].readinessTimeoutMs).toEqual(5000);

  expect(result.dind).toEqual({ containerName: "nas-dind-shared" });
  expect(result.container?.network).toEqual({ name: "nas-dind-shared" });
  expect(result.container?.env.static.DOCKER_HOST).toEqual(
    "tcp://nas-dind-shared:2375",
  );
  expect(result.container?.extraRunArgs).toEqual([
    "-v",
    "nas-dind-shared-tmp:/tmp/nas-shared",
  ]);

  expect(teardownCalls.length).toEqual(0);

  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(teardownCalls.length).toEqual(1);
  expect(teardownCalls[0].containerName).toEqual("nas-dind-shared");
  expect(teardownCalls[0].networkName).toEqual("nas-dind-shared");
  expect(teardownCalls[0].sharedTmpVolume).toEqual("nas-dind-shared-tmp");
  expect(teardownCalls[0].shared).toEqual(true);
});

// ============================================================
// buildDindSidecarArgs tests
// ============================================================

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
