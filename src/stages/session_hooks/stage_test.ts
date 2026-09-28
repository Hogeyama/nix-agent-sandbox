import { expect, test } from "bun:test";
import { Effect } from "effect";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { StageInput } from "../../pipeline/types.ts";
import {
  makeSessionHooksServiceFake,
  type SessionHooksPlan,
} from "./hooks_service.ts";
import { createSessionHooksStage } from "./stage.ts";

function input(enable: boolean): StageInput {
  return {
    profile: {
      agent: "claude",
      extraAgents: ["copilot", "codex"],
      hook: { enable, notify: "off" },
    },
    sessionId: "sess_test",
    host: { uid: 1000, env: new Map([["XDG_RUNTIME_DIR", "/run/user/1000"]]) },
  } as unknown as StageInput;
}

test("hooks are provisioned for primary and extra agents even with notifications off and no masking", async () => {
  const plans: SessionHooksPlan[] = [];
  const container = emptyContainerPlan("image", "/work");
  const result = await Effect.runPromise(
    Effect.scoped(
      createSessionHooksStage(input(true))
        .run({ container })
        .pipe(
          Effect.provide(
            makeSessionHooksServiceFake((plan) =>
              Effect.sync(() => {
                plans.push(plan);
              }),
            ),
          ),
        ),
    ),
  );
  expect(plans).toEqual([
    {
      sessionDir: "/run/user/1000/nas/session-hooks/sess_test",
      agents: ["claude", "copilot", "codex"],
    },
  ]);
  expect(result.container?.mounts).toContainEqual({
    source: `${plans[0].sessionDir}/assets`,
    target: "/opt/nas/session-hooks",
    readOnly: true,
  });
  expect(result.container?.env.static.NAS_SESSION_HOOKS).toBe("1");
  expect(result.container?.command).toEqual(container.command);
});

test("hook.enable=false skips registration without needing a service", async () => {
  expect(
    await Effect.runPromise(
      Effect.scoped(
        createSessionHooksStage(input(false))
          .run({ container: emptyContainerPlan("image", "/work") })
          .pipe(
            Effect.provide(
              makeSessionHooksServiceFake(() => Effect.die("must not prepare")),
            ),
          ),
      ),
    ),
  ).toEqual({});
});
