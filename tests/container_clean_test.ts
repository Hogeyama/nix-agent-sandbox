import { assertEquals } from "@std/assert";
import type {
  DockerContainerDetails,
  DockerNetworkDetails,
} from "../src/docker/client.ts";
import {
  cleanNasContainers,
  isUnusedNasSidecar,
} from "../src/container_clean.ts";
import {
  isNasManagedNetwork,
  isNasManagedSidecar,
  NAS_KIND_DIND,
  NAS_KIND_ENVOY,
  NAS_KIND_LABEL,
  NAS_KIND_SESSION_NETWORK,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
} from "../src/docker/nas_resources.ts";

const TEST_IMAGE = "alpine:latest";
const PREFIX = `nas-clean-${Date.now()}`;
const DOCKER_INTEGRATION_AVAILABLE = await canRunDockerIntegration();

Deno.test("isNasManagedSidecar: nas-sandbox is not a managed sidecar", () => {
  assertEquals(isNasManagedSidecar({}, "nas-sandbox"), false);
});

Deno.test("isNasManagedSidecar: labeled sidecar is detected", () => {
  assertEquals(
    isNasManagedSidecar({
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_DIND,
    }, "custom-name"),
    true,
  );
});

Deno.test("isNasManagedSidecar: labeled envoy sidecar is detected", () => {
  assertEquals(
    isNasManagedSidecar({
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_ENVOY,
    }, "custom-envoy"),
    true,
  );
});

Deno.test("isNasManagedSidecar: legacy shared envoy name is detected", () => {
  assertEquals(isNasManagedSidecar({}, "nas-envoy-shared"), true);
});

Deno.test("isNasManagedNetwork: labeled session network is detected", () => {
  assertEquals(
    isNasManagedNetwork({
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_SESSION_NETWORK,
    }, "custom-session-network"),
    true,
  );
});

Deno.test("isNasManagedNetwork: legacy session network name is detected", () => {
  assertEquals(isNasManagedNetwork({}, "nas-session-example"), true);
});

Deno.test("isUnusedNasSidecar: active non-managed container keeps sidecar alive", () => {
  const sidecar: DockerContainerDetails = {
    name: "nas-proxy-test",
    running: true,
    labels: {},
    networks: ["nas-proxy-test"],
  };
  const userContainer: DockerContainerDetails = {
    name: "nas-sandbox",
    running: true,
    labels: {},
    networks: ["nas-proxy-test"],
  };
  const network: DockerNetworkDetails = {
    name: "nas-proxy-test",
    labels: {},
    containers: ["nas-proxy-test", "nas-sandbox"],
  };

  assertEquals(
    isUnusedNasSidecar(
      sidecar,
      new Map([
        [sidecar.name, sidecar],
        [userContainer.name, userContainer],
      ]),
      new Map([[network.name, network]]),
    ),
    false,
  );
});

Deno.test("isUnusedNasSidecar: only managed sidecars on network is unused", () => {
  const proxy: DockerContainerDetails = {
    name: "nas-proxy-test",
    running: true,
    labels: {},
    networks: ["nas-proxy-test"],
  };
  const dind: DockerContainerDetails = {
    name: "nas-dind-shared",
    running: true,
    labels: {},
    networks: ["nas-proxy-test"],
  };
  const network: DockerNetworkDetails = {
    name: "nas-proxy-test",
    labels: {},
    containers: ["nas-proxy-test", "nas-dind-shared"],
  };

  assertEquals(
    isUnusedNasSidecar(
      proxy,
      new Map([
        [proxy.name, proxy],
        [dind.name, dind],
      ]),
      new Map([[network.name, network]]),
    ),
    true,
  );
});

Deno.test("isUnusedNasSidecar: session network with active container keeps envoy alive", () => {
  const envoy: DockerContainerDetails = {
    name: "nas-envoy-shared",
    running: true,
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_ENVOY,
    },
    networks: ["nas-session-example"],
  };
  const userContainer: DockerContainerDetails = {
    name: "nas-sandbox",
    running: true,
    labels: {},
    networks: ["nas-session-example"],
  };
  const sessionNetwork: DockerNetworkDetails = {
    name: "nas-session-example",
    labels: {
      [NAS_MANAGED_LABEL]: NAS_MANAGED_VALUE,
      [NAS_KIND_LABEL]: NAS_KIND_SESSION_NETWORK,
    },
    containers: ["nas-envoy-shared", "nas-sandbox"],
  };

  assertEquals(
    isUnusedNasSidecar(
      envoy,
      new Map([
        [envoy.name, envoy],
        [userContainer.name, userContainer],
      ]),
      new Map([[sessionNetwork.name, sessionNetwork]]),
    ),
    false,
  );
});

async function docker(args: string[]): Promise<boolean> {
  const cmd = new Deno.Command("docker", {
    args,
    stdout: "null",
    stderr: "null",
  });
  const result = await cmd.output();
  return result.success;
}

async function canRunDockerIntegration(): Promise<boolean> {
  if (!await docker(["version"])) {
    return false;
  }
  return await docker(["image", "inspect", TEST_IMAGE]) ||
    await docker(["pull", "-q", TEST_IMAGE]);
}

