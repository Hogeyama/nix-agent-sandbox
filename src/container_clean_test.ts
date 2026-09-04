import { expect, test } from "bun:test";
import {
  buildSidecarUsageIndex,
  type ContainerCleanBackend,
  cleanNasContainers,
  isUnusedNasSidecar,
} from "./container_clean.ts";
import type {
  DockerContainerDetails,
  DockerNetworkDetails,
  DockerVolumeDetails,
} from "./docker/client.ts";
import {
  isNasManagedNetwork,
  isNasManagedSidecar,
  NAS_KIND_DIND,
  NAS_KIND_DIND_DATA,
  NAS_KIND_DIND_NETWORK,
  NAS_KIND_DIND_TMP,
  NAS_KIND_LABEL,
  NAS_KIND_PROXY,
  NAS_KIND_REGISTRY_CACHE,
  NAS_KIND_REGISTRY_MIRROR,
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
    id: "id-nas-proxy-test",
    running: true,
    labels: {},
    networks: ["nas-proxy-test"],
    networkMode: "bridge",
    startedAt: "2026-01-01T00:00:00Z",
  };
  const userContainer: DockerContainerDetails = {
    name: "nas-sandbox",
    id: "id-nas-sandbox",
    running: true,
    labels: {},
    networks: ["nas-proxy-test"],
    networkMode: "bridge",
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
      buildSidecarUsageIndex([sidecar, userContainer]),
    ),
  ).toEqual(false);
});

test("isUnusedNasSidecar: only managed sidecars on network is unused", () => {
  const proxy: DockerContainerDetails = {
    name: "nas-proxy-test",
    id: "id-nas-proxy-test",
    running: true,
    labels: {},
    networks: ["nas-proxy-test"],
    networkMode: "bridge",
    startedAt: "2026-01-01T00:00:00Z",
  };
  const dind: DockerContainerDetails = {
    name: "nas-dind-shared",
    id: "id-nas-dind-shared",
    running: true,
    labels: {},
    networks: ["nas-proxy-test"],
    networkMode: "bridge",
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
      buildSidecarUsageIndex([proxy, dind]),
    ),
  ).toEqual(true);
});

test("isUnusedNasSidecar: session network with active container keeps proxy alive", () => {
  const proxy: DockerContainerDetails = {
    name: "nas-proxy-shared",
    id: "id-nas-proxy-shared",
    running: true,
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_PROXY,
    },
    networks: ["nas-session-example"],
    networkMode: "bridge",
    startedAt: "2026-01-01T00:00:00Z",
  };
  const userContainer: DockerContainerDetails = {
    name: "nas-sandbox",
    id: "id-nas-sandbox",
    running: true,
    labels: {},
    networks: ["nas-session-example"],
    networkMode: "bridge",
    startedAt: "2026-01-01T00:00:00Z",
  };
  const sessionNetwork: DockerNetworkDetails = {
    name: "nas-session-example",
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_SESSION_NETWORK,
    },
    containers: ["nas-proxy-shared", "nas-sandbox"],
  };

  expect(
    isUnusedNasSidecar(
      proxy,
      new Map([
        [proxy.name, proxy],
        [userContainer.name, userContainer],
      ]),
      new Map([[sessionNetwork.name, sessionNetwork]]),
      buildSidecarUsageIndex([proxy, userContainer]),
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
  options: {
    running?: boolean;
    networks?: string[];
    id?: string;
    networkMode?: string;
  } = {},
): DockerContainerDetails {
  return {
    name,
    id: options.id ?? `id-${name}`,
    running: options.running ?? true,
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: kind,
    },
    networks: [...(options.networks ?? [])],
    networkMode: options.networkMode ?? "bridge",
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
    createManagedContainer("nas-proxy-sidecar", NAS_KIND_PROXY, {
      networks: ["nas-session-example"],
    }),
  );
  backend.containers.set("nas-sandbox", {
    name: "nas-sandbox",
    id: "id-nas-sandbox",
    running: true,
    labels: {},
    networks: ["nas-session-example"],
    networkMode: "bridge",
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
    "nas-proxy-shared",
    createManagedContainer("nas-proxy-shared", NAS_KIND_PROXY, {
      running: false,
      networks: ["nas-session-orphan"],
    }),
  );
  backend.networks.set(
    "nas-session-orphan",
    createManagedNetwork("nas-session-orphan", NAS_KIND_SESSION_NETWORK, [
      "nas-proxy-shared",
    ]),
  );

  const result = await cleanNasContainers(backend);

  expect(result.removedContainers).toEqual(["nas-proxy-shared"]);
  expect(result.removedNetworks).toEqual(["nas-session-orphan"]);
  expect(result.removedVolumes).toEqual([]);
  expect(backend.stopped).toEqual([]);
});

