export type ForwardDirection = "local" | "remote";

export type ForwardOwner = "config" | "dynamic" | "internal";

export interface PortPair {
  hostPort: number;
  containerPort: number;
}

export interface ForwardSpec extends PortPair {
  direction: ForwardDirection;
}

export interface InitialForward extends ForwardSpec {
  owners: ForwardOwner[];
}

export type ForwardState = "pending" | "active" | "unavailable" | "failed";

export interface ManagedForward extends ForwardSpec {
  owners: ForwardOwner[];
  createdAt: string;
  state: ForwardState;
  error?: string;
}

export interface RemoveForwardResult {
  removed: boolean;
  retainedInternal: boolean;
  listenerClosed: boolean;
}

export interface AddForwardResult {
  entry: ManagedForward;
  probe: "ok" | "no-answer" | "container-not-running" | "relay-unreachable";
}

export function removeUserOwners(entry: ManagedForward): ManagedForward | null {
  const owners = entry.owners.filter((owner) => owner === "internal");
  return owners.length === 0 ? null : { ...entry, owners };
}

/** Only public model fields cross the registry or API boundary. */
export function copyManagedForward(entry: ManagedForward): ManagedForward {
  return {
    direction: entry.direction,
    hostPort: entry.hostPort,
    containerPort: entry.containerPort,
    owners: [...entry.owners],
    createdAt: entry.createdAt,
    state: entry.state,
    ...(entry.error === undefined ? {} : { error: entry.error }),
  };
}

/** Host/container are separate graph nodes, even for equal port numbers. */
export function createsForwardCycle(
  entries: readonly ForwardSpec[],
  added: ForwardSpec,
): boolean {
  const endpoints = (entry: ForwardSpec): [string, string] =>
    entry.direction === "local"
      ? [`host:${entry.hostPort}`, `container:${entry.containerPort}`]
      : [`container:${entry.containerPort}`, `host:${entry.hostPort}`];
  const edges = new Map(entries.map(endpoints));
  const [source, target] = endpoints(added);
  const visited = new Set<string>();
  let node: string | undefined = target;
  while (node !== undefined && !visited.has(node)) {
    if (node === source) return true;
    visited.add(node);
    node = edges.get(node);
  }
  return false;
}

export function forwardKey(
  spec: Pick<ForwardSpec, "direction" | "containerPort">,
): string {
  return `${spec.direction}:${spec.containerPort}`;
}
