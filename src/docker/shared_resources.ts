import { NAS_SHARED_PROXY_CONTAINER } from "./nas_resources.ts";

/** Names of resources shared across sessions in one nas installation. */
export function sharedDockerResources(
  env: Readonly<Record<string, string | undefined>>,
): { proxyContainer: string; sandboxImage: string } {
  const namespace = env.NAS_RESOURCE_NAMESPACE;
  if (!namespace) {
    return {
      proxyContainer: NAS_SHARED_PROXY_CONTAINER,
      sandboxImage: "nas-sandbox",
    };
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(namespace)) {
    throw new Error("Invalid NAS_RESOURCE_NAMESPACE");
  }
  return {
    proxyContainer: `nas-proxy-${namespace}`,
    sandboxImage: `nas-sandbox-${namespace}`,
  };
}
