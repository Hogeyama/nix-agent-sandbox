import {
  type ForwardSpec,
  forwardKey,
  type PortPair,
} from "../network/port_forward_model.ts";

export interface ForwardConfigInput {
  localForwards?: readonly PortPair[];
  remoteForwards?: readonly PortPair[];
  proxy?: { forwardPorts?: readonly number[] };
}

export interface ForwardConfigResult {
  entries: ForwardSpec[];
  errors: string[];
  warnings: string[];
}

const MIN_PORT = 1;
const MAX_PORT = 65_535;

export function normalizePortForwards(
  profileName: string,
  input: ForwardConfigInput,
  reservedPorts: readonly number[],
): ForwardConfigResult {
  const entries: ForwardSpec[] = [];
  const errors: string[] = [];
  const byKey = new Map<string, ForwardSpec>();
  const localListeners = new Map<number, ForwardSpec>();
  const reserved = new Set(reservedPorts);

  const add = (
    direction: ForwardSpec["direction"],
    pair: PortPair,
    label: string,
  ) => {
    const spec: ForwardSpec = { direction, ...pair };
    for (const field of ["hostPort", "containerPort"] as const) {
      const value = spec[field];
      if (
        !Number.isSafeInteger(value) ||
        value < MIN_PORT ||
        value > MAX_PORT
      ) {
        errors.push(
          `profile "${profileName}": ${label}.${field} must be an integer from ${MIN_PORT} to ${MAX_PORT} (got ${value})`,
        );
      }
    }

    if (direction === "remote" && reserved.has(spec.containerPort)) {
      errors.push(
        `profile "${profileName}": ${label}.containerPort ${spec.containerPort} is reserved for an internal listener (including the Docker daemon when enabled)`,
      );
    }

    const key = forwardKey(spec);
    const existing = byKey.get(key);
    if (existing) {
      if (existing.hostPort !== spec.hostPort) {
        errors.push(
          `profile "${profileName}": ${label} conflicts with ${key}: hostPort ${spec.hostPort} differs from ${existing.hostPort}`,
        );
      }
      return;
    }

    if (direction === "local") {
      const listener = localListeners.get(spec.hostPort);
      if (listener && listener.containerPort !== spec.containerPort) {
        errors.push(
          `profile "${profileName}": ${label}.hostPort ${spec.hostPort} is already used by local:${listener.containerPort}`,
        );
        return;
      }
      localListeners.set(spec.hostPort, spec);
    }

    byKey.set(key, spec);
    entries.push(spec);
  };

  for (const [i, pair] of (input.localForwards ?? []).entries()) {
    add("local", pair, `network.localForwards[${i}]`);
  }
  for (const [i, pair] of (input.remoteForwards ?? []).entries()) {
    add("remote", pair, `network.remoteForwards[${i}]`);
  }

  const legacyPorts = input.proxy?.forwardPorts ?? [];
  for (const [i, port] of legacyPorts.entries()) {
    add(
      "remote",
      { hostPort: port, containerPort: port },
      `network.proxy.forwardPorts[${i}]`,
    );
  }

  const warnings =
    legacyPorts.length === 0
      ? []
      : [migrationWarning(profileName, legacyPorts)];
  return { entries, errors, warnings };
}

function migrationWarning(
  profileName: string,
  ports: readonly number[],
): string {
  const replacements = ports
    .map(
      (port) =>
        `new PortForwardConfig { hostPort = ${port}; containerPort = ${port} }`,
    )
    .join("; ");
  return (
    `[warn] profile "${profileName}": network.proxy.forwardPorts is deprecated; ` +
    `replace it with network.remoteForwards using: ` +
    `network { remoteForwards { ${replacements} } }. ` +
    `See docs/migration/port-forwarding.md.`
  );
}
