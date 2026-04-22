/**
 * ContainerLifecycleService unit tests.
 *
 * Docker primitive は mock 不能なため Live test なし。fake DockerService +
 * fake SessionLaunchService + fake ContainerQueryService を `Layer.mergeAll`
 * で provide する fake-only 戦略 (selection B) を取る。
 *
 * D2 として網羅するシーケンス:
 *   - stopContainer: inspect 成功 / 失敗握りつぶし / label なし の 3 分岐
 *   - cleanContainers: cleanNasContainers + collectRunningParentIds +
 *     removeOrphanShellSockets の wire 検証 (docker daemon 不要)
 *   - startShellSession: managed + running + label の happy + 3 つの error 分岐
 *
 * (α) typed error throw-through pin: plain-async client 経由で
 * `instanceof XxxError` の identity 保持を assert する。
 */

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  type DockerContainerDetails,
  DockerServiceLive,
  makeDockerServiceFake,
} from "../../services/docker.ts";
import {
  makeSessionLaunchServiceFake,
  SessionLaunchServiceLive,
} from "../launch.ts";
import { SessionUiServiceLive } from "../session.ts";
import {
  ContainerLifecycleService,
  ContainerLifecycleServiceLive,
  makeContainerLifecycleClient,
  makeContainerLifecycleServiceFake,
} from "./lifecycle_service.ts";
import {
  ContainerQueryServiceLive,
  makeContainerQueryServiceFake,
} from "./service.ts";
import {
  ContainerNotRunningError,
  NotNasManagedContainerError,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDetails(
  overrides: Partial<DockerContainerDetails> & { name: string },
): DockerContainerDetails {
  return {
    name: overrides.name,
    running: overrides.running ?? false,
    labels: overrides.labels ?? {},
    networks: overrides.networks ?? [],
    startedAt: overrides.startedAt ?? "1970-01-01T00:00:00.000Z",
  };
}

function nasAgentLabels(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "nas.managed": "true",
    "nas.kind": "agent",
    ...extra,
  };
}

const RUNTIME_DIR = "/tmp/nas-test-lifecycle";

// ---------------------------------------------------------------------------
// stopContainer
// ---------------------------------------------------------------------------

describe("ContainerLifecycleServiceLive: stopContainer", () => {
  test("happy: inspect 成功 + label あり → stop → removeShellSocketsForParent", async () => {
    const calls: string[] = [];
    const dockerFake = makeDockerServiceFake({
      inspect: (name) =>
        Effect.sync(() => {
          calls.push(`inspect:${name}`);
          return makeDetails({
            name,
            running: true,
            labels: nasAgentLabels({ "nas.session_id": "sess-1" }),
          });
        }),
      stop: (name) =>
        Effect.sync(() => {
          calls.push(`stop:${name}`);
        }),
    });
    const launchFake = makeSessionLaunchServiceFake({
      removeShellSocketsForParent: (runtimeDir, parentSessionId) =>
        Effect.sync(() => {
          calls.push(
            `removeShellSocketsForParent:${runtimeDir}:${parentSessionId}`,
          );
          return 0;
        }),
    });
    const queryFake = makeContainerQueryServiceFake();

    const layer = ContainerLifecycleServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, launchFake, queryFake)),
    );

    await Effect.runPromise(
      Effect.flatMap(ContainerLifecycleService, (svc) =>
        svc.stopContainer(RUNTIME_DIR, "nas-1"),
      ).pipe(Effect.provide(layer)),
    );

    // 順序: inspect -> stop -> removeShellSocketsForParent
    expect(calls).toEqual([
      "inspect:nas-1",
      "stop:nas-1",
      `removeShellSocketsForParent:${RUNTIME_DIR}:sess-1`,
    ]);
  });

  test("inspect 失敗握りつぶし: stop は呼ばれ、removeShellSocketsForParent は呼ばれない", async () => {
    const calls: string[] = [];
    const dockerFake = makeDockerServiceFake({
      inspect: (_name) => Effect.fail(new Error("disappeared")),
      stop: (name) =>
        Effect.sync(() => {
          calls.push(`stop:${name}`);
        }),
    });
    const launchFake = makeSessionLaunchServiceFake({
      removeShellSocketsForParent: (runtimeDir, parentSessionId) =>
        Effect.sync(() => {
          calls.push(
            `removeShellSocketsForParent:${runtimeDir}:${parentSessionId}`,
          );
          return 0;
        }),
    });
    const queryFake = makeContainerQueryServiceFake();

    const layer = ContainerLifecycleServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, launchFake, queryFake)),
    );

    await Effect.runPromise(
      Effect.flatMap(ContainerLifecycleService, (svc) =>
        svc.stopContainer(RUNTIME_DIR, "nas-x"),
      ).pipe(Effect.provide(layer)),
    );

    expect(calls).toEqual(["stop:nas-x"]);
  });

  test("parentSessionId なし (label 欠落): stop のみで removeShellSocketsForParent は呼ばれない", async () => {
    const calls: string[] = [];
    const dockerFake = makeDockerServiceFake({
      inspect: (name) =>
        Effect.succeed(
          makeDetails({
            name,
            running: true,
            // nas.session_id label は欠落 (legacy sidecar 等を想定)
            labels: nasAgentLabels(),
          }),
        ),
      stop: (name) =>
        Effect.sync(() => {
          calls.push(`stop:${name}`);
        }),
    });
    const launchFake = makeSessionLaunchServiceFake({
      removeShellSocketsForParent: (runtimeDir, parentSessionId) =>
        Effect.sync(() => {
          calls.push(
            `removeShellSocketsForParent:${runtimeDir}:${parentSessionId}`,
          );
          return 0;
        }),
    });
    const queryFake = makeContainerQueryServiceFake();

    const layer = ContainerLifecycleServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, launchFake, queryFake)),
    );

    await Effect.runPromise(
      Effect.flatMap(ContainerLifecycleService, (svc) =>
        svc.stopContainer(RUNTIME_DIR, "nas-orphan"),
      ).pipe(Effect.provide(layer)),
    );

    expect(calls).toEqual(["stop:nas-orphan"]);
  });
});

