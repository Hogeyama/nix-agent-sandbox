import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Exit, Layer } from "effect";
import type { Config, Profile } from "../../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_GUIDE_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "../../config/types.ts";
import type { PortBindSessionEntry } from "../../network/port_bind_protocol.ts";
import { readSessionRegistry } from "../../network/port_bind_registry.ts";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { PipelineState } from "../../pipeline/state.ts";
import type { HostEnv, StageInput } from "../../pipeline/types.ts";
import { makeDockerServiceFake } from "../../services/docker.ts";
import { reservedNamespacePorts } from "../dind.ts";
import {
  makePortBindServiceFake,
  PortBindService,
  PortBindServiceLive,
} from "./port_bind_service.ts";
import {
  CONTAINER_RELAY_SCRIPT,
  CONTAINER_RELAY_SOCKET,
  createPortBindStage,
  type PortBindPlan,
  planPortBind,
} from "./stage.ts";

function makeProfile(): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
    secrets: {},
    guide: DEFAULT_GUIDE_CONFIG,
  };
}

function makeHostEnv(runtimeDir: string): HostEnv {
  return {
    home: "/home/testuser",
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([["XDG_RUNTIME_DIR", runtimeDir]]),
  };
}

function makeSharedInput(sessionId: string): StageInput {
  const profile = makeProfile();
  const config: Config = {
    profiles: { default: profile },
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
  };
  return {
    config,
    profile,
    profileName: "default",
    sessionId,
    host: makeHostEnv("/tmp/nas-test-runtime"),
    probes: {
      hasHostNix: false,
      xdgDbusProxyPath: null,
      dbusSessionAddress: null,
      gpgAgentSocket: null,
      auditDir: "/tmp/nas-test-audit",
      hostexecInterceptLibPath: null,
      hostexecClientPath: null,
      hostexecGatewayPath: null,
    },
  };
}

function makeStageState(): Pick<PipelineState, "container"> {
  return {
    container: emptyContainerPlan("nas-test", "/workspace"),
  };
}

function inputFor(sessionId: string) {
  return { ...makeSharedInput(sessionId), ...makeStageState() };
}

