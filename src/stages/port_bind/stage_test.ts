import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Exit, Layer } from "effect";
import type { Config, Profile } from "../../config/types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
