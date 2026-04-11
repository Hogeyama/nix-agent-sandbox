import { expect, test } from "bun:test";
import type {
  DockerContainerDetails,
  DockerNetworkDetails,
  DockerVolumeDetails,
} from "./docker/client.ts";
import {
  cleanNasContainers,
  type ContainerCleanBackend,
  isUnusedNasSidecar,
} from "./container_clean.ts";
import {
  isNasManagedNetwork,
  isNasManagedSidecar,
  NAS_KIND_DIND,
  NAS_KIND_DIND_NETWORK,
  NAS_KIND_DIND_TMP,
  NAS_KIND_ENVOY,
  NAS_KIND_LABEL,
  NAS_KIND_SESSION_NETWORK,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "./docker/nas_resources.ts";

test("isNasManagedSidecar: nas-sandbox is not a managed sidecar", () => {
  expect(isNasManagedSidecar({}, "nas-sandbox")).toEqual(false);
});

test("isNasManagedSidecar: labeled sidecar is detected", () => {
  expect(
    isNasManagedSidecar(
      {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_DIND,
      },
      "custom-name",
    ),
  ).toEqual(true);
});

test("isNasManagedSidecar: labeled envoy sidecar is detected", () => {
  expect(
    isNasManagedSidecar(
      {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_ENVOY,
      },
      "custom-envoy",
    ),
  ).toEqual(true);
});

test("isNasManagedSidecar: legacy shared envoy name is detected", () => {
  expect(isNasManagedSidecar({}, "nas-envoy-shared")).toEqual(true);
});

test("isNasManagedNetwork: labeled session network is detected", () => {
  expect(
    isNasManagedNetwork(
      {
        [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
        [NAS_KIND_LABEL]: NAS_KIND_SESSION_NETWORK,
      },
      "custom-session-network",
    ),
  ).toEqual(true);
});

test("isNasManagedNetwork: legacy session network name is detected", () => {
  expect(isNasManagedNetwork({}, "nas-session-example")).toEqual(true);
});

test("isUnusedNasSidecar: active non-managed container keeps sidecar alive", () => {
  const sidecar: DockerContainerDetails = {
    name: "nas-proxy-test",
    running: true,
    labels: {},
    networks: ["nas-proxy-test"],
    startedAt: "2026-01-01T00:00:00Z",
  };
  const userContainer: DockerContainerDetails = {
    name: "nas-sandbox",
    running: true,
    labels: {},
    networks: ["nas-proxy-test"],
    startedAt: "2026-01-01T00:00:00Z",
  };
  const network: DockerNetworkDetails = {
    name: "nas-proxy-test",
    labels: {},
    containers: ["nas-proxy-test", "nas-sandbox"],
  };

  expect(
    isUnusedNasSidecar(
      sidecar,
      new Map([
        [sidecar.name, sidecar],
        [userContainer.name, userContainer],
      ]),
      new Map([[network.name, network]]),
    ),
  ).toEqual(false);
});

test("isUnusedNasSidecar: only managed sidecars on network is unused", () => {
  const proxy: DockerContainerDetails = {
    name: "nas-proxy-test",
    running: true,
    labels: {},
    networks: ["nas-proxy-test"],
    startedAt: "2026-01-01T00:00:00Z",
  };
  const dind: DockerContainerDetails = {
    name: "nas-dind-shared",
    running: true,
    labels: {},
    networks: ["nas-proxy-test"],
    startedAt: "2026-01-01T00:00:00Z",
  };
  const network: DockerNetworkDetails = {
    name: "nas-proxy-test",
    labels: {},
    containers: ["nas-proxy-test", "nas-dind-shared"],
  };

  expect(
    isUnusedNasSidecar(
      proxy,
      new Map([
        [proxy.name, proxy],
        [dind.name, dind],
      ]),
      new Map([[network.name, network]]),
    ),
  ).toEqual(true);
});

test("isUnusedNasSidecar: session network with active container keeps envoy alive", () => {
  const envoy: DockerContainerDetails = {
    name: "nas-envoy-shared",
    running: true,
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_ENVOY,
    },
    networks: ["nas-session-example"],
    startedAt: "2026-01-01T00:00:00Z",
  };
  const userContainer: DockerContainerDetails = {
    name: "nas-sandbox",
    running: true,
    labels: {},
    networks: ["nas-session-example"],
    startedAt: "2026-01-01T00:00:00Z",
  };
  const sessionNetwork: DockerNetworkDetails = {
    name: "nas-session-example",
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_SESSION_NETWORK,
    },
    containers: ["nas-envoy-shared", "nas-sandbox"],
  };

  expect(
    isUnusedNasSidecar(
      envoy,
      new Map([
        [envoy.name, envoy],
        [userContainer.name, userContainer],
      ]),
      new Map([[sessionNetwork.name, sessionNetwork]]),
    ),
  ).toEqual(false);
});

class FakeBackend implements ContainerCleanBackend {
  containers = new Map<string, DockerContainerDetails>();
  networks = new Map<string, DockerNetworkDetails>();
  volumes = new Map<string, DockerVolumeDetails>();
  stopped: string[] = [];
  removedContainers: string[] = [];
  removedNetworks: string[] = [];
  removedVolumes: string[] = [];

  listContainerNames(): Promise<string[]> {
    return Promise.resolve([...this.containers.keys()]);
  }