// ---------------------------------------------------------------------------
// cleanContainers — wire 検証 (cleanNasContainers + collectRunningParentIds +
// removeOrphanShellSockets を fake DockerService 経由で全貫通)
// ---------------------------------------------------------------------------

describe("ContainerLifecycleServiceLive: cleanContainers", () => {
  test("fake DockerService のみで cleanNasContainers 全経路通過 + removeOrphanShellSockets が呼ばれる", async () => {
    const calls: string[] = [];
    // managed sidecar が 1 つ (running, ネットワーク参照なし → 削除対象)
    const dockerFake = makeDockerServiceFake({
      listContainerNames: () =>
        Effect.sync(() => {
          calls.push("listContainerNames");
          return ["nas-dind-shared"];
        }),
      inspect: (name) =>
        Effect.sync(() => {
          calls.push(`inspect:${name}`);
          return makeDetails({
            name,
            running: false, // !running → isUnusedNasSidecar=true → remove
            labels: {
              "nas.managed": "true",
              "nas.kind": "dind",
            },
          });
        }),
      listNetworkNames: () =>
        Effect.sync(() => {
          calls.push("listNetworkNames");
          return [];
        }),
      listVolumeNames: () =>
        Effect.sync(() => {
          calls.push("listVolumeNames");
          return [];
        }),
      stop: (name) =>
        Effect.sync(() => {
          calls.push(`stop:${name}`);
        }),
      rm: (name) =>
        Effect.sync(() => {
          calls.push(`rm:${name}`);
        }),
    });

    const launchFake = makeSessionLaunchServiceFake({
      removeOrphanShellSockets: (runtimeDir, runningParentIds) =>
        Effect.sync(() => {
          calls.push(
            `removeOrphanShellSockets:${runtimeDir}:size=${runningParentIds.size}`,
          );
          return 0;
        }),
    });

    const queryFake = makeContainerQueryServiceFake({
      collectRunningParentIds: () =>
        Effect.sync(() => {
          calls.push("collectRunningParentIds");
          return new Set<string>() as ReadonlySet<string>;
        }),
    });

    const layer = ContainerLifecycleServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, launchFake, queryFake)),
    );

    const result = await Effect.runPromise(
      Effect.flatMap(ContainerLifecycleService, (svc) =>
        svc.cleanContainers(RUNTIME_DIR),
      ).pipe(Effect.provide(layer)),
    );

    // ContainerCleanResult: stopped sidecar が removedContainers に入っている
    expect(result.removedContainers).toEqual(["nas-dind-shared"]);
    expect(result.removedNetworks).toEqual([]);
    expect(result.removedVolumes).toEqual([]);

    // Docker daemon に触らず fake のみで全経路通過していること:
    // - cleanNasContainers が listContainerNames / inspect / listNetworkNames /
    //   listVolumeNames / rm を呼ぶ
    // - その後 collectRunningParentIds → removeOrphanShellSockets が呼ばれる
    expect(calls).toContain("listContainerNames");
    expect(calls).toContain("inspect:nas-dind-shared");
    expect(calls).toContain("rm:nas-dind-shared");
    // !running なので stop は呼ばれない (isUnusedNasSidecar の早期 true)
    expect(calls).not.toContain("stop:nas-dind-shared");
    // network / volume の loop も走る (空集合だが list だけ呼ばれる回数あり)
    expect(
      calls.filter((c) => c === "listNetworkNames").length,
    ).toBeGreaterThan(0);
    expect(calls.filter((c) => c === "listVolumeNames").length).toBeGreaterThan(
      0,
    );
    // 最後に query → orphan 掃除が呼ばれる
    const lastTwo = calls.slice(-2);
    expect(lastTwo).toEqual([
      "collectRunningParentIds",
      `removeOrphanShellSockets:${RUNTIME_DIR}:size=0`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// startShellSession
// ---------------------------------------------------------------------------

describe("ContainerLifecycleServiceLive: startShellSession", () => {
  test("happy: managed + running + label → launch.startShellSession 呼出", async () => {
    const calls: string[] = [];
    const dockerFake = makeDockerServiceFake({
      inspect: (name) =>
        Effect.succeed(
          makeDetails({
            name,
            running: true,
            labels: nasAgentLabels({ "nas.session_id": "parent-1" }),
          }),
        ),
    });
    const launchFake = makeSessionLaunchServiceFake({
      startShellSession: (runtimeDir, target) =>
        Effect.sync(() => {
          calls.push(
            `startShellSession:${runtimeDir}:${target.containerName}:${target.parentSessionId}`,
          );
          return { dtachSessionId: "shell-parent-1.7" };
        }),
    });
    const queryFake = makeContainerQueryServiceFake();

    const layer = ContainerLifecycleServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, launchFake, queryFake)),
    );

    const result = await Effect.runPromise(
      Effect.flatMap(ContainerLifecycleService, (svc) =>
        svc.startShellSession(RUNTIME_DIR, "nas-managed"),
      ).pipe(Effect.provide(layer)),
    );

    expect(result.dtachSessionId).toBe("shell-parent-1.7");
    expect(calls).toEqual([
      `startShellSession:${RUNTIME_DIR}:nas-managed:parent-1`,
    ]);
  });

  test("not managed: NotNasManagedContainerError (instanceof identity 保持)", async () => {
    const dockerFake = makeDockerServiceFake({
      inspect: (name) =>
        Effect.succeed(
          makeDetails({
            name,
            running: true,
            labels: { "some.other.label": "x" },
          }),
        ),
    });
    const launchFake = makeSessionLaunchServiceFake();
    const queryFake = makeContainerQueryServiceFake();

    const layer = ContainerLifecycleServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, launchFake, queryFake)),
    );

    const either = await Effect.runPromise(
      Effect.either(
        Effect.flatMap(ContainerLifecycleService, (svc) =>
          svc.startShellSession(RUNTIME_DIR, "not-nas"),
        ),
      ).pipe(Effect.provide(layer)),
    );

    expect(either._tag).toBe("Left");
    if (either._tag !== "Left") return;
    expect(either.left).toBeInstanceOf(NotNasManagedContainerError);
    expect(either.left.message).toContain("not-nas");
  });

  test("not running: ContainerNotRunningError (instanceof identity 保持)", async () => {
    const dockerFake = makeDockerServiceFake({
      inspect: (name) =>
        Effect.succeed(
          makeDetails({
            name,
            running: false,
            labels: nasAgentLabels({ "nas.session_id": "p" }),
          }),
        ),
    });
    const launchFake = makeSessionLaunchServiceFake();
    const queryFake = makeContainerQueryServiceFake();

    const layer = ContainerLifecycleServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, launchFake, queryFake)),
    );

    const either = await Effect.runPromise(
      Effect.either(
        Effect.flatMap(ContainerLifecycleService, (svc) =>
          svc.startShellSession(RUNTIME_DIR, "nas-stopped"),
        ),
      ).pipe(Effect.provide(layer)),
    );

    expect(either._tag).toBe("Left");
    if (either._tag !== "Left") return;
    expect(either.left).toBeInstanceOf(ContainerNotRunningError);
    expect(either.left.message).toContain("nas-stopped");
  });

  test("label 欠落: generic Error (message に NAS_SESSION_ID_LABEL を含む)", async () => {
    const dockerFake = makeDockerServiceFake({
      inspect: (name) =>
        Effect.succeed(
          makeDetails({
            name,
            running: true,
            labels: nasAgentLabels(), // nas.session_id が欠落
          }),
        ),
    });
    const launchFake = makeSessionLaunchServiceFake();
    const queryFake = makeContainerQueryServiceFake();

    const layer = ContainerLifecycleServiceLive.pipe(
      Layer.provide(Layer.mergeAll(dockerFake, launchFake, queryFake)),
    );

    const either = await Effect.runPromise(
      Effect.either(
        Effect.flatMap(ContainerLifecycleService, (svc) =>
          svc.startShellSession(RUNTIME_DIR, "nas-no-label"),
        ),
      ).pipe(Effect.provide(layer)),
    );

    expect(either._tag).toBe("Left");
    if (either._tag !== "Left") return;
    expect(either.left).toBeInstanceOf(Error);
    // 純粋な Error クラスであり、typed error ではない
    expect(either.left).not.toBeInstanceOf(ContainerNotRunningError);
    expect(either.left).not.toBeInstanceOf(NotNasManagedContainerError);
    expect(either.left.message).toContain("nas.session_id");
    expect(either.left.message).toContain("nas-no-label");
  });
});