function planAt(runtimeRoot: string, sessionId = "s1"): PortBindPlan {
  const input = inputFor(sessionId);
  return planPortBind({
    ...input,
    host: {
      ...input.host,
      env: new Map([["XDG_RUNTIME_DIR", runtimeRoot]]),
    },
  });
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

function liveLayer() {
  return PortBindServiceLive.pipe(Layer.provide(makeDockerServiceFake()));
}

test("planPortBind keeps nas's own namespace ports out of the suggestions", () => {
  const input = inputFor("s1");
  expect(planPortBind(input).reservedPorts).toEqual(
    reservedNamespacePorts(undefined),
  );

  const forwarded = {
    ...input,
    container: {
      ...input.container,
      env: {
        ...input.container.env,
        static: {
          ...input.container.env.static,
          NAS_FORWARD_PORTS: "18080,9222",
        },
      },
    },
  };
  expect(planPortBind(forwarded).reservedPorts).toContain(9222);
});

test("planPortBind mounts the socket and the script read-only", () => {
  const plan = planPortBind(inputFor("s1"));
  const socketMount = plan.mounts.find(
    (mount) => mount.target === CONTAINER_RELAY_SOCKET,
  );
  const scriptMount = plan.mounts.find(
    (mount) => mount.target === CONTAINER_RELAY_SCRIPT,
  );

  expect(socketMount?.readOnly).toEqual(true);
  expect(scriptMount?.readOnly).toEqual(true);
  expect(socketMount?.source).toContain("/brokers/s1/relay.sock");
});

test("planPortBind mounts files, never their parent directory", () => {
  const plan = planPortBind(inputFor("s1"));

  for (const mount of plan.mounts) {
    expect(
      mount.source.endsWith(".sock") || mount.source.endsWith(".mjs"),
    ).toEqual(true);
  }
});

test("planPortBind puts the control socket outside anything mounted", () => {
  const plan = planPortBind(inputFor("s1"));

  for (const mount of plan.mounts) {
    expect(plan.controlSocket.startsWith(`${mount.source}/`)).toEqual(false);
    expect(plan.controlSocket).not.toEqual(mount.source);
  }
});

test("PortBindStage keeps the session service handle scoped", async () => {
  const input = inputFor("s1");
  const plans: PortBindPlan[] = [];
  let closed = false;
  const service = makePortBindServiceFake({
    start: (plan) =>
      Effect.sync(() => {
        plans.push(plan);
        return {
          close: () =>
            Effect.sync(() => {
              closed = true;
            }),
        };
      }),
  });

  const result = await Effect.runPromise(
    Effect.scoped(
      createPortBindStage(makeSharedInput("s1"))
        .run(input)
        .pipe(Effect.provide(service)),
    ),
  );

  expect(plans).toHaveLength(1);
  expect(result.container).toBeDefined();
  if (!result.container) throw new Error("container patch is missing");
  expect(result.container.mounts).toEqual([
    ...input.container.mounts,
    ...plans[0].mounts,
  ]);
  expect(closed).toEqual(true);
});

test("PortBindServiceLive owns the relay files and session registry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-port-bind-stage-"));
  const plan = planAt(root);
  try {
    const handle = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* PortBindService;
        return yield* service.start(plan);
      }).pipe(Effect.provide(liveLayer())),
    );

    const script = await readFile(plan.relayScriptSource, "utf8");
    const registry = await readSessionRegistry<PortBindSessionEntry>(
      {
        runtimeDir: plan.runtimeDir,
        sessionsDir: path.join(plan.runtimeDir, "sessions"),
        pendingDir: path.join(plan.runtimeDir, "pending"),
        brokersDir: path.join(plan.runtimeDir, "brokers"),
      },
      plan.sessionId,
    );
    expect(script).toContain("NAS_PORT_RELAY_SOCKET");
    expect(await exists(plan.relaySocketSource)).toEqual(true);
    expect(await exists(plan.controlSocket)).toEqual(true);
    expect(registry?.bindings).toEqual([]);

    await Effect.runPromise(handle.close());

    expect(await exists(plan.relaySocketSource)).toEqual(false);
    expect(await exists(plan.controlSocket)).toEqual(false);
    expect(
      await readSessionRegistry<PortBindSessionEntry>(
        {
          runtimeDir: plan.runtimeDir,
          sessionsDir: path.join(plan.runtimeDir, "sessions"),
          pendingDir: path.join(plan.runtimeDir, "pending"),
          brokersDir: path.join(plan.runtimeDir, "brokers"),
        },
        plan.sessionId,
      ),
    ).toEqual(null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PortBindServiceLive rolls back only an acquired gateway", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-port-bind-stage-"));
  const plan = planAt(root);
  try {
    await mkdir(plan.controlSocket, { recursive: true });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* PortBindService;
        return yield* service.start(plan);
      }).pipe(Effect.provide(liveLayer())),
    );

    expect(Exit.isFailure(exit)).toEqual(true);
    expect(await exists(plan.relaySocketSource)).toEqual(false);
    expect((await stat(plan.controlSocket)).isDirectory()).toEqual(true);
    expect(
      await readSessionRegistry<PortBindSessionEntry>(
        {
          runtimeDir: plan.runtimeDir,
          sessionsDir: path.join(plan.runtimeDir, "sessions"),
          pendingDir: path.join(plan.runtimeDir, "pending"),
          brokersDir: path.join(plan.runtimeDir, "brokers"),
        },
        plan.sessionId,
      ),
    ).toEqual(null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Docker pins a single-file bind mount to the inode it resolved when the
 * container was created, and `copyRelayScript` publishes the script with a
 * rename — a fresh inode every time. While every session shared one script
 * path, starting session B silently detached the script from every container
 * already running: their mount kept pointing at the now-unlinked inode, so
 * `bun /usr/local/lib/nas/port-relay.mjs` failed with "Module not found
 * (deleted)" and the relay could never be exec'd again. `docker exec -d`
 * reports only that the exec was created, so the supervisor saw exit 0 and
 * reported `relay-unreachable` with the real cause nowhere in sight.
 */
test("starting a session leaves other sessions' relay scripts untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-port-bind-stage-"));
  const first = planAt(root, "s1");
  const second = planAt(root, "s2");
  try {
    expect(first.relayScriptSource).not.toEqual(second.relayScriptSource);

    const firstHandle = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* PortBindService;
        return yield* service.start(first);
      }).pipe(Effect.provide(liveLayer())),
    );
    const before = await stat(first.relayScriptSource);

    const secondHandle = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* PortBindService;
        return yield* service.start(second);
      }).pipe(Effect.provide(liveLayer())),
    );
    const after = await stat(first.relayScriptSource);

    // Same inode, still linked: the mount in s1's container stays valid.
    expect(after.ino).toEqual(before.ino);
    expect(after.nlink).toBeGreaterThan(0);

    // Closing one session must not remove the other's script either.
    await Effect.runPromise(secondHandle.close());
    expect(await exists(second.relayScriptSource)).toEqual(false);
    expect((await stat(first.relayScriptSource)).ino).toEqual(before.ino);

    await Effect.runPromise(firstHandle.close());
    expect(await exists(first.relayScriptSource)).toEqual(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
