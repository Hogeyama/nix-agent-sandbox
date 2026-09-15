import { expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { NAS_SESSION_ID_LABEL } from "../../docker/nas_resources.ts";
import type { DevcontainerRegistration } from "../../domain/devcontainer.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import type { DockerLaunchInspection } from "../../services/docker.ts";
import {
  ComposeSessionOps,
  type ComposeSessionRequest,
  ComposeStopRequested,
  completeComposeSession,
  serveComposeSession,
  validateComposeSessionRequest,
} from "./compose_session_service.ts";

const registration: DevcontainerRegistration = {
  version: 1,
  workspaceId: "a".repeat(64),
  workspace: "/work",
  profileName: "claude",
  fingerprint: "fingerprint",
  configPath: "/work/.devcontainer/devcontainer.json",
  composePath: "/state/compose.json",
  stateRoot: "/state/workspace",
  command: ["nas"],
};

const container: ContainerPlan = {
  image: "nas-sandbox",
  workDir: "/work",
  mounts: [
    { source: "/work", target: "/work" },
    {
      source: "/work/.devcontainer",
      target: "/work/.devcontainer",
      readOnly: true,
    },
    { source: "/work/.nas", target: "/work/.nas", readOnly: true },
    { source: "/state/workspace/claude", target: "/home/tester/.claude" },
    {
      source: "/state/workspace/claude.json",
      target: "/home/tester/.claude.json",
    },
    {
      source: "/state/workspace/vscode",
      target: "/home/tester/.vscode-server",
    },
  ],
  env: { static: { NAS_UID: "1000", NAS_USER: "tester" }, dynamicOps: [] },
  network: { mode: "network", name: "nas-net" },
  extraHosts: [],
  extraRunArgs: [],
  command: { agentCommand: ["claude"], extraArgs: ["$literal"] },
  labels: {
    [NAS_SESSION_ID_LABEL]: "sess-1",
    "devcontainer.local_folder": "/work",
    "devcontainer.config_file": registration.configPath,
  },
};

const request: ComposeSessionRequest = {
  registration,
  sessionId: "sess-1",
  containerName: "nas-agent-sess-1",
  container,
};

test("request validation pins protection overlays and dedicated mounts", () => {
  expect(() => validateComposeSessionRequest(request)).not.toThrow();
  const withoutOverlay = {
    ...request,
    container: {
      ...container,
      mounts: container.mounts.filter(
        (mount) => mount.target !== "/work/.devcontainer",
      ),
    },
  };
  expect(() => validateComposeSessionRequest(withoutOverlay)).toThrow(
    "read-only configuration overlay is missing",
  );
  const withControlSocket = {
    ...request,
    container: {
      ...container,
      mounts: [
        ...container.mounts,
        { source: "/run/nas/hostexec/brokers/sess-1/sock", target: "/control" },
      ],
    },
  };
  expect(() => validateComposeSessionRequest(withControlSocket)).toThrow(
    "host-only control path",
  );
});

function inspection(id = "container-1"): DockerLaunchInspection {
  return {
    id,
    imageId: "image-1",
    running: true,
    config: {
      image: container.image,
      user: "",
      entrypoint: ["/entrypoint.sh"],
      command: ["/usr/local/bin/nas-devcontainer-idle", "$literal"],
      workingDir: container.workDir,
    },
    mounts: container.mounts.map((mount) => ({
      type: "bind",
      source: mount.source,
      target: mount.target,
      readOnly: mount.readOnly ?? false,
    })),
    environment: Object.entries(container.env.static).map(
      ([k, v]) => `${k}=${v}`,
    ),
    networkMode: "nas-net",
    networks: ["nas-net"],
    privileged: false,
    capAdd: [],
    capDrop: [],
    securityOpt: [],
    labels: container.labels,
  };
}

interface FakeOptions {
  readonly failAt?:
    | "validate"
    | "start"
    | "inspect"
    | "readiness"
    | "broker"
    | "stop"
    | "remove";
  readonly monitor?: "return" | "never" | "broker-failure";
  readonly cleanupInspection?: DockerLaunchInspection;
  readonly deadlineAt?: number;
  readonly markerNever?: boolean;
  readonly startNever?: boolean;
}

function fake(options: FakeOptions = {}) {
  const events: string[] = [];
  const userProbes: Array<{
    id: string;
    uid: number;
    home: string;
    workspace: string;
  }> = [];
  const phases: Array<{
    phase: string;
    diagnostic: string | null;
    containerId: string | null;
  }> = [];
  let inspections = 0;
  let networkProbes = 0;
  const step = (name: string, failAt?: FakeOptions["failAt"]) => {
    events.push(name);
    return failAt !== undefined && options.failAt === failAt
      ? Effect.fail(new Error(`${name} failure`))
      : Effect.void;
  };
  const layer = Layer.succeed(
    ComposeSessionOps,
    ComposeSessionOps.of({
      validate: () => step("validate", "validate"),
      publishCompose: () => step("publish-compose"),
      publishPhase: (_request, phase, containerId, diagnostic) =>
        Effect.sync(() => {
          phases.push({ phase, diagnostic, containerId });
          if (phase === "ready") events.push("ready");
        }),
      finalizeStopped: () =>
        Effect.sync(() => {
          const current = phases.at(-1);
          if (current?.phase === "stopping" && current.containerId === null)
            events.push("stopped");
        }),
      composeUp: () =>
        options.startNever
          ? Effect.sync(() => events.push("start")).pipe(
              Effect.andThen(Effect.never),
            )
          : step("start", "start"),
      composeContainerId: () => Effect.succeed("container-1"),
      inspectImage: () =>
        Effect.succeed({
          id: "image-1",
          user: "",
          entrypoint: ["/entrypoint.sh"],
        }),
      probeReadyMarker: () =>
        options.markerNever ? Effect.never : Effect.void,
      inspect: () => {
        inspections++;
        if (inspections === 1) {
          events.push("inspect");
          if (options.failAt === "inspect")
            return Effect.fail(new Error("inspect failure"));
        }
        return Effect.succeed(options.cleanupInspection ?? inspection());
      },
      probeUser: (id, uid, home, workspace) =>
        Effect.sync(() => {
          userProbes.push({ id, uid, home, workspace });
        }).pipe(Effect.andThen(step("probe-user", "readiness"))),
      probeNetworkBroker: () => {
        networkProbes++;
        if (options.failAt === "broker")
          return Effect.fail(new Error("broker failure"));
        if (options.monitor === "broker-failure" && networkProbes > 1)
          return Effect.fail(new Error("broker monitor failure"));
        return Effect.void;
      },
      probeHostExecBroker: () => Effect.void,
      probeContainerGateways: () => Effect.void,
      waitForMonitorTick: () => {
        if (options.monitor === "never") return Effect.never;
        if (options.monitor === "broker-failure") return Effect.void;
        return step("stop-request").pipe(
          Effect.andThen(Effect.fail(new ComposeStopRequested())),
        );
      },
      stop: () => step("stop-container", "stop"),
      remove: () => step("remove-container", "remove"),
    }),
  );
  return { events, phases, userProbes, layer };
}

async function run(options: FakeOptions = {}) {
  const f = fake(options);
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => completeComposeSession(request));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => f.events.push("release-brokers")),
        );
        yield* serveComposeSession(
          request,
          options.deadlineAt ?? Date.now() + 5_000,
        );
      }),
    ).pipe(Effect.provide(f.layer)),
  );
  return { ...f, exit };
}