test("cleanNasContainers: removes session data and legacy cache but keeps registry cache", async () => {
  const backend = new FakeBackend();
  backend.containers.set(
    "nas-registry-mirror-orphan",
    createManagedContainer(
      "nas-registry-mirror-orphan",
      NAS_KIND_REGISTRY_MIRROR,
      { running: false },
    ),
  );
  backend.volumes.set("nas-dind-data-orphan", {
    name: "nas-dind-data-orphan",
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_DIND_DATA,
    },
    containers: [],
  });
  backend.volumes.set("nas-docker-cache", {
    name: "nas-docker-cache",
    labels: {},
    containers: [],
  });
  backend.volumes.set("nas-registry-cache", {
    name: "nas-registry-cache",
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_REGISTRY_CACHE,
    },
    containers: [],
  });

  const result = await cleanNasContainers(backend);

  expect(result.removedContainers).toEqual(["nas-registry-mirror-orphan"]);
  expect(result.removedVolumes).toEqual([
    "nas-dind-data-orphan",
    "nas-docker-cache",
  ]);
  expect(backend.volumes.has("nas-registry-cache")).toBe(true);
});

test("isUnusedNasSidecar: a namespace joiner keeps its owner alive", () => {
  const dind = createManagedContainer("nas-dind-abc12345", "dind", {
    id: "dindid",
    networks: ["nas-session-net-abc12345"],
  });
  const agent = createManagedContainer("nas-agent-sess_abc12345", "agent", {
    id: "agentid",
    networks: [],
    networkMode: "container:dindid",
  });
  const containers = new Map([
    [dind.name, dind],
    [agent.name, agent],
  ]);
  const networks = new Map([
    [
      "nas-session-net-abc12345",
      createManagedNetwork(
        "nas-session-net-abc12345",
        NAS_KIND_SESSION_NETWORK,
        [dind.name],
      ),
    ],
  ]);

  expect(
    isUnusedNasSidecar(
      dind,
      containers,
      networks,
      buildSidecarUsageIndex(containers.values()),
    ),
  ).toBe(false);
});

test("isUnusedNasSidecar: a namespace joiner keeps the shared proxy alive", () => {
  const dind = createManagedContainer("nas-dind-abc12345", "dind", {
    id: "dindid",
    networks: ["nas-session-net-abc12345"],
  });
  const proxy = createManagedContainer("nas-proxy-shared", "proxy", {
    id: "proxyid",
    networks: ["nas-session-net-abc12345"],
  });
  const agent = createManagedContainer("nas-agent-sess_abc12345", "agent", {
    id: "agentid",
    networks: [],
    networkMode: "container:dindid",
  });
  const containers = new Map([
    [dind.name, dind],
    [proxy.name, proxy],
    [agent.name, agent],
  ]);
  const networks = new Map([
    [
      "nas-session-net-abc12345",
      createManagedNetwork(
        "nas-session-net-abc12345",
        NAS_KIND_SESSION_NETWORK,
        [dind.name, proxy.name],
      ),
    ],
  ]);

  expect(
    isUnusedNasSidecar(
      proxy,
      containers,
      networks,
      buildSidecarUsageIndex(containers.values()),
    ),
  ).toBe(false);
});

test("isUnusedNasSidecar: a namespace joiner keeps its session mirror alive", () => {
  const networkName = "nas-session-net-abc12345";
  const dind = createManagedContainer("nas-dind-abc12345", NAS_KIND_DIND, {
    id: "dindid",
    networks: [networkName],
  });
  const mirror = createManagedContainer(
    "nas-registry-mirror-abc12345",
    NAS_KIND_REGISTRY_MIRROR,
    { id: "mirrorid", networks: [networkName] },
  );
  const agent = createManagedContainer("nas-agent-sess_abc12345", "agent", {
    id: "agentid",
    networks: [],
    networkMode: "container:dindid",
  });
  const containers = new Map([
    [dind.name, dind],
    [mirror.name, mirror],
    [agent.name, agent],
  ]);
  const networks = new Map([
    [
      networkName,
      createManagedNetwork(networkName, NAS_KIND_SESSION_NETWORK, [
        dind.name,
        mirror.name,
      ]),
    ],
  ]);

  expect(
    isUnusedNasSidecar(
      mirror,
      containers,
      networks,
      buildSidecarUsageIndex(containers.values()),
    ),
  ).toBe(false);
});

