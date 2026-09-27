import {
  type DockerRunDetachedOptions,
  dockerRm,
  dockerRunDetached,
} from "../client.ts";

/** Docker's allocator and RootlessKit bind in different network namespaces. */
export async function runProxyContainer(
  options: Omit<DockerRunDetachedOptions, "publishedPorts">,
  docker = { run: dockerRunDetached, remove: dockerRm },
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await docker.run({ ...options, publishedPorts: ["127.0.0.1::8080"] });
      return;
    } catch (error) {
      // A port free inside dockerd can already be occupied where RootlessKit
      // publishes it. Remove the failed container before requesting a new port.
      if (
        attempt >= 2 ||
        !(error instanceof Error) ||
        !error.message.includes("RootlessKit PortManager.AddPort()") ||
        !error.message.includes("bind: address already in use")
      ) {
        throw error;
      }
      await docker.remove(options.name);
    }
  }
}
