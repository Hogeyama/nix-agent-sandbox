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
