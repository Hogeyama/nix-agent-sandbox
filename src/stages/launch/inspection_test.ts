import { expect, test } from "bun:test";
import type {
  DockerLaunchImage,
  DockerLaunchInspection,
} from "../../docker/launch_inspection.ts";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import { encodeDynamicEnvOps } from "../../pipeline/env_ops.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import {
  compareLaunchInspection,
  type ExpectedLaunchInspection,
} from "./inspection.ts";

const secretSentinel = "SECRET-compare-value-8842";

const container: ContainerPlan = {
  ...emptyContainerPlan("nas-sandbox:fixture", "/workspace"),
  mounts: [
    { source: "/host/workspace", target: "/workspace" },
    {
      source: "/host/config",
      target: "/workspace/.devcontainer",
      readOnly: true,
    },
  ],
  env: {
    static: { EMPTY: "", TOKEN: secretSentinel },
    dynamicOps: [
      { mode: "prefix", key: "PATH", value: "/tools", separator: ":" },
    ],
  },
  network: { mode: "network", name: "nas-session", alias: "agent" },
  labels: { "nas.managed": "true", "nas.session-id": "session-1" },
};

const image: DockerLaunchImage = {
  id: "sha256:image-id",
  user: "",
  entrypoint: ["/entrypoint.sh"],
};

const expected: ExpectedLaunchInspection = {
  containerId: "container-id",
  container,
  image,
  command: ["/usr/local/bin/nas-devcontainer-idle"],
};

function matchingActual(): DockerLaunchInspection {
  return {
    id: "container-id",
    imageId: "sha256:image-id",
    running: true,
    config: {
      image: "nas-sandbox:fixture",
      user: "",
      entrypoint: ["/entrypoint.sh"],
      command: ["/usr/local/bin/nas-devcontainer-idle"],
      workingDir: "/workspace",
    },
    mounts: [
      {
        type: "bind",
        source: "/host/config",
        target: "/workspace/.devcontainer",
        readOnly: true,
      },
      {
        type: "bind",
        source: "/host/workspace",
        target: "/workspace",
        readOnly: false,
      },
    ],
    environment: [
      "PATH=/image/default",
      `NAS_ENV_OPS=${encodeDynamicEnvOps(container.env.dynamicOps)}`,
      `TOKEN=${secretSentinel}`,
      "EMPTY=",
    ],
    networkMode: "nas-session",
    networks: ["nas-session"],
    privileged: false,
    capAdd: [],
    capDrop: [],
    securityOpt: [],
    labels: {
      "com.docker.compose.project": "nas-project",
      "nas.session-id": "session-1",
      "nas.managed": "true",
    },
  };
}

test("compareLaunchInspection: accepts a matching inspection independent of order", () => {
  expect(compareLaunchInspection(expected, matchingActual())).toEqual([]);
});

