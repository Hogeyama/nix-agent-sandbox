/**
 * DinD sidecar effect.
 */

import type { DindSidecarEffect } from "../types.ts";
import type { ResourceHandle } from "./types.ts";
import { ensureDindSidecar, teardownDindSidecar } from "../../docker/dind.ts";

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
