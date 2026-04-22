/**
 * DockerService Fake unit tests.
 *
 * Docker primitives cannot be mocked at the CLI layer (no fake daemon), so
 * Live behavior is exercised only through integration tests. Here we cover
 * the Fake layer surface for the new methods and pin down the contract that
 * the Live signature is `Effect.Effect<T, Error>` (no `.orDie`) so that
 * domain services can observe failures via the error channel.
 */

import { expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import {
  type DockerContainerDetails,
  DockerService,
  makeDockerServiceFake,
} from "./docker.ts";

test("Fake inspect: default returns minimum DockerContainerDetails for the requested name", async () => {
  const layer = makeDockerServiceFake();
  const details = await Effect.runPromise(
    Effect.flatMap(DockerService, (svc) => svc.inspect("ghost")).pipe(
      Effect.provide(layer),
    ),
  );
  expect(details).toEqual({
    name: "ghost",
    running: false,
    labels: {},
    networks: [],
    startedAt: "",
  });
});

test("Fake listContainerNames: default returns []", async () => {
  const layer = makeDockerServiceFake();
  const names = await Effect.runPromise(
    Effect.flatMap(DockerService, (svc) => svc.listContainerNames()).pipe(
      Effect.provide(layer),
    ),
  );
  expect(names).toEqual([]);
});

test("Fake inspect: override is invoked with the container name", async () => {
  const calls: string[] = [];
  const stub: DockerContainerDetails = {
    name: "stub",
    running: true,
    labels: { "nas.managed": "true" },
    networks: ["bridge"],
    startedAt: "2024-01-01T00:00:00Z",
  };
  const layer = makeDockerServiceFake({
    inspect: (name) => {
      calls.push(name);
      return Effect.succeed({ ...stub, name });
    },
  });

  const details = await Effect.runPromise(
    Effect.flatMap(DockerService, (svc) => svc.inspect("nas-foo")).pipe(
      Effect.provide(layer),
    ),
  );

  expect(calls).toEqual(["nas-foo"]);
  expect(details.name).toEqual("nas-foo");
  expect(details.running).toEqual(true);
  expect(details.labels).toEqual({ "nas.managed": "true" });
});

test("Fake listContainerNames: override is invoked and returns configured names", async () => {
  let callCount = 0;
  const layer = makeDockerServiceFake({
    listContainerNames: () => {
      callCount += 1;
      return Effect.succeed(["nas-a", "nas-b"]);
    },
  });

  const names = await Effect.runPromise(
    Effect.flatMap(DockerService, (svc) => svc.listContainerNames()).pipe(
      Effect.provide(layer),
    ),
  );

  expect(callCount).toEqual(1);
  expect(names).toEqual(["nas-a", "nas-b"]);
});

test("Fake listNetworkNames: default [], override is invoked", async () => {
  // default
  const defaultLayer = makeDockerServiceFake();
  const defaultNames = await Effect.runPromise(
    Effect.flatMap(DockerService, (svc) => svc.listNetworkNames()).pipe(
      Effect.provide(defaultLayer),
    ),
  );
  expect(defaultNames).toEqual([]);

  // override
  let calls = 0;
  const layer = makeDockerServiceFake({
    listNetworkNames: () => {
      calls += 1;
      return Effect.succeed(["nas-net-a", "bridge"]);
    },
  });
  const names = await Effect.runPromise(
    Effect.flatMap(DockerService, (svc) => svc.listNetworkNames()).pipe(
      Effect.provide(layer),
    ),
  );
  expect(calls).toBe(1);
  expect(names).toEqual(["nas-net-a", "bridge"]);
});

test("Fake inspectNetwork: default returns minimum DockerNetworkDetails for the requested name", async () => {
  const layer = makeDockerServiceFake();
  const details = await Effect.runPromise(
    Effect.flatMap(DockerService, (svc) =>
      svc.inspectNetwork("nas-net-x"),
    ).pipe(Effect.provide(layer)),
  );
  expect(details).toEqual({
    name: "nas-net-x",
    labels: {},
    containers: [],
  });

  // override
  const calls: string[] = [];
  const overrideLayer = makeDockerServiceFake({
    inspectNetwork: (name) => {
      calls.push(name);
      return Effect.succeed({
        name,
        labels: { "nas.managed": "true" },
        containers: ["c1"],
      });
    },
  });
  const overridden = await Effect.runPromise(
    Effect.flatMap(DockerService, (svc) =>
      svc.inspectNetwork("nas-net-y"),
    ).pipe(Effect.provide(overrideLayer)),
  );
  expect(calls).toEqual(["nas-net-y"]);
  expect(overridden.name).toBe("nas-net-y");
  expect(overridden.containers).toEqual(["c1"]);
});

test("Fake listVolumeNames: default [], override is invoked", async () => {
  const defaultLayer = makeDockerServiceFake();
  const defaultNames = await Effect.runPromise(
    Effect.flatMap(DockerService, (svc) => svc.listVolumeNames()).pipe(
      Effect.provide(defaultLayer),
    ),
  );
  expect(defaultNames).toEqual([]);

  let calls = 0;
  const layer = makeDockerServiceFake({
    listVolumeNames: () => {
      calls += 1;
      return Effect.succeed(["nas-vol-a"]);
    },
  });
  const names = await Effect.runPromise(
    Effect.flatMap(DockerService, (svc) => svc.listVolumeNames()).pipe(
      Effect.provide(layer),
    ),
  );
  expect(calls).toBe(1);
  expect(names).toEqual(["nas-vol-a"]);
});

test("Fake inspectVolume: default returns minimum DockerVolumeDetails for the requested name", async () => {
  const layer = makeDockerServiceFake();
  const details = await Effect.runPromise(
    Effect.flatMap(DockerService, (svc) => svc.inspectVolume("nas-vol-x")).pipe(
      Effect.provide(layer),
    ),
  );
  expect(details).toEqual({
    name: "nas-vol-x",
    labels: {},
    containers: [],
  });

  const calls: string[] = [];
  const overrideLayer = makeDockerServiceFake({
    inspectVolume: (name) => {
      calls.push(name);
      return Effect.succeed({
        name,
        labels: { "nas.managed": "true", "nas.kind": "dind-tmp" },
        containers: [],
      });
    },
  });
  const overridden = await Effect.runPromise(
    Effect.flatMap(DockerService, (svc) => svc.inspectVolume("nas-vol-y")).pipe(
      Effect.provide(overrideLayer),
    ),
  );
  expect(calls).toEqual(["nas-vol-y"]);
  expect(overridden.labels["nas.kind"]).toBe("dind-tmp");
});

test(".orDie was retracted: Fake errors land in Fail, not Die", async () => {
  // Regression for Phase 3 Commit 1: previously Live wrapped every method
  // with `.pipe(Effect.orDie)`, which converted typed errors into defects
  // and prevented domain services / UI routes from observing them via the
  // error channel. The new contract is `Effect.Effect<T, Error>`, and any
  // stage that wants die semantics must apply `.orDie` itself.
  const layer = makeDockerServiceFake({
    isRunning: () => Effect.fail(new Error("boom")),
  });

  const exit = await Effect.runPromiseExit(
    Effect.flatMap(DockerService, (svc) => svc.isRunning("any")).pipe(
      Effect.provide(layer),
    ),
  );

  expect(Exit.isFailure(exit)).toEqual(true);
  if (!Exit.isFailure(exit)) return;
  expect(Cause.isFailType(exit.cause)).toEqual(true);
  expect(Cause.isDieType(exit.cause)).toEqual(false);
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toEqual("Some");
  if (failure._tag !== "Some") return;
  expect(failure.value.message).toEqual("boom");
});
