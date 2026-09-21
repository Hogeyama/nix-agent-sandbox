import { sharedDockerResources } from "./shared_resources.ts";
/**
 * Removal of one session's Docker resources after its nas process is gone.
 *
 * The owner may have finished none, some or all of its own teardown before it
 * ended, so every step runs independently and a missing resource is expected.
 */

import {
  dockerNetworkDisconnect,
  dockerNetworkRemove,
  dockerRm,
  dockerStop,
  dockerVolumeRemove,
} from "./client.ts";
import type { SessionDockerResources } from "./nas_resources.ts";

export interface SessionReapDeps {
  readonly stop: (containerName: string) => Promise<void>;
  readonly rm: (containerName: string) => Promise<void>;
  readonly networkDisconnect: (
    networkName: string,
    containerName: string,
  ) => Promise<void>;
  readonly networkRemove: (networkName: string) => Promise<void>;
  readonly volumeRemove: (volumeName: string) => Promise<void>;
}

export interface SessionReapStep {
  readonly action: string;
  readonly error?: string;
}

function liveSessionReapDeps(): SessionReapDeps {
  return {
    stop: (name) => dockerStop(name, { timeoutSeconds: 0 }),
    rm: dockerRm,
    networkDisconnect: dockerNetworkDisconnect,
    networkRemove: dockerNetworkRemove,
    volumeRemove: dockerVolumeRemove,
  };
}

export async function reapSessionDockerResources(
  resources: SessionDockerResources,
  deps: SessionReapDeps = liveSessionReapDeps(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SessionReapStep[]> {
  const proxyContainer = sharedDockerResources(env).proxyContainer;
  const container = (name: string): Array<[string, () => Promise<void>]> => [
    [`stop ${name}`, () => deps.stop(name)],
    [`remove ${name}`, () => deps.rm(name)],
  ];
  const steps: Array<[string, () => Promise<void>]> = [
    // The agent joins the DinD sidecar's namespace, so it goes first.
    ...container(resources.agentContainer),
    ...container(resources.dindContainer),
    ...container(resources.registryMirrorContainer),
    // The shared proxy outlives sessions; only detach it from this network.
    [
      `disconnect ${proxyContainer} from ${resources.sessionNetwork}`,
      () => deps.networkDisconnect(resources.sessionNetwork, proxyContainer),
    ],
    [
      `remove network ${resources.sessionNetwork}`,
      () => deps.networkRemove(resources.sessionNetwork),
    ],
    [
      `remove volume ${resources.dindDataVolume}`,
      () => deps.volumeRemove(resources.dindDataVolume),
    ],
    [
      `remove volume ${resources.dindTmpVolume}`,
      () => deps.volumeRemove(resources.dindTmpVolume),
    ],
  ];

  const results: SessionReapStep[] = [];
  for (const [action, run] of steps) {
    try {
      await run();
      results.push({ action });
    } catch (e) {
      results.push({
        action,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}
