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

export function forwardKey(
  spec: Pick<ForwardSpec, "direction" | "containerPort">,
): string {
  return `${spec.direction}:${spec.containerPort}`;
}