// ---------------------------------------------------------------------------
// (α) typed error throw-through pin (plain-async client adapter 経由)
// ---------------------------------------------------------------------------

describe("makeContainerLifecycleClient: typed error throw-through", () => {
  test("client.startShellSession の Effect.fail(new ContainerNotRunningError) が catch で instanceof + message 保持", async () => {
    // fake Layer (R=never) を直接渡して plain-async 経路をフル走行させる。
    const fakeLifecycle = makeContainerLifecycleServiceFake({
      startShellSession: (_runtimeDir, containerName) =>
        Effect.fail(new ContainerNotRunningError(containerName)),
    });
    const client = makeContainerLifecycleClient(fakeLifecycle);

    let caught: unknown;
    try {
      await client.startShellSession(RUNTIME_DIR, "nas-stopped");
    } catch (e) {
      caught = e;
    }

    // 2 段階 assert:
    //   1. instanceof ContainerNotRunningError === true
    //   2. message preservation
    expect(caught).toBeInstanceOf(ContainerNotRunningError);
    if (!(caught instanceof ContainerNotRunningError)) return;
    expect(caught.message).toBe("Container is not running: nas-stopped");
    // name property も保持されていること
    expect(caught.name).toBe("ContainerNotRunningError");
  });
});

// ---------------------------------------------------------------------------
// Type-level regression
// ---------------------------------------------------------------------------

