import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Either, Layer } from "effect";
import type { PortBindBroker } from "../../network/port_bind_broker.ts";
import {
  gcPortsRuntime,
  relayScriptPath,
  resolvePortsRuntimePaths,
} from "../../network/port_bind_registry.ts";
import type { RelayGateway } from "../../network/port_bind_relay.ts";
import { makeDockerServiceFake } from "../../services/docker.ts";
import {
  makePortBindServiceFake,
  PortBindOps,
  PortBindService,
  PortBindServiceLive,
  registerPortBindStartup,
  startPortBind,
} from "./port_bind_service.ts";
import type { PortBindPlan } from "./stage.ts";

const plan: PortBindPlan = {
  sessionId: "session",
  containerName: "nas-agent-session",
  runtimeDir: "/ports",
  relaySocketSource: "/ports/brokers/session/relay.sock",
  relayScriptSource: "/ports/relay/session/port-relay.mjs",
  controlSocket: "/ports/brokers/session/sock",
  relayUser: "1000",
  reservedPorts: [18080],
  mounts: [],
  initialForwards: [
    {
      direction: "remote",
      hostPort: 5432,
      containerPort: 15432,
      owners: ["config"],
    },
  ],
};

function fixture(failAt?: string) {
  const calls: string[] = [];
  const failure = new Error(`failed at ${failAt}`);
  let gatewayOptions: Parameters<
    typeof import("../../network/port_bind_relay.ts").startRelayGateway
  >[0];
  let brokerOptions: Parameters<
    typeof import("../../network/port_bind_broker.ts").startPortBindBroker
  >[0];
  let connected = false;
  const gateway: RelayGateway = {
    socketPath: plan.relaySocketSource,
    isRelayConnected: () => connected,
    relayCapability: () => "v2",
    completeInitialForwards: () => {},
    openStream: async () => {
      throw new Error("unused");
    },
    probe: async () => "ok",
    watchListeners: async () => "ready",
    listeners: () => [],
    forward: async () => {},
    unforward: async () => ({ listenerClosed: true }),
    forwards: () => [],
    close: async () => {},
  };
  const broker = {
    listPortForwards: () => [
      { ...plan.initialForwards[0], createdAt: "now", state: "pending" },
    ],
    onForwardState: (port: number, state: string) =>
      calls.push(`state:${port}:${state}`),
    onRelayConnected: () => calls.push("connected"),
  } as unknown as PortBindBroker;
  const step = <A>(name: string, value: A) =>
    Effect.suspend(() => {
      calls.push(name);
      return name === failAt ? Effect.fail(failure) : Effect.succeed(value);
    });
  const ops = Layer.succeed(PortBindOps, {
    paths: () =>
      step("paths", {
        runtimeDir: "/ports",
        sessionsDir: "/ports/sessions",
        pendingDir: "/ports/pending",
        brokersDir: "/ports/brokers",
        relayDir: "/ports/relay",
      }),
    copyScript: () => step("copy", undefined),
    registerStartup: () => step("registerStartup", undefined),
    persist: () => step("persist", undefined),
    gateway: (options) => {
      gatewayOptions = options;
      return step("gateway", gateway);
    },
    broker: (options) => {
      brokerOptions = options;
      return step("broker", broker);
    },
    prepare: (_broker, entries) => {
      expect(entries).toEqual(plan.initialForwards);
      return step("prepare", undefined);
    },
    waitForControl: () => step("wait", false),
    execRelay: () => step("exec", { code: 0, stderr: "" }),
    closeBroker: () => step("closeBroker", undefined),
    closeGateway: () => step("closeGateway", undefined),
    removeRegistry: () => step("removeRegistry", undefined),
    removeRelay: () => step("removeRelay", undefined),
  });
  return {
    calls,
    failure,
    ops,
    connect: () => {
      connected = true;
      gatewayOptions.onRelayConnected?.();
    },
    callbacks: () => ({ gatewayOptions, brokerOptions }),
  };
}

test("start prepares initial state before returning and owns all cleanup", async () => {
  const f = fixture();
  const handle = await Effect.runPromise(
    startPortBind(plan).pipe(Effect.provide(f.ops)),
  );
  expect(f.calls).toEqual([
    "paths",
    "copy",
    "registerStartup",
    "gateway",
    "broker",
    "prepare",
  ]);
  await Effect.runPromise(handle.close());
  expect(f.calls.slice(-3)).toEqual([
    "closeBroker",
    "removeRegistry",
    "removeRelay",
  ]);
});

