import type {
  DockerLaunchImage,
  DockerLaunchInspection,
} from "../../docker/launch_inspection.ts";
import { encodeDynamicEnvOps } from "../../pipeline/env_ops.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";

export interface ExpectedLaunchInspection {
  readonly containerId: string;
  readonly container: ContainerPlan;
  readonly image: DockerLaunchImage;
  readonly command: readonly string[] | null;
}

export function compareLaunchInspection(
  expected: ExpectedLaunchInspection,
  actual: DockerLaunchInspection,
): readonly string[] {
  const diagnostics = new Set<string>();
  const add = (message: string): void => {
    diagnostics.add(message);
  };

  if (actual.id !== expected.containerId) add("container id differs");
  if (!actual.running) add("container is not running");
  if (actual.config.image !== expected.container.image) {
    add("image reference differs");
  }
  if (actual.imageId !== expected.image.id) add("image id differs");
  // Config.User is the image/container launch setting. Effective process
  // identity is a separate readiness check after the entrypoint drops uid.
  if (actual.config.user !== expected.image.user) {
    add("configured user differs from image");
  }
  if (!orderedEqual(actual.config.entrypoint, expected.image.entrypoint)) {
    add("entrypoint differs from image");
  }
  if (!orderedEqual(actual.config.command, expected.command)) {
    add("command differs");
  }
  if (actual.config.workingDir !== expected.container.workDir) {
    add("working directory differs");
  }

  compareMounts(expected.container, actual, add);
  compareEnvironment(expected.container, actual, add);
  compareNetwork(expected.container, actual, add);

  if (actual.privileged) add("privileged container is not allowed");
  if (actual.capAdd.length > 0) add("added capabilities are not allowed");
  if (actual.capDrop.length > 0) add("capability drops differ");
  if (actual.securityOpt.length > 0) add("security options differ");

  for (const [key, value] of Object.entries(expected.container.labels)) {
    if (!Object.hasOwn(actual.labels, key) || actual.labels[key] !== value) {
      add("required label differs");
    }
  }

  return [...diagnostics];
}

function compareMounts(
  expected: ContainerPlan,
  actual: DockerLaunchInspection,
  add: (diagnostic: string) => void,
): void {
  const matchedActual = new Set<number>();
  for (const expectedMount of expected.mounts) {
    const index = actual.mounts.findIndex(
      (mount, candidateIndex) =>
        !matchedActual.has(candidateIndex) &&
        mount.target === expectedMount.target,
    );
    if (index < 0) {
      add("expected mount is missing");
      continue;
    }
    matchedActual.add(index);
    const actualMount = actual.mounts[index];
    if (
      actualMount.type !== "bind" ||
      actualMount.source !== expectedMount.source ||
      actualMount.readOnly !== (expectedMount.readOnly ?? false)
    ) {
      add("mount differs");
    }
  }
  if (actual.mounts.some((_, index) => !matchedActual.has(index))) {
    add("unexpected mount");
  }
}

function compareEnvironment(
  expected: ContainerPlan,
  actual: DockerLaunchInspection,
  add: (diagnostic: string) => void,
): void {
  const required = new Map(Object.entries(expected.env.static));
  if (expected.env.dynamicOps.length > 0) {
    required.set("NAS_ENV_OPS", encodeDynamicEnvOps(expected.env.dynamicOps));
  }

  for (const [key, value] of required) {
    const prefix = `${key}=`;
    const matches = actual.environment.filter((entry) =>
      entry.startsWith(prefix),
    );
    if (matches.length !== 1 || matches[0] !== `${prefix}${value}`) {
      add("environment variable differs");
    }
  }
}

function compareNetwork(
  expected: ContainerPlan,
  actual: DockerLaunchInspection,
  add: (diagnostic: string) => void,
): void {
  const network = expected.network;
  if (network === undefined || network.mode !== "network") {
    add("expected launch does not have a named network");
    return;
  }

  if (actual.networkMode !== network.name) add("network mode differs");
  if (!actual.networks.includes(network.name)) {
    add("expected network is missing");
  }
  if (actual.networks.some((name) => name !== network.name)) {
    add("unexpected network");
  }
}

function orderedEqual(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.length === right.length && left.every((item, i) => item === right[i])
  );
}