test("serve keeps the scope alive and tears the owned generation down before brokers", async () => {
  const result = await run();
  expect(Exit.isSuccess(result.exit)).toBe(true);
  expect(result.events).toEqual([
    "validate",
    "publish-compose",
    "start",
    "inspect",
    "probe-user",
    "ready",
    "stop-request",
    "stop-container",
    "remove-container",
    "release-brokers",
    "stopped",
  ]);
  expect(result.phases.at(-1)).toEqual({
    phase: "stopping",
    diagnostic: null,
    containerId: null,
  });
  expect(result.userProbes).toEqual([
    {
      id: "container-1",
      uid: 1000,
      home: "/home/tester",
      workspace: "/work",
    },
  ]);
});

for (const failAt of [
  "validate",
  "start",
  "inspect",
  "readiness",
  "broker",
] as const) {
  test(`serve records ${failAt} startup failure and still releases earlier resources`, async () => {
    const result = await run({ failAt });
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.events).toContain("release-brokers");
    expect(result.phases.some((phase) => phase.phase === "failed")).toBe(true);
  });
}

test("startup deadline bounds readiness but excludes the ready lifetime", async () => {
  const result = await run({ deadlineAt: Date.now() + 20, markerNever: true });
  expect(Exit.isFailure(result.exit)).toBe(true);
  expect(result.phases.at(-1)?.phase).toBe("failed");
  expect(result.phases.at(-1)?.diagnostic).toContain(
    "startup deadline exceeded",
  );
});

test("startup timeout discovers and cleans a container created by Compose", async () => {
  const result = await run({ deadlineAt: Date.now() + 20, startNever: true });
  expect(Exit.isFailure(result.exit)).toBe(true);
  expect(result.events).toContain("stop-container");
  expect(result.events).toContain("remove-container");
  expect(result.events).not.toContain("stopped");
});

test("broker failure after ready tears down the container", async () => {
  const result = await run({ monitor: "broker-failure" });
  expect(
    result.phases.find((phase) => phase.phase === "failed")?.diagnostic,
  ).toContain("broker monitor failure");
  expect(result.events).toContain("remove-container");
});

test("cleanup failure is retained with the original monitor failure", async () => {
  const result = await run({ monitor: "broker-failure", failAt: "stop" });
  const diagnostic = result.phases.at(-1)?.diagnostic;
  expect(diagnostic).toContain("broker monitor failure");
  expect(diagnostic).toContain("stop failed");
  expect(result.events).not.toContain("stopped");
});

test("replacement identity is never stopped or removed", async () => {
  const result = await run({ cleanupInspection: inspection("replacement") });
  expect(result.events).not.toContain("stop-container");
  expect(result.events).not.toContain("remove-container");
  expect(result.phases.at(-1)?.diagnostic).toContain("identity changed");
});

for (const failAt of ["stop", "remove"] as const) {
  test(`${failAt} failure is retained while broker finalizers continue`, async () => {
    const result = await run({ failAt });
    expect(result.events).toContain("release-brokers");
    expect(result.phases.at(-1)?.phase).toBe("failed");
    expect(result.phases.at(-1)?.diagnostic).toContain(`${failAt} failed`);
  });
}

test("AbortSignal interruption awaits scoped cleanup", async () => {
  const f = fake({ monitor: "never" });
  const controller = new AbortController();
  const promise = Effect.runPromiseExit(
    Effect.scoped(serveComposeSession(request, Date.now() + 5_000)).pipe(
      Effect.provide(f.layer),
    ),
    { signal: controller.signal },
  );
  while (!f.events.includes("ready")) await Bun.sleep(1);
  controller.abort();
  const exit = await promise;
  expect(Exit.isFailure(exit)).toBe(true);
  expect(f.events).toContain("remove-container");
});
