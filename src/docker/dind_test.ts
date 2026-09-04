import { expect, test } from "bun:test";

/**
 * teardownDindSidecar unit tests (Docker 不要).
 *
 * Covers the joiner-liveness skip branch, which no integration test can
 * reach: integration runs never have a real agent container sharing the
 * sidecar's network namespace. See dind_stage_integration_test.ts for the
 * Docker-backed teardown paths.
 */

import { type TeardownDindSidecarParams, teardownDindSidecar } from "./dind.ts";

function teardownParams(): TeardownDindSidecarParams {
  return {
    containerName: "nas-dind-abc12345",
    sharedTmpVolume: "nas-dind-tmp-abc12345",
    joinerContainerName: "nas-agent-sess_abc12345",
  };
}

test("teardownDindSidecar: removes nothing while the joiner is running", async () => {
  const calls: string[] = [];
  const deps = {
    isRunning: async () => true,
    stop: async (name: string) => {
      calls.push(`stop:${name}`);
    },
    rm: async (name: string) => {
      calls.push(`rm:${name}`);
    },
    volumeRemove: async (name: string) => {
      calls.push(`volume:${name}`);
    },
  };

  await teardownDindSidecar(teardownParams(), deps);

  expect(calls).toEqual([]);
});

test("teardownDindSidecar: removes the sidecar once the joiner is gone", async () => {
  const calls: string[] = [];
  const deps = {
    isRunning: async () => false,
    stop: async (name: string) => {
      calls.push(`stop:${name}`);
    },
    rm: async (name: string) => {
      calls.push(`rm:${name}`);
    },
    volumeRemove: async (name: string) => {
      calls.push(`volume:${name}`);
    },
  };

  await teardownDindSidecar(teardownParams(), deps);

  expect(calls).toContain("stop:nas-dind-abc12345");
  expect(calls).toContain("rm:nas-dind-abc12345");
});
