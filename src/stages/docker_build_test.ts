import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Exit, Scope } from "effect";
import { computeEmbedHash } from "../docker/client.ts";
import type { WorkspaceState } from "../pipeline/state.ts";
import {
  type DockerBuildImagePlan,
  makeDockerBuildServiceFake,
} from "../services/docker_build.ts";
import {
  type BuildProbes,
  createDockerBuildStage,
  EMBED_HASH_LABEL,
  EMBEDDED_BUILD_ASSET_GROUPS,
  planDockerBuild,
} from "./docker_build.ts";

test("planDockerBuild: returns needsBuild=true with labels when image does not exist", () => {
  const buildProbes: BuildProbes = {
    imageName: "nas-sandbox",
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
    imageName: "nas-sandbox",
    imageExists: true,
    currentEmbedHash: "abc123",
    imageEmbedHash: "abc123",
  };
  const input = createTestInput();

  const plan = planDockerBuild(input, buildProbes);
  expect(plan.needsBuild).toEqual(false);
});

test("planDockerBuild: uses workspace slice image name", () => {
  const buildProbes: BuildProbes = {
    imageName: "slice-image",
    imageExists: false,
    currentEmbedHash: "abc123",
    imageEmbedHash: null,
  };
  const input = createTestInput({
    workspace: {
      workDir: "/workspace",
      imageName: "slice-image",
    },
  });

  const plan = planDockerBuild(input, buildProbes);
  expect(plan.imageName).toEqual("slice-image");
});

test("planDockerBuild: throws when workspace image differs from probe image", () => {
  const buildProbes: BuildProbes = {
    imageName: "probed-image",
    imageExists: false,
    currentEmbedHash: "abc123",
    imageEmbedHash: null,
  };
  const input = createTestInput({
    workspace: {
      workDir: "/workspace",
      imageName: "slice-image",
    },
  });

  expect(() => planDockerBuild(input, buildProbes)).toThrow(
    "DockerBuildStage probe/image mismatch",
  );
});

test("planDockerBuild: rebuilds when cached image embed hash is outdated", () => {
  return assertLegacyEmbedHashTriggersRebuild((buildProbes) => {
    const input = createTestInput();

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const plan = planDockerBuild(input, buildProbes);
      expect(plan.needsBuild).toEqual(true);
      expect(plan.labels[EMBED_HASH_LABEL]).toEqual(
        buildProbes.currentEmbedHash,
      );
      expect(plan.assetGroups.length).toBeGreaterThan(0);
      expect(
        logs.some((line) => line.includes("is outdated, rebuilding")),
      ).toEqual(true);
    } finally {
      console.log = originalLog;
    }
  });
});

test("DockerBuildStage.run: skips build when image exists", async () => {
  const buildProbes: BuildProbes = {
    imageName: "nas-sandbox",
    imageExists: true,
    currentEmbedHash: "abc123",
    imageEmbedHash: "abc123",
  };
  const stage = createDockerBuildStage(buildProbes);
  const input = createTestInput();

  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run(input)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(makeDockerBuildServiceFake()),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(result).toEqual({});
});

test("DockerBuildStage.run: calls DockerBuildService.buildImage when image does not exist", async () => {
  const buildImageCalls: DockerBuildImagePlan[] = [];

  const buildProbes: BuildProbes = {
    imageName: "nas-sandbox",
    imageExists: false,
    currentEmbedHash: "abc123",
    imageEmbedHash: null,
  };
  const stage = createDockerBuildStage(buildProbes);
  const input = createTestInput();

  const fakeDockerBuild = makeDockerBuildServiceFake({
    buildImage: (plan) => {
      buildImageCalls.push(plan);
      return Effect.void;
    },
  });

  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run(input)
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(fakeDockerBuild),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(result).toEqual({});
  expect(buildImageCalls.length).toEqual(1);
  expect(buildImageCalls[0].imageName).toEqual("nas-sandbox");
  expect(buildImageCalls[0].labels[EMBED_HASH_LABEL]).toEqual("abc123");
  expect(buildImageCalls[0].assetGroups.length).toBeGreaterThan(0);
});

test("DockerBuildStage.run: rebuilds when image exists with stale embed hash", async () => {
  await assertLegacyEmbedHashTriggersRebuild(async (buildProbes) => {
    const buildImageCalls: DockerBuildImagePlan[] = [];

    const stage = createDockerBuildStage(buildProbes);
    const input = createTestInput();

    const fakeDockerBuild = makeDockerBuildServiceFake({
      buildImage: (plan) => {
        buildImageCalls.push(plan);
        return Effect.void;
      },
    });

    const scope = Effect.runSync(Scope.make());
    const result = await Effect.runPromise(
      stage
        .run(input)
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(fakeDockerBuild),
        ),
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));

    expect(result).toEqual({});
    expect(buildImageCalls.length).toEqual(1);
    expect(buildImageCalls[0].labels[EMBED_HASH_LABEL]).toEqual(
      buildProbes.currentEmbedHash,
    );
  });
});

function createTestInput(overrides: { workspace?: WorkspaceState } = {}): {
  workspace: WorkspaceState;
} {
  const workspace: WorkspaceState = overrides.workspace ?? {
    workDir: "/workspace",
    imageName: "nas-sandbox",
  };
  return { workspace };
}

async function assertLegacyEmbedHashTriggersRebuild(
  assertFn: (buildProbes: BuildProbes) => void | Promise<void>,
): Promise<void> {
  const currentEmbedHash = await computeEmbedHash();
  const imageEmbedHash = await computeLegacyEmbedHashWithoutLocalProxy();

  expect(imageEmbedHash).not.toEqual(currentEmbedHash);

  await assertFn({
    imageName: "nas-sandbox",
    imageExists: true,
    currentEmbedHash,
    imageEmbedHash,
  });
}

async function computeLegacyEmbedHashWithoutLocalProxy(): Promise<string> {
  const parts: string[] = [];
  for (const group of EMBEDDED_BUILD_ASSET_GROUPS) {
    for (const name of group.files) {
      if (name === "local-proxy.mjs") {
        continue;
      }
      parts.push(await readFile(path.join(group.baseDir, name), "utf8"));
    }
  }
  const data = new TextEncoder().encode(parts.join("\n"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(new Uint8Array(hash)).toString("hex");
}
