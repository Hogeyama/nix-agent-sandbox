/**
 * DinD sidecar effect.
 */

import { ensureDindSidecar, teardownDindSidecar } from "../../docker/dind.ts";
import type { DindSidecarEffect, ResourceHandle } from "./types.ts";

export async function executeDindSidecar(
  effect: DindSidecarEffect,
): Promise<ResourceHandle> {
  const {
    containerName,
    sharedTmpVolume,
    networkName,
    shared,
    disableCache,
    readinessTimeoutMs,
  } = effect;

  await ensureDindSidecar({
    containerName,
    sharedTmpVolume,
    networkName,
    shared,
    disableCache,
    readinessTimeoutMs,
  });

  return {
    kind: "dind-sidecar",
    close: () =>
      teardownDindSidecar({
        containerName,
        networkName,
        sharedTmpVolume,
        shared,
      }),
  };
}