  inspectContainer(name: string): Promise<DockerContainerDetails> {
    return Promise.resolve(
      structuredClone(this.mustGet(this.containers, name)),
    );
  }

  listNetworkNames(): Promise<string[]> {
    return Promise.resolve([...this.networks.keys()]);
  }

  inspectNetwork(name: string): Promise<DockerNetworkDetails> {
    return Promise.resolve(structuredClone(this.mustGet(this.networks, name)));
  }

  listVolumeNames(): Promise<string[]> {
    return Promise.resolve([...this.volumes.keys()]);
  }

  inspectVolume(name: string): Promise<DockerVolumeDetails> {
    return Promise.resolve(structuredClone(this.mustGet(this.volumes, name)));
  }

  stopContainer(name: string): Promise<void> {
    this.stopped.push(name);
    const container = this.mustGet(this.containers, name);
    container.running = false;
    return Promise.resolve();
  }

  removeContainer(name: string): Promise<void> {
    this.removedContainers.push(name);
    this.containers.delete(name);
    for (const network of this.networks.values()) {
      network.containers = network.containers.filter((entry) => entry !== name);
    }
    for (const volume of this.volumes.values()) {
      volume.containers = volume.containers.filter((entry) => entry !== name);
    }
    return Promise.resolve();
  }

  removeNetwork(name: string): Promise<void> {
    this.removedNetworks.push(name);
    this.networks.delete(name);
    return Promise.resolve();
  }

  removeVolume(name: string): Promise<void> {
    this.removedVolumes.push(name);
    this.volumes.delete(name);
    return Promise.resolve();
  }

  private mustGet<T>(map: Map<string, T>, name: string): T {
    const value = map.get(name);
    if (!value) {
      throw new Error(`missing fake docker object: ${name}`);
    }
    return value;
  }
}

function createManagedContainer(
  name: string,
  kind: string,
  options: { running?: boolean; networks?: string[] } = {},
): DockerContainerDetails {
  return {
    name,
    running: options.running ?? true,
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: kind,
    },
    networks: [...(options.networks ?? [])],
    startedAt: "2026-01-01T00:00:00Z",
  };
}

function createManagedNetwork(
  name: string,
  kind: string,
  containers: string[],
): DockerNetworkDetails {
  return {
    name,
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: kind,
    },
    containers: [...containers],
  };
}

test("cleanNasContainers: removes unused shared dind container, network, and tmp volume", async () => {
  const backend = new FakeBackend();
  backend.containers.set(
    "nas-dind-shared",
    createManagedContainer("nas-dind-shared", NAS_KIND_DIND, {
      networks: ["nas-dind-shared"],
    }),
  );
  backend.networks.set(
    "nas-dind-shared",
    createManagedNetwork("nas-dind-shared", NAS_KIND_DIND_NETWORK, [
      "nas-dind-shared",
    ]),
  );
  backend.volumes.set("nas-dind-shared-tmp", {
    name: "nas-dind-shared-tmp",
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_DIND_TMP,
    },
    containers: ["nas-dind-shared"],
  });

  const result = await cleanNasContainers(backend);

  expect(result.removedContainers).toEqual(["nas-dind-shared"]);
  expect(result.removedNetworks).toEqual(["nas-dind-shared"]);
  expect(result.removedVolumes).toEqual(["nas-dind-shared-tmp"]);
  expect(backend.stopped).toEqual(["nas-dind-shared"]);
});

test("cleanNasContainers: keeps sidecar when an active non-managed container shares the network", async () => {
  const backend = new FakeBackend();
  backend.containers.set(
    "nas-proxy-sidecar",
    createManagedContainer("nas-proxy-sidecar", NAS_KIND_ENVOY, {
      networks: ["nas-session-example"],
    }),
  );
  backend.containers.set("nas-sandbox", {
    name: "nas-sandbox",
    running: true,
    labels: {},
    networks: ["nas-session-example"],
    startedAt: "2026-01-01T00:00:00Z",
  });
  backend.networks.set(
    "nas-session-example",
    createManagedNetwork("nas-session-example", NAS_KIND_SESSION_NETWORK, [
      "nas-proxy-sidecar",
      "nas-sandbox",
    ]),
  );

  const result = await cleanNasContainers(backend);

  expect(result.removedContainers).toEqual([]);
  expect(result.removedNetworks).toEqual([]);
  expect(result.removedVolumes).toEqual([]);
});

test("cleanNasContainers: removes stopped sidecar and orphaned managed resources", async () => {
  const backend = new FakeBackend();
  backend.containers.set(
    "nas-envoy-shared",
    createManagedContainer("nas-envoy-shared", NAS_KIND_ENVOY, {
      running: false,
      networks: ["nas-session-orphan"],
    }),
  );
  backend.networks.set(
    "nas-session-orphan",
    createManagedNetwork("nas-session-orphan", NAS_KIND_SESSION_NETWORK, [
      "nas-envoy-shared",
    ]),
  );

  const result = await cleanNasContainers(backend);

  expect(result.removedContainers).toEqual(["nas-envoy-shared"]);
  expect(result.removedNetworks).toEqual(["nas-session-orphan"]);
  expect(result.removedVolumes).toEqual([]);
  expect(backend.stopped).toEqual([]);
});