test("isUnusedNasSidecar: an orphan with no joiner is still unused", () => {
  const dind = createManagedContainer("nas-dind-shared", "dind", {
    id: "orphanid",
    networks: ["nas-session-net-old"],
  });
  const containers = new Map([[dind.name, dind]]);
  const networks = new Map([
    [
      "nas-session-net-old",
      createManagedNetwork("nas-session-net-old", NAS_KIND_SESSION_NETWORK, [
        dind.name,
      ]),
    ],
  ]);

  expect(
    isUnusedNasSidecar(
      dind,
      containers,
      networks,
      buildSidecarUsageIndex(containers.values()),
    ),
  ).toBe(true);
});

test("isUnusedNasSidecar: a joiner with no resolvable owner does not keep an unrelated sidecar alive", () => {
  // The container map is built from `docker ps`, which lists running
  // containers only. A joiner's owner can stop between when the joiner
  // was started and when cleanup runs, leaving `container:<id>` pointing
  // at nothing in this map -- this is a normal, reachable state, not a
  // corrupt one.
  const dind = createManagedContainer("nas-dind-shared", "dind", {
    id: "dindid",
    networks: ["nas-session-net-old"],
  });
  const danglingJoiner = createManagedContainer(
    "nas-agent-sess_gone",
    "agent",
    {
      id: "agentid",
      networks: [],
      networkMode: "container:stopped-owner-id",
    },
  );
  const containers = new Map([
    [dind.name, dind],
    [danglingJoiner.name, danglingJoiner],
  ]);
  const networks = new Map([
    [
      "nas-session-net-old",
      createManagedNetwork("nas-session-net-old", NAS_KIND_SESSION_NETWORK, [
        dind.name,
      ]),
    ],
  ]);

  expect(
    isUnusedNasSidecar(
      dind,
      containers,
      networks,
      buildSidecarUsageIndex(containers.values()),
    ),
  ).toBe(true);
});

test("isUnusedNasSidecar: a live joiner keeps its owner alive even with no nas-managed network", () => {
  // The owner reports no networks of its own at this moment -- e.g. it was
  // disconnected from its nas-managed network but not yet removed. Network
  // membership alone (relevantNetworks / virtualMembers) finds nothing to
  // check, so only a direct ownership lookup can see the running joiner.
  const dind = createManagedContainer("nas-dind-abc12345", "dind", {
    id: "dindid",
    networks: [],
  });
  const agent = createManagedContainer("nas-agent-sess_abc12345", "agent", {
    id: "agentid",
    networks: [],
    networkMode: "container:dindid",
  });
  const containers = new Map([
    [dind.name, dind],
    [agent.name, agent],
  ]);
  const networks = new Map<string, DockerNetworkDetails>();

  expect(
    isUnusedNasSidecar(
      dind,
      containers,
      networks,
      buildSidecarUsageIndex(containers.values()),
    ),
  ).toBe(false);
});

test("isUnusedNasSidecar: a sidecar joining another sidecar's namespace is not credited as a user", () => {
  // The candidate here is itself nas-managed (kind: proxy) and reports
  // `container:dindid` as its network mode. If it were credited like a
  // regular joiner, two sidecars could reference each other's namespace
  // and keep each other alive forever.
  const dind = createManagedContainer("nas-dind-shared", "dind", {
    id: "dindid",
    networks: ["nas-session-net-abc12345"],
  });
  const otherSidecar = createManagedContainer("nas-proxy-other", "proxy", {
    id: "proxyid2",
    networks: [],
    networkMode: "container:dindid",
  });
  const containers = new Map([
    [dind.name, dind],
    [otherSidecar.name, otherSidecar],
  ]);
  const networks = new Map([
    [
      "nas-session-net-abc12345",
      createManagedNetwork(
        "nas-session-net-abc12345",
        NAS_KIND_SESSION_NETWORK,
        [dind.name],
      ),
    ],
  ]);

  expect(
    isUnusedNasSidecar(
      dind,
      containers,
      networks,
      buildSidecarUsageIndex(containers.values()),
    ),
  ).toBe(true);
});
