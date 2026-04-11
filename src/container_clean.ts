import {
  type DockerContainerDetails,
  type DockerNetworkDetails,
  dockerInspectContainer,
  dockerInspectNetwork,
  dockerInspectVolume,
  dockerListContainerNames,
  dockerListNetworkNames,
  dockerListVolumeNames,
  dockerNetworkRemove,
  dockerRm,
  dockerStop,
  dockerVolumeRemove,
} from "./docker/client.ts";
import {
  isNasManagedNetwork,
  isNasManagedSidecar,
  isNasManagedTmpVolume,
} from "./docker/nas_resources.ts";

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

const defaultBackend: ContainerCleanBackend = {
  listContainerNames: dockerListContainerNames,
  inspectContainer: dockerInspectContainer,
  listNetworkNames: dockerListNetworkNames,
  inspectNetwork: dockerInspectNetwork,
  listVolumeNames: dockerListVolumeNames,
  inspectVolume: dockerInspectVolume,
  stopContainer: (name) => dockerStop(name, { timeoutSeconds: 0 }),
  removeContainer: dockerRm,
  removeNetwork: dockerNetworkRemove,
  removeVolume: dockerVolumeRemove,
};

export async function cleanNasContainers(
  backend: ContainerCleanBackend = defaultBackend,
): Promise<ContainerCleanResult> {
  const containers = await loadContainers(backend);
  const networks = await loadNetworks(backend);
  const containerMap = new Map(
    containers.map((container) => [container.name, container]),
  );
  const networkMap = new Map(
    networks.map((network) => [network.name, network]),
  );

  const managedSidecars = containers.filter((container) =>
    isNasManagedSidecar(container.labels, container.name),
  );

  const removedContainers: string[] = [];
  for (const container of managedSidecars) {
    if (!isUnusedNasSidecar(container, containerMap, networkMap)) {
      continue;
    }
    if (container.running) {
      await backend.stopContainer(container.name);
    }
    await backend.removeContainer(container.name);
    removedContainers.push(container.name);
  }

  const removedNetworks = await removeUnusedNetworks(backend);
  const removedVolumes = await removeUnusedVolumes(backend);

  return {
    removedContainers,
    removedNetworks,
    removedVolumes,
  };
}

export function isUnusedNasSidecar(
  container: DockerContainerDetails,
  containers: ReadonlyMap<string, DockerContainerDetails>,
  networks: ReadonlyMap<string, DockerNetworkDetails>,
): boolean {
  if (!container.running) {
    return true;
  }

  const relevantNetworks = container.networks.filter((networkName) => {
    const network = networks.get(networkName);
    return isNasManagedNetwork(network?.labels ?? {}, networkName);
  });

  for (const networkName of relevantNetworks) {
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
    if (!isNasManagedTmpVolume(volume.labels, volume.name)) continue;
    if (volume.containers.length > 0) continue;
    await backend.removeVolume(name);
    removed.push(name);
  }

  return removed;
}
