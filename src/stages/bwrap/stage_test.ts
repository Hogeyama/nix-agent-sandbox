import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { Profile } from "../../config/types.ts";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import { makeBwrapServiceFake } from "./bwrap_service.ts";
import { bwrapSeccompProfile } from "./seccomp_profile.ts";
import { createBwrapStage, planBwrap } from "./stage.ts";

function makeInput(
  support: boolean,
): StageInput & { container: ContainerPlan } {
  return {
    config: {} as StageInput["config"],
    profile: { agent: "claude", bwrap: { support } } as Profile,
    profileName: "test",
    sessionId: "sess-1",
    host: {
      home: "/home/user",
      user: "user",
      uid: 1000,
      gid: 1000,
      isWSL: false,
      env: new Map([["XDG_RUNTIME_DIR", "/run/user/1000"]]),
    },
    probes: {} as StageInput["probes"],
    container: emptyContainerPlan("img", "/work/repo"),
  };
}

test("planBwrap returns null when support is off", () => {
  expect(planBwrap(makeInput(false))).toBeNull();
});

test("planBwrap places the profile in the session's runtime directory", () => {
  expect(planBwrap(makeInput(true))).toEqual({
    sessionDir: "/run/user/1000/nas/bwrap/sess-1",
    seccompProfile: bwrapSeccompProfile(),
  });
});

test("with support off, the container keeps Docker's default profile", async () => {
  const fake = makeBwrapServiceFake();
  const input = makeInput(false);
  const result = await Effect.runPromise(
    Effect.scoped(
      createBwrapStage(input).run(input).pipe(Effect.provide(fake.layer)),
    ),
  );
  expect(fake.writes).toEqual([]);
  expect(result.container?.seccompProfile).toBeUndefined();
});

test("with support on, the container runs under the written profile, removed with the scope", async () => {
  let closed = false;
  const fake = makeBwrapServiceFake({
    write: () =>
      Effect.succeed({
        seccompProfilePath: "/run/user/1000/nas/bwrap/sess-1/seccomp.json",
        close: () =>
          Effect.sync(() => {
            closed = true;
          }),
      }),
  });
  const input = makeInput(true);
  const result = await Effect.runPromise(
    Effect.scoped(
      createBwrapStage(input).run(input).pipe(Effect.provide(fake.layer)),
    ),
  );
  expect(fake.writes).toHaveLength(1);
  expect(result.container?.seccompProfile).toBe(
    "/run/user/1000/nas/bwrap/sess-1/seccomp.json",
  );
  expect(closed).toBe(true);
});
