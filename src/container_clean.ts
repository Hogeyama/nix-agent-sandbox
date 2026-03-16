import {
  type DockerContainerDetails,
  dockerInspectContainer,
  dockerInspectNetwork,
  dockerInspectVolume,
  dockerListContainerNames,
  dockerListNetworkNames,
  dockerListVolumeNames,
  type DockerNetworkDetails,
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

export async function cleanNasContainers(): Promise<ContainerCleanResult> {
  const containers = await loadContainers();
  const networks = await loadNetworks();
  const containerMap = new Map(
    containers.map((container) => [container.name, container]),
  );
  const networkMap = new Map(
    networks.map((network) => [network.name, network]),
  );

  const managedSidecars = containers.filter((container) =>
    isNasManagedSidecar(container.labels, container.name)
  );

  const removedContainers: string[] = [];
  for (const container of managedSidecars) {
    if (!isUnusedNasSidecar(container, containerMap, networkMap)) {
      continue;
    }
    if (container.running) {
      await dockerStop(container.name, { timeoutSeconds: 0 });
    }
    await dockerRm(container.name);
    removedContainers.push(container.name);
  }

  const removedNetworks = await removeUnusedNetworks();
  const removedVolumes = await removeUnusedVolumes();

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

async function loadContainers(): Promise<DockerContainerDetails[]> {
  const names = await dockerListContainerNames();
  return await Promise.all(names.map((name) => dockerInspectContainer(name)));
}

async function loadNetworks(): Promise<DockerNetworkDetails[]> {
  const names = await dockerListNetworkNames();
  const networks = await Promise.all(
    names.map((name) => dockerInspectNetwork(name)),
  );
  return networks.filter((network) =>
    isNasManagedNetwork(network.labels, network.name)
  );
}

async function removeUnusedNetworks(): Promise<string[]> {
  const names = await dockerListNetworkNames();
  const removed: string[] = [];

  for (const name of names) {
    const network = await dockerInspectNetwork(name);
    if (!isNasManagedNetwork(network.labels, network.name)) continue;
    if (network.containers.length > 0) continue;
    await dockerNetworkRemove(name);
    removed.push(name);
  }

  return removed;
}

async function removeUnusedVolumes(): Promise<string[]> {
  const names = await dockerListVolumeNames();
  const removed: string[] = [];

  for (const name of names) {
    const volume = await dockerInspectVolume(name);
    if (!isNasManagedTmpVolume(volume.labels, volume.name)) continue;
    if (volume.containers.length > 0) continue;
    await dockerVolumeRemove(name);
    removed.push(name);
  }

  return removed;
}
