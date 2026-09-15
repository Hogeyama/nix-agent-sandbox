import { expect, test } from "bun:test";
import { Effect } from "effect";
import { DockerService, makeDockerServiceFake } from "../services/docker.ts";
import {
  type DockerLaunchImage,
  type DockerLaunchInspection,
  decodeDockerLaunchImage,
  decodeDockerLaunchInspection,
} from "./launch_inspection.ts";

const secretSentinel = "SECRET-inspect-value-7691";

function rawContainerInspection(): unknown {
  return [
    {
      Id: "container-id",
      Image: "sha256:image-id",
      State: { Running: true },
      Config: {
        Image: "nas-sandbox:fixture",
        User: "",
        Entrypoint: ["/entrypoint.sh"],
        Cmd: ["/usr/local/bin/nas-devcontainer-idle"],
        WorkingDir: "/workspace",
        Env: ["EMPTY=", `TOKEN=${secretSentinel}`],
        Labels: { "nas.managed": "true" },
      },
      Mounts: [
        {
          Type: "bind",
          Source: "/host/workspace",
          Destination: "/workspace",
          RW: true,
        },
      ],
      HostConfig: {
        NetworkMode: "nas-session",
        Privileged: false,
        CapAdd: null,
        CapDrop: ["NET_RAW"],
        SecurityOpt: null,
      },
      NetworkSettings: { Networks: { "nas-session": {} } },
    },
  ];
}

test("decodeDockerLaunchInspection: decodes the complete launch shape", () => {
  expect(decodeDockerLaunchInspection(rawContainerInspection())).toEqual({
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
        source: "/host/workspace",
        target: "/workspace",
        readOnly: false,
      },
    ],
    environment: ["EMPTY=", `TOKEN=${secretSentinel}`],
    networkMode: "nas-session",
    networks: ["nas-session"],
    privileged: false,
    capAdd: [],
    capDrop: ["NET_RAW"],
    securityOpt: [],
    labels: { "nas.managed": "true" },
  });
});

const malformedCases: ReadonlyArray<{
  readonly name: string;
  readonly mutate: (root: Record<string, unknown>) => void;
  readonly path: string;
}> = [
  {
    name: "missing environment",
    mutate: (root) => {
      delete (root.Config as Record<string, unknown>).Env;
    },
    path: "Config.Env",
  },
  {
    name: "missing working directory",
    mutate: (root) => {
      delete (root.Config as Record<string, unknown>).WorkingDir;
    },
    path: "Config.WorkingDir",
  },
  {
    name: "non-boolean mount mode",
    mutate: (root) => {
      (root.Mounts as Array<Record<string, unknown>>)[0].RW = "true";
    },
    path: "Mounts[0].RW",
  },
  {
    name: "missing privilege flag",
    mutate: (root) => {
      delete (root.HostConfig as Record<string, unknown>).Privileged;
    },
    path: "HostConfig.Privileged",
  },
  {
    name: "non-string environment entry",
    mutate: (root) => {
      (root.Config as Record<string, unknown>).Env = [
        `TOKEN=${secretSentinel}`,
        7,
      ];
    },
    path: "Config.Env[1]",
  },
];

for (const malformed of malformedCases) {
  test(`decodeDockerLaunchInspection: rejects ${malformed.name} without values`, () => {
    const raw = structuredClone(rawContainerInspection()) as Array<
      Record<string, unknown>
    >;
    malformed.mutate(raw[0]);

    let message = "";
    try {
      decodeDockerLaunchInspection(raw);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(malformed.path);
    expect(message).not.toContain(secretSentinel);
  });
}

test("decodeDockerLaunchInspection: rejects empty and multi-object results", () => {
  expect(() => decodeDockerLaunchInspection([])).toThrow("exactly one object");
  expect(() =>
    decodeDockerLaunchInspection([
      ...(rawContainerInspection() as unknown[]),
      ...(rawContainerInspection() as unknown[]),
    ]),
  ).toThrow("exactly one object");
});

test("decodeDockerLaunchImage: extracts immutable id and image config", () => {
  expect(
    decodeDockerLaunchImage([
      {
        Id: "sha256:image-id",
        Config: { User: "", Entrypoint: ["/entrypoint.sh"] },
      },
    ]),
  ).toEqual({
    id: "sha256:image-id",
    user: "",
    entrypoint: ["/entrypoint.sh"],
  });

  expect(
    decodeDockerLaunchImage([
      {
        Id: "sha256:no-entrypoint",
        Config: { User: "1000:1000", Entrypoint: null },
      },
    ]),
  ).toEqual({
    id: "sha256:no-entrypoint",
    user: "1000:1000",
    entrypoint: null,
  });
});

test("decodeDockerLaunchImage: normalizes omitted Docker defaults", () => {
  expect(
    decodeDockerLaunchImage([{ Id: "sha256:image-id", Config: {} }]),
  ).toEqual({ id: "sha256:image-id", user: "", entrypoint: null });
});

test("DockerService Fake exposes launch container and image inspection", async () => {
  const calls: string[] = [];
  const launch: DockerLaunchInspection = {
    id: "container-id",
    imageId: "sha256:image-id",
    running: true,
    config: {
      image: "nas-sandbox:fixture",
      user: "",
      entrypoint: null,
      command: ["idle"],
      workingDir: "/workspace",
    },
    mounts: [],
    environment: [],
    networkMode: "nas-session",
    networks: ["nas-session"],
    privileged: false,
    capAdd: [],
    capDrop: [],
    securityOpt: [],
    labels: {},
  };
  const image: DockerLaunchImage = {
    id: "sha256:image-id",
    user: "",
    entrypoint: null,
  };
  const layer = makeDockerServiceFake({
    inspectLaunch: (id) => {
      calls.push(`container:${id}`);
      return Effect.succeed(launch);
    },
    inspectLaunchImage: (reference) => {
      calls.push(`image:${reference}`);
      return Effect.succeed(image);
    },
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const docker = yield* DockerService;
      return {
        launch: yield* docker.inspectLaunch("container-id"),
        image: yield* docker.inspectLaunchImage("nas-sandbox:fixture"),
      };
    }).pipe(Effect.provide(layer)),
  );

  expect(calls).toEqual([
    "container:container-id",
    "image:nas-sandbox:fixture",
  ]);
  expect(result).toEqual({ launch, image });
});

test("DockerService Fake launch inspection defaults are complete", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const docker = yield* DockerService;
      return {
        launch: yield* docker.inspectLaunch("requested-id"),
        image: yield* docker.inspectLaunchImage("requested-image"),
      };
    }).pipe(Effect.provide(makeDockerServiceFake())),
  );

  expect(result.launch.id).toBe("requested-id");
  expect(result.launch.privileged).toBe(false);
  expect(result.launch.mounts).toEqual([]);
  expect(result.image).toEqual({
    id: "",
    user: "",
    entrypoint: null,
  });
});
