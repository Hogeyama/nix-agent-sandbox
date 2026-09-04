export const NAS_MANAGED_LABEL = "nas.managed";
export const NAS_KIND_LABEL = "nas.kind";
export const NAS_MANAGED_VALUE = "true";

export const NAS_KIND_DIND = "dind";
export const NAS_KIND_PROXY = "proxy";
export const NAS_KIND_REGISTRY_MIRROR = "registry-mirror";
export const NAS_KIND_DIND_NETWORK = "dind-network";
export const NAS_KIND_PROXY_NETWORK = "proxy-network";
export const NAS_KIND_SESSION_NETWORK = "session-network";
export const NAS_KIND_DIND_TMP = "dind-tmp";
export const NAS_KIND_DIND_DATA = "dind-data";
export const NAS_KIND_REGISTRY_CACHE = "registry-cache";
export const NAS_KIND_AGENT = "agent";
export const NAS_PWD_LABEL = "nas.pwd";
export const NAS_SESSION_ID_LABEL = "nas.session_id";
export const NAS_ADDON_HASH_LABEL = "nas.addon-hash";

/** Build the docker container name for a given agent session ID. */
export function containerNameForSession(sessionId: string): string {
  return `nas-agent-${sessionId}`;
}

export type DockerLabels = Record<string, string>;

export function isNasManagedLabel(labels: DockerLabels): boolean {
  return labels[NAS_MANAGED_LABEL] === NAS_MANAGED_VALUE;
}

export function isNasManagedSidecar(
  labels: DockerLabels,
  name: string,
): boolean {
  if (isNasManagedLabel(labels)) {
    return (
      labels[NAS_KIND_LABEL] === NAS_KIND_DIND ||
      labels[NAS_KIND_LABEL] === NAS_KIND_PROXY ||
      labels[NAS_KIND_LABEL] === NAS_KIND_REGISTRY_MIRROR
    );
  }
  return isLegacyNasSidecarName(name);
}

export function isNasManagedNetwork(
  labels: DockerLabels,
  name: string,
): boolean {
  if (isNasManagedLabel(labels)) {
    return (
      labels[NAS_KIND_LABEL] === NAS_KIND_DIND_NETWORK ||
      labels[NAS_KIND_LABEL] === NAS_KIND_PROXY_NETWORK ||
      labels[NAS_KIND_LABEL] === NAS_KIND_SESSION_NETWORK
    );
  }
  return isLegacyNasNetworkName(name);
}

export function isNasManagedEphemeralVolume(
  labels: DockerLabels,
  name: string,
): boolean {
  if (isNasManagedLabel(labels)) {
    const kind = labels[NAS_KIND_LABEL];
    return kind === NAS_KIND_DIND_TMP || kind === NAS_KIND_DIND_DATA;
  }
  return isLegacyNasEphemeralVolumeName(name);
}

export function isNasManagedAgent(labels: DockerLabels): boolean {
  return isNasManagedLabel(labels) && labels[NAS_KIND_LABEL] === NAS_KIND_AGENT;
}

/** nas.managed なコンテナすべて (sidecar + agent) */
export function isNasManagedContainer(
  labels: DockerLabels,
  name: string,
): boolean {
  return isNasManagedSidecar(labels, name) || isNasManagedAgent(labels);
}

export function isLegacyNasSidecarName(name: string): boolean {
  return (
    name === "nas-dind-shared" ||
    name === "nas-envoy-shared" ||
    (name.startsWith("nas-dind-") && !name.endsWith("-tmp")) ||
    name.startsWith("nas-envoy-") ||
    name.startsWith("nas-proxy-")
  );
}

export function isLegacyNasNetworkName(name: string): boolean {
  return (
    name === "nas-dind-shared" ||
    name.startsWith("nas-dind-") ||
    name.startsWith("nas-session-") ||
    name.startsWith("nas-proxy-")
  );
}

export function isLegacyNasEphemeralVolumeName(name: string): boolean {
  return (
    name === "nas-docker-cache" ||
    name === "nas-dind-shared-tmp" ||
    name.startsWith("nas-dind-tmp-")
  );
}
