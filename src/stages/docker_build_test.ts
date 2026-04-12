import { expect, test } from "bun:test";
import * as path from "node:path";
import { Effect, Exit, Scope } from "effect";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
  type Profile,
} from "../config/types.ts";
import type {
  HostEnv,
  PriorStageOutputs,
  StageInput,
} from "../pipeline/types.ts";
import { makeDockerServiceFake } from "../services/docker.ts";
import { makeFsServiceFake } from "../services/fs.ts";
import {
  type BuildProbes,
  createDockerBuildStage,
  EMBED_HASH_LABEL,
  EMBEDDED_BUILD_ASSET_GROUPS,
  planDockerBuild,
} from "./docker_build.ts";

test("planDockerBuild: returns needsBuild=true with labels when image does not exist", () => {
  const buildProbes: BuildProbes = {
    imageExists: false,
    currentEmbedHash: "abc123",
    imageEmbedHash: null,
  };
  const input = createTestInput();

  const plan = planDockerBuild(input, buildProbes);
  expect(plan.needsBuild).toEqual(true);
  expect(plan.imageName).toEqual("nas-sandbox");
  expect(plan.labels[EMBED_HASH_LABEL]).toEqual("abc123");
  expect(plan.assetGroups.length).toBeGreaterThan(0);
});

test("planDockerBuild: returns needsBuild=false when image exists and hash matches", () => {
  const buildProbes: BuildProbes = {
    imageExists: true,
    currentEmbedHash: "abc123",
    imageEmbedHash: "abc123",
  };
  const input = createTestInput();

  const plan = planDockerBuild(input, buildProbes);
  expect(plan.needsBuild).toEqual(false);
});

test("planDockerBuild: warns when cached image embed hash is outdated", () => {
  const buildProbes: BuildProbes = {
    imageExists: true,
    currentEmbedHash: "new-hash",
    imageEmbedHash: "stale-hash",
  };
  const input = createTestInput();

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const plan = planDockerBuild(input, buildProbes);
    expect(plan.needsBuild).toEqual(false);
    expect(
      logs.some((line) => line.includes("Docker image is outdated")),
    ).toEqual(true);
  } finally {
    console.log = originalLog;
  }
});

test("DockerBuildStage.run: skips build when image exists", async () => {
  const buildProbes: BuildProbes = {
    imageExists: true,
    currentEmbedHash: "abc123",
    imageEmbedHash: "abc123",
  };
  const stage = createDockerBuildStage(buildProbes);
  const input = createTestInput();
  const { layer: fsLayer } = makeFsServiceFake();

  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run(input)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(makeDockerServiceFake()),
        Effect.provide(fsLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(result).toEqual({});
});

test("DockerBuildStage.run: calls DockerService.build when image does not exist", async () => {
  const buildCalls: Array<{
    contextDir: string;
    imageName: string;
    labels: Record<string, string>;
  }> = [];

  const buildProbes: BuildProbes = {
    imageExists: false,
    currentEmbedHash: "abc123",
    imageEmbedHash: null,
  };
  const stage = createDockerBuildStage(buildProbes);
  const input = createTestInput();

  const fakeDocker = makeDockerServiceFake({
    build: (contextDir, imageName, labels) => {
      buildCalls.push({ contextDir, imageName, labels });
      return Effect.void;
    },
  });

  const { layer: fsLayer, store } = makeFsServiceFake();
  for (const group of EMBEDDED_BUILD_ASSET_GROUPS) {
    for (const name of group.files) {
      store.set(path.join(group.baseDir, name), {
        content: `fake-${name}`,
        mode: 0o644,
      });
    }
  }

  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run(input)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(fakeDocker),
        Effect.provide(fsLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(result).toEqual({});
  expect(buildCalls.length).toEqual(1);
  expect(buildCalls[0].imageName).toEqual("nas-sandbox");
  expect(buildCalls[0].labels[EMBED_HASH_LABEL]).toEqual("abc123");
});

function createTestInput(
  priorOverrides: Partial<PriorStageOutputs> = {},
): StageInput {
  const profile: Profile = {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    extraMounts: [],
    env: [],
  };
  const config: Config = {
    default: "test",
    profiles: { test: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  const host: HostEnv = {
    home: "/home/test",
    user: "test",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map(),
  };
  const prior: PriorStageOutputs = {
    dockerArgs: [],
    envVars: {},
    workDir: "/workspace",
    nixEnabled: false,
    imageName: "nas-sandbox",
    agentCommand: [],
    networkPromptEnabled: false,
    dbusProxyEnabled: false,
    ...priorOverrides,
  };
  return {
    config,
    profile,
    profileName: "test",
    sessionId: "sess_test123",
    host,
    probes: {
      hasHostNix: false,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: "/tmp/audit",
    },
    prior,
  };
}
