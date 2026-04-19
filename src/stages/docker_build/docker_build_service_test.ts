/**
 * DockerBuildService unit tests.
 *
 * Drives DockerBuildServiceLive with FsServiceFake + DockerServiceFake to
 * verify asset copying, invocation order, and finalizer-based tmp cleanup.
 */

import { expect, test } from "bun:test";
import { Effect, Exit, Layer, Scope } from "effect";
import { type DockerService, makeDockerServiceFake } from "../../services/docker.ts";
import {
  type DockerBuildImagePlan,
  DockerBuildService,
  DockerBuildServiceLive,
} from "./docker_build_service.ts";
import { type FsService, makeFsServiceFake } from "../../services/fs.ts";

interface BuildCall {
  contextDir: string;
  imageName: string;
  labels: Record<string, string>;
}

function dockerFake(calls: BuildCall[]): Layer.Layer<DockerService> {
  return makeDockerServiceFake({
    build: (contextDir, imageName, labels) => {
      calls.push({ contextDir, imageName, labels });
      return Effect.void;
    },
  });
}

async function runBuild(
  plan: DockerBuildImagePlan,
  fsLayer: Layer.Layer<FsService>,
  dockerLayer: Layer.Layer<DockerService>,
): Promise<Exit.Exit<void, unknown>> {
  const live = DockerBuildServiceLive.pipe(
    Layer.provide(Layer.mergeAll(fsLayer, dockerLayer)),
  );
  const scope = Effect.runSync(Scope.make());
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(DockerBuildService, (svc) => svc.buildImage(plan)).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provide(live),
    ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));
  return exit;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("buildImage: copies assets into a tmp dir and invokes docker build", async () => {
  const fsFake = makeFsServiceFake();
  // Pre-seed the source assets.
  fsFake.store.set("/src/dockerfile/Dockerfile", {
    content: "FROM busybox",
    mode: 0o644,
  });
  fsFake.store.set("/src/dockerfile/entrypoint.sh", {
    content: '#!/bin/sh\nexec "$@"',
    mode: 0o755,
  });
  fsFake.store.set("/src/config/envoy.yaml", {
    content: "static_resources: {}",
    mode: 0o644,
  });

  const buildCalls: BuildCall[] = [];
  const plan: DockerBuildImagePlan = {
    assetGroups: [
      {
        baseDir: "/src/dockerfile",
        outputDir: ".",
        files: ["Dockerfile", "entrypoint.sh"],
      },
      {
        baseDir: "/src/config",
        outputDir: "envoy",
        files: ["envoy.yaml"],
      },
    ],
    imageName: "nas:test",
    labels: { "nas.managed": "true" },
  };

  const exit = await runBuild(plan, fsFake.layer, dockerFake(buildCalls));
  expect(Exit.isSuccess(exit)).toEqual(true);

  expect(buildCalls.length).toEqual(1);
  expect(buildCalls[0].imageName).toEqual("nas:test");
  expect(buildCalls[0].labels).toEqual({ "nas.managed": "true" });
  // tmp dir path came from fs.mkdtemp fake ("prefix" + counter).
  expect(buildCalls[0].contextDir.startsWith("/")).toEqual(true);
});

test("buildImage: removes the tmp dir on scope close", async () => {
  const fsFake = makeFsServiceFake();
  fsFake.store.set("/src/Dockerfile", {
    content: "FROM busybox",
    mode: 0o644,
  });

  const plan: DockerBuildImagePlan = {
    assetGroups: [{ baseDir: "/src", outputDir: ".", files: ["Dockerfile"] }],
    imageName: "nas:cleanup",
    labels: {},
  };

  const exit = await runBuild(plan, fsFake.layer, dockerFake([]));
  expect(Exit.isSuccess(exit)).toEqual(true);

  // After the scope closed, the tmp dir and any copied files should be gone.
  const remaining = [...fsFake.store.keys()].filter((k) =>
    k.includes("nas-docker-build-"),
  );
  expect(remaining).toEqual([]);
});

test("buildImage: propagates readFile errors for missing source assets", async () => {
  const fsFake = makeFsServiceFake();
  // Source asset is missing from the store.
  const plan: DockerBuildImagePlan = {
    assetGroups: [{ baseDir: "/src", outputDir: ".", files: ["ghost"] }],
    imageName: "nas:missing",
    labels: {},
  };

  const exit = await runBuild(plan, fsFake.layer, dockerFake([]));
  expect(Exit.isFailure(exit)).toEqual(true);
});

test("buildImage: tmp dir is removed even when docker.build fails", async () => {
  const fsFake = makeFsServiceFake();
  fsFake.store.set("/src/Dockerfile", {
    content: "FROM busybox",
    mode: 0o644,
  });

  const dockerLayer = makeDockerServiceFake({
    build: () =>
      Effect.fail(
        new Error("docker exploded"),
      ) as unknown as Effect.Effect<void>,
  });

  const plan: DockerBuildImagePlan = {
    assetGroups: [{ baseDir: "/src", outputDir: ".", files: ["Dockerfile"] }],
    imageName: "nas:boom",
    labels: {},
  };

  const exit = await runBuild(plan, fsFake.layer, dockerLayer);
  // build failed, but scope close must still run → tmp dir gets cleaned up
  expect(Exit.isFailure(exit)).toEqual(true);
  const remaining = [...fsFake.store.keys()].filter((k) =>
    k.includes("nas-docker-build-"),
  );
  expect(remaining).toEqual([]);
});

test("buildImage: writes each file under the group outputDir", async () => {
  const fsFake = makeFsServiceFake();
  fsFake.store.set("/src/sub/Dockerfile", {
    content: "FROM scratch",
    mode: 0o644,
  });

  const plan: DockerBuildImagePlan = {
    assetGroups: [
      {
        baseDir: "/src/sub",
        outputDir: "build-context/deep",
        files: ["Dockerfile"],
      },
    ],
    imageName: "nas:nested",
    labels: {},
  };

  // Don't close the scope yet — inspect intermediate state.
  const live = DockerBuildServiceLive.pipe(
    Layer.provide(Layer.mergeAll(fsFake.layer, dockerFake([]))),
  );
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(
    Effect.flatMap(DockerBuildService, (svc) => svc.buildImage(plan)).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provide(live),
    ),
  );

  const written = [...fsFake.store.keys()].filter((k) =>
    k.endsWith("build-context/deep/Dockerfile"),
  );
  expect(written.length).toEqual(1);
  const entry = fsFake.store.get(written[0]);
  expect(entry?.content).toEqual("FROM scratch");

  await Effect.runPromise(Scope.close(scope, Exit.void));
});