async function ensureTestImage(): Promise<void> {
  const success = await docker(["image", "inspect", TEST_IMAGE]) ||
    await docker(["pull", "-q", TEST_IMAGE]);
  if (!success) {
    throw new Error(`Failed to ensure image ${TEST_IMAGE}`);
  }
}

async function runSleepContainer(
  name: string,
  args: string[] = [],
): Promise<void> {
  const success = await docker([
    "run",
    "-d",
    "--name",
    name,
    ...args,
    TEST_IMAGE,
    "sleep",
    "300",
  ]);
  if (!success) {
    throw new Error(`Failed to start container ${name}`);
  }
}

async function networkExists(name: string): Promise<boolean> {
  return await docker(["network", "inspect", name]);
}

async function volumeExists(name: string): Promise<boolean> {
  return await docker(["volume", "inspect", name]);
}

async function containerExists(name: string): Promise<boolean> {
  return await docker(["container", "inspect", name]);
}

async function cleanupNames(names: {
  containers?: string[];
  networks?: string[];
  volumes?: string[];
}): Promise<void> {
  for (const name of names.containers ?? []) {
    await docker(["stop", "--time", "0", name]).catch(() => {});
    await docker(["rm", name]).catch(() => {});
  }
  for (const name of names.networks ?? []) {
    await docker(["network", "rm", name]).catch(() => {});
  }
  for (const name of names.volumes ?? []) {
    await docker(["volume", "rm", name]).catch(() => {});
  }
}

Deno.test({
  name:
    "cleanNasContainers: removes unused shared dind container, network, and tmp volume",
  ignore: !DOCKER_INTEGRATION_AVAILABLE,
  async fn() {
    const suffix = `${PREFIX}-dind`;
    const containerName = `nas-dind-${suffix}`;
    const networkName = containerName;
    const volumeName = `nas-dind-tmp-${suffix}`;

    await cleanupNames({
      containers: [containerName],
      networks: [networkName],
      volumes: [volumeName],
    });
    await ensureTestImage();

    try {
      await docker(["volume", "create", volumeName]);
      await docker(["network", "create", networkName]);
      await runSleepContainer(containerName, [
        "-v",
        `${volumeName}:/tmp/nas-shared`,
      ]);
      await docker(["network", "connect", networkName, containerName]);

      const result = await cleanNasContainers();

      assertEquals(result.removedContainers.includes(containerName), true);
      assertEquals(result.removedNetworks.includes(networkName), true);
      assertEquals(result.removedVolumes.includes(volumeName), true);
      assertEquals(await containerExists(containerName), false);
      assertEquals(await networkExists(networkName), false);
      assertEquals(await volumeExists(volumeName), false);
    } finally {
      await cleanupNames({
        containers: [containerName],
        networks: [networkName],
        volumes: [volumeName],
      });
    }
  },
});

Deno.test({
  name:
    "cleanNasContainers: keeps sidecar when an active non-managed container shares the network",
  ignore: !DOCKER_INTEGRATION_AVAILABLE,
  async fn() {
    const suffix = `${PREFIX}-keep`;
    const sidecarName = `nas-proxy-${suffix}`;
    const userName = `user-${suffix}`;
    const networkName = sidecarName;

    await cleanupNames({
      containers: [sidecarName, userName],
      networks: [networkName],
    });
    await ensureTestImage();

    try {
      await docker(["network", "create", networkName]);
      await runSleepContainer(sidecarName);
      await runSleepContainer(userName);
      await docker(["network", "connect", networkName, sidecarName]);
      await docker(["network", "connect", networkName, userName]);

      const result = await cleanNasContainers();

      assertEquals(result.removedContainers.includes(sidecarName), false);
      assertEquals(await containerExists(sidecarName), true);
      assertEquals(await networkExists(networkName), true);
    } finally {
      await cleanupNames({
        containers: [sidecarName, userName],
        networks: [networkName],
      });
    }
  },
});

Deno.test({
  name:
    "cleanNasContainers: removes unused shared envoy container and session network",
  ignore: !DOCKER_INTEGRATION_AVAILABLE,
  async fn() {
    const suffix = `${PREFIX}-envoy`;
    const sidecarName = `nas-envoy-${suffix}`;
    const networkName = `nas-session-${suffix}`;

    await cleanupNames({
      containers: [sidecarName],
      networks: [networkName],
    });
    await ensureTestImage();

    try {
      await docker([
        "network",
        "create",
        "--label",
        `${NAS_MANAGED_LABEL}=${NAS_MANAGED_VALUE}`,
        "--label",
        `${NAS_KIND_LABEL}=${NAS_KIND_SESSION_NETWORK}`,
        networkName,
      ]);
      await runSleepContainer(sidecarName, [
        "--label",
        `${NAS_MANAGED_LABEL}=${NAS_MANAGED_VALUE}`,
        "--label",
        `${NAS_KIND_LABEL}=${NAS_KIND_ENVOY}`,
      ]);
      await docker(["network", "connect", networkName, sidecarName]);

      const result = await cleanNasContainers();

      assertEquals(result.removedContainers.includes(sidecarName), true);
      assertEquals(result.removedNetworks.includes(networkName), true);
      assertEquals(await containerExists(sidecarName), false);
      assertEquals(await networkExists(networkName), false);
    } finally {
      await cleanupNames({
        containers: [sidecarName],
        networks: [networkName],
      });
    }
  },
});