const driftCases: ReadonlyArray<{
  readonly name: string;
  readonly mutate: (actual: DockerLaunchInspection) => DockerLaunchInspection;
  readonly diagnostic: string;
}> = [
  {
    name: "different container id",
    mutate: (actual) => ({ ...actual, id: "replacement-id" }),
    diagnostic: "container id differs",
  },
  {
    name: "stopped container",
    mutate: (actual) => ({ ...actual, running: false }),
    diagnostic: "container is not running",
  },
  {
    name: "different image reference",
    mutate: (actual) => ({
      ...actual,
      config: { ...actual.config, image: "nas-sandbox:other" },
    }),
    diagnostic: "image reference differs",
  },
  {
    name: "different immutable image id",
    mutate: (actual) => ({ ...actual, imageId: "sha256:replacement" }),
    diagnostic: "image id differs",
  },
  {
    name: "different configured user",
    mutate: (actual) => ({
      ...actual,
      config: { ...actual.config, user: "root" },
    }),
    diagnostic: "configured user differs from image",
  },
  {
    name: "entrypoint replacement",
    mutate: (actual) => ({
      ...actual,
      config: { ...actual.config, entrypoint: ["/bin/sh"] },
    }),
    diagnostic: "entrypoint differs from image",
  },
  {
    name: "command replacement",
    mutate: (actual) => ({
      ...actual,
      config: { ...actual.config, command: ["sleep", "infinity"] },
    }),
    diagnostic: "command differs",
  },
  {
    name: "working directory replacement",
    mutate: (actual) => ({
      ...actual,
      config: { ...actual.config, workingDir: "/tmp/replaced" },
    }),
    diagnostic: "working directory differs",
  },
  {
    name: "mount source replacement",
    mutate: (actual) => ({
      ...actual,
      mounts: actual.mounts.map((mount) =>
        mount.target === "/workspace"
          ? { ...mount, source: "/host/other" }
          : mount,
      ),
    }),
    diagnostic: "mount differs",
  },
  {
    name: "mount target replacement",
    mutate: (actual) => ({
      ...actual,
      mounts: actual.mounts.map((mount) =>
        mount.target === "/workspace"
          ? { ...mount, target: "/other-workspace" }
          : mount,
      ),
    }),
    diagnostic: "expected mount is missing",
  },
  {
    name: "read-only flag replacement",
    mutate: (actual) => ({
      ...actual,
      mounts: actual.mounts.map((mount) =>
        mount.target === "/workspace/.devcontainer"
          ? { ...mount, readOnly: false }
          : mount,
      ),
    }),
    diagnostic: "mount differs",
  },
  {
    name: "extra writable host mount",
    mutate: (actual) => ({
      ...actual,
      mounts: [
        ...actual.mounts,
        {
          type: "bind",
          source: "/",
          target: "/host",
          readOnly: false,
        },
      ],
    }),
    diagnostic: "unexpected mount",
  },
  {
    name: "different environment value",
    mutate: (actual) => ({
      ...actual,
      environment: actual.environment.map((entry) =>
        entry.startsWith("TOKEN=") ? `TOKEN=${secretSentinel}-wrong` : entry,
      ),
    }),
    diagnostic: "environment variable differs",
  },
  {
    name: "different network mode",
    mutate: (actual) => ({ ...actual, networkMode: "bridge" }),
    diagnostic: "network mode differs",
  },
  {
    name: "extra network",
    mutate: (actual) => ({
      ...actual,
      networks: [...actual.networks, "bridge"],
    }),
    diagnostic: "unexpected network",
  },
  {
    name: "missing network",
    mutate: (actual) => ({ ...actual, networks: [] }),
    diagnostic: "expected network is missing",
  },
  {
    name: "privileged container",
    mutate: (actual) => ({ ...actual, privileged: true }),
    diagnostic: "privileged container is not allowed",
  },
  {
    name: "added capability",
    mutate: (actual) => ({ ...actual, capAdd: ["SYS_ADMIN"] }),
    diagnostic: "added capabilities are not allowed",
  },
  {
    name: "capability drop drift",
    mutate: (actual) => ({ ...actual, capDrop: ["NET_RAW"] }),
    diagnostic: "capability drops differ",
  },
  {
    name: "security option drift",
    mutate: (actual) => ({
      ...actual,
      securityOpt: ["seccomp=unconfined"],
    }),
    diagnostic: "security options differ",
  },
  {
    name: "missing required label",
    mutate: (actual) => ({
      ...actual,
      labels: { "com.docker.compose.project": "nas-project" },
    }),
    diagnostic: "required label differs",
  },
];

for (const drift of driftCases) {
  test(`compareLaunchInspection: rejects ${drift.name}`, () => {
    const diagnostics = compareLaunchInspection(
      expected,
      drift.mutate(matchingActual()),
    );
    expect(diagnostics).toContain(drift.diagnostic);
    expect(diagnostics.join(" ")).not.toContain(secretSentinel);
  });
}

test("compareLaunchInspection: rejects plans without one named network", () => {
  const withoutNetwork: ExpectedLaunchInspection = {
    ...expected,
    container: { ...container, network: undefined },
  };
  expect(compareLaunchInspection(withoutNetwork, matchingActual())).toContain(
    "expected launch does not have a named network",
  );
});