// The live layer composed with default deps must close to R=never.
// 明示的に `never, never` で書いて R-leakage の regression を厳格に pin する。
const _defaultLayerClosesToNever = ContainerLifecycleServiceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      DockerServiceLive,
      SessionLaunchServiceLive,
      ContainerQueryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(DockerServiceLive, SessionUiServiceLive)),
      ),
    ),
  ),
) satisfies Layer.Layer<ContainerLifecycleService, never, never>;
void _defaultLayerClosesToNever;

// ---------------------------------------------------------------------------
// Fake factory + plain-async client (default + override)
// ---------------------------------------------------------------------------

describe("makeContainerLifecycleServiceFake", () => {
  test("default + override の plain-async client 経由動作", async () => {
    // default: cleanContainers が空の ContainerCleanResult を返す
    const defaultFake = makeContainerLifecycleServiceFake();
    const defaultClient = makeContainerLifecycleClient(defaultFake);
    const defaultResult = await defaultClient.cleanContainers(RUNTIME_DIR);
    expect(defaultResult).toEqual({
      removedContainers: [],
      removedNetworks: [],
      removedVolumes: [],
    });

    // default startShellSession は dtachSessionId を生成
    const defaultShell = await defaultClient.startShellSession(
      RUNTIME_DIR,
      "nas-x",
    );
    expect(defaultShell.dtachSessionId).toBe("shell-nas-x.1");

    // override:
    const calls: string[] = [];
    const overrideFake = makeContainerLifecycleServiceFake({
      stopContainer: (runtimeDir, name) =>
        Effect.sync(() => {
          calls.push(`stop:${runtimeDir}:${name}`);
        }),
      cleanContainers: (runtimeDir) =>
        Effect.sync(() => {
          calls.push(`clean:${runtimeDir}`);
          return {
            removedContainers: ["c1"],
            removedNetworks: ["n1"],
            removedVolumes: [],
          };
        }),
    });
    const client = makeContainerLifecycleClient(overrideFake);

    await client.stopContainer(RUNTIME_DIR, "nas-y");
    const r = await client.cleanContainers(RUNTIME_DIR);
    expect(calls).toEqual([
      `stop:${RUNTIME_DIR}:nas-y`,
      `clean:${RUNTIME_DIR}`,
    ]);
    expect(r.removedContainers).toEqual(["c1"]);
    expect(r.removedNetworks).toEqual(["n1"]);
  });
});
