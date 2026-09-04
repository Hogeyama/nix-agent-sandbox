import type {
  DockerContainerDetails,
  DockerNetworkDetails,
} from "./docker/client.ts";
import {
  isNasManagedEphemeralVolume,
  isNasManagedNetwork,
  isNasManagedSidecar,
} from "./docker/nas_resources.ts";
import { formatElapsed, logDebug } from "./log.ts";

export interface ContainerCleanResult {
  removedContainers: string[];
  removedNetworks: string[];
  removedVolumes: string[];
}

export interface ContainerCleanBackend {
  listContainerNames(): Promise<string[]>;
  inspectContainer(name: string): Promise<DockerContainerDetails>;
  listNetworkNames(): Promise<string[]>;
  inspectNetwork(name: string): Promise<DockerNetworkDetails>;
  listVolumeNames(): Promise<string[]>;
  inspectVolume(name: string): Promise<{
    name: string;
    labels: Record<string, string>;
    containers: string[];
  }>;
  stopContainer(name: string): Promise<void>;
  removeContainer(name: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
}

export async function cleanNasContainers(
  backend: ContainerCleanBackend,
): Promise<ContainerCleanResult> {
  const totalStart = performance.now();

  let start = performance.now();
  const containers = await loadContainers(backend);
  logDebug(`[nas]   ↳ loadContainers done (${formatElapsed(start)})`);

  start = performance.now();
  const networks = await loadNetworks(backend);
  logDebug(`[nas]   ↳ loadNetworks done (${formatElapsed(start)})`);

  const containerMap = new Map(
    containers.map((container) => [container.name, container]),
  );
  const networkMap = new Map(
    networks.map((network) => [network.name, network]),
  );

  const managedSidecars = containers.filter((container) =>
    isNasManagedSidecar(container.labels, container.name),
  );
  const usage = buildSidecarUsageIndex(containers);

  start = performance.now();
  const removedContainers: string[] = [];
  for (const container of managedSidecars) {
    if (!isUnusedNasSidecar(container, containerMap, networkMap, usage)) {
      continue;
    }
    if (container.running) {
      await backend.stopContainer(container.name);
    }
    await backend.removeContainer(container.name);
    removedContainers.push(container.name);
  }
  logDebug(`[nas]   ↳ removeSidecars done (${formatElapsed(start)})`);

  start = performance.now();
  const removedNetworks = await removeUnusedNetworks(backend);
  logDebug(`[nas]   ↳ removeUnusedNetworks done (${formatElapsed(start)})`);

  start = performance.now();
  const removedVolumes = await removeUnusedVolumes(backend);
  logDebug(`[nas]   ↳ removeUnusedVolumes done (${formatElapsed(start)})`);

  logDebug(`[nas] cleanNasContainers done (${formatElapsed(totalStart)})`);

  return {
    removedContainers,
    removedNetworks,
    removedVolumes,
  };
}

const CONTAINER_NETWORK_MODE_PREFIX = "container:";

/**
 * Indexes of namespace joiners, built once per `cleanNasContainers` run and
 * shared across every sidecar it evaluates (see `buildSidecarUsageIndex`).
 */
export interface SidecarUsageIndex {
  /** Running, non-sidecar containers keyed by the owner id in their `container:<id>` networkMode. */
  readonly joinersByOwnerId: ReadonlyMap<string, DockerContainerDetails[]>;
  /** Joiners credited to each network their owner belongs to (see `buildSidecarUsageIndex`). */
  readonly virtualMembers: ReadonlyMap<string, DockerContainerDetails[]>;
}

/**
 * Resolves namespace joiners (`--network container:<id>`) against the
 * container list once, rather than once per sidecar `isUnusedNasSidecar`
 * evaluates. Two views come out of the same pass:
 *
 * - `joinersByOwnerId`: who sits directly inside a given container's
 *   namespace, keyed by that container's own id. This is what protects the
 *   namespace owner itself, independent of which networks it happens to be
 *   on.
 * - `virtualMembers`: a joiner is a member of no network (`container:<id>`
 *   mode has no network of its own), so plain membership checks would miss
 *   it entirely -- including for containers, like a shared proxy, that sit
 *   on the same network as the joiner's owner without being the owner. Credit
 *   the joiner to every network its owner belongs to so those checks see it.
 */
export function buildSidecarUsageIndex(
  containers: Iterable<DockerContainerDetails>,
): SidecarUsageIndex {
  // Materialize once: a caller may pass a single-use iterator (e.g.
  // `Map.values()`), and this function walks the collection twice.
  const all = [...containers];

  const byId = new Map<string, DockerContainerDetails>();
  for (const candidate of all) {
    if (candidate.id) byId.set(candidate.id, candidate);
  }

  const joinersByOwnerId = new Map<string, DockerContainerDetails[]>();
  const virtualMembers = new Map<string, DockerContainerDetails[]>();
  for (const candidate of all) {
    if (!candidate.running) continue;
    if (isNasManagedSidecar(candidate.labels, candidate.name)) continue;
    if (!candidate.networkMode.startsWith(CONTAINER_NETWORK_MODE_PREFIX)) {
      continue;
    }
    const ownerId = candidate.networkMode.slice(
      CONTAINER_NETWORK_MODE_PREFIX.length,
    );

    const joiners = joinersByOwnerId.get(ownerId);
    if (joiners) joiners.push(candidate);
    else joinersByOwnerId.set(ownerId, [candidate]);

    const owner = byId.get(ownerId);
    if (!owner) continue;
    for (const networkName of owner.networks) {
      const existing = virtualMembers.get(networkName);
      if (existing) existing.push(candidate);
      else virtualMembers.set(networkName, [candidate]);
    }
  }

  return { joinersByOwnerId, virtualMembers };
}

export function isUnusedNasSidecar(
  container: DockerContainerDetails,
  containers: ReadonlyMap<string, DockerContainerDetails>,
  networks: ReadonlyMap<string, DockerNetworkDetails>,
  usage: SidecarUsageIndex,
): boolean {
  if (!container.running) {
    return true;
  }

  // A running joiner sits directly inside this sidecar's namespace without
  // ever becoming a member of any of its networks, so the membership loop
  // below can't see it -- most plainly when the sidecar isn't on a
  // nas-managed network at all yet (relevantNetworks empty). Check direct
  // ownership before falling back to the network-membership checks, which
  // exist to protect a sidecar's network *peers* (e.g. a shared proxy that
  // sits on the same network as the joiner's owner without being the owner).
  if (
    container.id &&
    (usage.joinersByOwnerId.get(container.id)?.length ?? 0) > 0
  ) {
    return false;
  }

  const relevantNetworks = container.networks.filter((networkName) => {
    const network = networks.get(networkName);
    return isNasManagedNetwork(network?.labels ?? {}, networkName);
  });

  for (const networkName of relevantNetworks) {
    if ((usage.virtualMembers.get(networkName)?.length ?? 0) > 0) {
      return false;
    }
    const network = networks.get(networkName);
    if (!network) continue;
    for (const memberName of network.containers) {
      if (memberName === container.name) continue;
      const member = containers.get(memberName);
      if (!member) continue;
      if (member.running && !isNasManagedSidecar(member.labels, member.name)) {
        return false;
      }
    }
  }

  return true;
}

async function loadContainers(
  backend: ContainerCleanBackend,
): Promise<DockerContainerDetails[]> {
  const names = await backend.listContainerNames();
  return await Promise.all(names.map((name) => backend.inspectContainer(name)));
}

async function loadNetworks(
  backend: ContainerCleanBackend,
): Promise<DockerNetworkDetails[]> {
  const names = await backend.listNetworkNames();
  const networks = await Promise.all(
    names.map((name) => backend.inspectNetwork(name)),
  );
  return networks.filter((network) =>
    isNasManagedNetwork(network.labels, network.name),
  );
}

async function removeUnusedNetworks(
  backend: ContainerCleanBackend,
): Promise<string[]> {
  const names = await backend.listNetworkNames();
  const removed: string[] = [];

  for (const name of names) {
    const network = await backend.inspectNetwork(name);
    if (!isNasManagedNetwork(network.labels, network.name)) continue;
    if (network.containers.length > 0) continue;
    await backend.removeNetwork(name);
    removed.push(name);
  }

  return removed;
}

async function removeUnusedVolumes(
  backend: ContainerCleanBackend,
): Promise<string[]> {
  const names = await backend.listVolumeNames();
  const removed: string[] = [];

  for (const name of names) {
    const volume = await backend.inspectVolume(name);
    if (!isNasManagedEphemeralVolume(volume.labels, volume.name)) continue;
    if (volume.containers.length > 0) continue;
    await backend.removeVolume(name);
    removed.push(name);
  }

  return removed;
}