test("startup registration protects relay resources from concurrent GC", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-port-startup-"));
  try {
    const paths = await resolvePortsRuntimePaths(root);
    const script = relayScriptPath(paths, plan.sessionId);
    const relaySocket = path.join(
      paths.brokersDir,
      plan.sessionId,
      "relay.sock",
    );
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, "relay");
    await registerPortBindStartup(paths, { ...plan, runtimeDir: root });
    await mkdir(path.dirname(relaySocket), { recursive: true });
    await writeFile(relaySocket, "socket");

    const result = await gcPortsRuntime(paths);

    expect(result.removedSessions).toEqual([]);
    await access(script);
    await access(relaySocket);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [failurePoint, cleanup] of [
  ["copy", ["removeRegistry", "removeRelay"]],
  ["registerStartup", ["removeRegistry", "removeRelay"]],
  ["gateway", ["removeRegistry", "removeRelay"]],
  ["broker", ["closeGateway", "removeRegistry", "removeRelay"]],
  ["prepare", ["closeBroker", "removeRegistry", "removeRelay"]],
] as const) {
  test(`${failurePoint} failure retains Error and releases acquired resources`, async () => {
    const f = fixture(failurePoint);
    const result = await Effect.runPromise(
      startPortBind(plan).pipe(Effect.either, Effect.provide(f.ops)),
    );
    expect(Either.isLeft(result) && result.left).toBe(f.failure);
    expect(f.calls.slice(-cleanup.length)).toEqual([...cleanup]);
  });
}

test("gateway callbacks use broker state and local-only connection completion", async () => {
  const f = fixture();
  const handle = await Effect.runPromise(
    startPortBind(plan).pipe(Effect.provide(f.ops)),
  );
  try {
    f.connect();
    const { gatewayOptions } = f.callbacks();
    expect(gatewayOptions.currentForwards?.()).toMatchObject([
      { containerPort: 15432 },
    ]);
    gatewayOptions.onForwardState?.(15432, "active");
    expect(f.calls.slice(-2)).toEqual(["connected", "state:15432:active"]);
    expect(await gatewayOptions.ensureRelay()).toBe("ready");
    expect(f.calls).not.toContain("exec");
  } finally {
    await Effect.runPromise(handle.close());
  }
});

test("Fake service defaults close cleanly and preserves injected expected failures", async () => {
  const program = Effect.gen(function* () {
    return yield* (yield* PortBindService).start(plan);
  });
  const handle = await Effect.runPromise(
    program.pipe(Effect.provide(makePortBindServiceFake())),
  );
  await Effect.runPromise(handle.close());
  const failure = new Error("prepare failed");
  const result = await Effect.runPromise(
    program.pipe(
      Effect.either,
      Effect.provide(
        makePortBindServiceFake({ start: () => Effect.fail(failure) }),
      ),
    ),
  );
  expect(Either.isLeft(result) && result.left).toBe(failure);
});

const _liveDependenciesClose = PortBindServiceLive.pipe(
  Layer.provide(makeDockerServiceFake()),
) satisfies Layer.Layer<PortBindService, never, never>;

test("initial startup timeout does not fall through to docker exec", async () => {
  const f = fixture();
  const handle = await Effect.runPromise(
    startPortBind(plan).pipe(Effect.provide(f.ops)),
  );
  try {
    const { gatewayOptions, brokerOptions } = f.callbacks();
    expect(await gatewayOptions.ensureRelay()).toBe("unreachable");
    brokerOptions.onInitialComplete?.("startup failed");
    expect(await gatewayOptions.ensureRelay()).toBe("unreachable");
    expect(f.calls.filter((call) => call === "wait")).toHaveLength(2);
    expect(f.calls).not.toContain("exec");
  } finally {
    await Effect.runPromise(handle.close());
  }
});

test("broker cleanup failure still closes the gateway and removes session files", async () => {
  const f = fixture("closeBroker");
  const handle = await Effect.runPromise(
    startPortBind(plan).pipe(Effect.provide(f.ops)),
  );
  await Effect.runPromise(handle.close());
  expect(f.calls.slice(-4)).toEqual([
    "closeBroker",
    "closeGateway",
    "removeRegistry",
    "removeRelay",
  ]);
});

test("successful initial completion restores ordinary lazy relay recovery", async () => {
  const f = fixture();
  const handle = await Effect.runPromise(
    startPortBind(plan).pipe(Effect.provide(f.ops)),
  );
  try {
    const { gatewayOptions, brokerOptions } = f.callbacks();
    brokerOptions.onInitialComplete?.();
    expect(await gatewayOptions.ensureRelay()).toBe("unreachable");
    expect(f.calls.slice(-2)).toEqual(["exec", "wait"]);
  } finally {
    await Effect.runPromise(handle.close());
  }
});
